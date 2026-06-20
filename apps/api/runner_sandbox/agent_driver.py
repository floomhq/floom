"""Agent-mode worker driver backed by the OpenAI Agents SDK.

The agent runtime treats a worker folder as a skill bundle. It loads the
declared entrypoint (default: SKILL.md) as the system prompt, sends run inputs
as a JSON user message, and lets the model call local Workeros tools plus
OpenAI-hosted tools such as web search.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import threading
import time as _time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from contexts import (
    context_dir,
    context_scope_for_user,
    iter_context_files,
    normalize_context_mount,
    use_context_scope,
)
from models import (
    default_worker_agent_model,
    WorkerConfig,
    WorkerResult,
)
import llm as _llm
from runner_utils import ARTIFACTS_DIR
from worker_registry import WORKERS_DIR

from . import agent_capabilities
from .agent_capabilities import WORKER_POLICY, MCPConnectionError
from .base import SandboxDriver
from .cancellation import cancel_flag_db_read_errors_total, run_cancel_requested
from .e2b_upload import upload_tree_tarball
from .memory_context import memory_context_name, memory_enabled

logger = logging.getLogger("floom.runner_sandbox.agent")


_OPENAI_MAX_OUTPUT_CAP = 16_384
_BEDROCK_MAX_OUTPUT_CAP = 64_000


def _ws_setting(key: str) -> "Optional[str]":
    """#797: read a workspace setting (model/limit defaults) — lazy import to
    avoid a run_service <-> driver import cycle. None when unset."""
    try:
        from run_service import _workspace_setting
        return _workspace_setting(key)
    except Exception:
        return None


def _ws_default_model() -> "Optional[str]":
    v = (_ws_setting("default_model") or "").strip()
    return v or None


def _ws_fallback_model() -> "Optional[str]":
    v = (_ws_setting("fallback_model") or "").strip()
    return v or None


def _ws_default_int(key: str) -> "Optional[int]":
    raw = (_ws_setting(key) or "").strip()
    if not raw:
        return None
    try:
        n = int(float(raw))
        return n if n > 0 else None
    except ValueError:
        return None


def _resolve_timeout_seconds(requested: int, limits: "Any") -> int:
    """Resolve the effective run timeout for an agent-mode worker.

    Policy (#1127/#1314):
    - Start from ``limits.timeout_seconds`` (per-worker ceiling, default 300 s).
    - If the workspace has set ``default_timeout_seconds``, use THAT value as
      the timeout (it may be higher than the per-worker default, enabling up to
      1-hour runs without touching individual manifests).
    - Never exceed MAX_RUN_TIMEOUT_SECONDS (3600 s).

    Examples:
      worker limits=300, ws unset   → 300   (existing workers unchanged)
      worker limits=300, ws=3600    → 3600  (workspace opt-in to 1 h)
      worker limits=600, ws=300     → 300   (workspace is tighter → still wins)
    """
    from runtime_limits import MAX_RUN_TIMEOUT_SECONDS

    per_worker = limits.timeout_seconds if limits else requested
    _ws_timeout = _ws_default_int("default_timeout_seconds")
    if _ws_timeout:
        effective = _ws_timeout
    else:
        effective = per_worker
    return min(effective, MAX_RUN_TIMEOUT_SECONDS)


def _agent_effective_max_tokens(model: str, requested: int) -> Optional[int]:
    """Return provider-safe max_tokens for the Agents SDK.

    ``WorkerLimits.max_output_tokens`` uses 1M as the "effectively unlimited"
    sentinel. Providers reject that if forwarded literally. OpenAI is safest
    with ``None`` above the known cap; Bedrock Claude requires a concrete value
    below its service limit.
    """
    requested = max(1, int(requested))
    if "bedrock" in str(model or "").lower():
        return min(requested, _BEDROCK_MAX_OUTPUT_CAP)
    return requested if requested <= _OPENAI_MAX_OUTPUT_CAP else None


def _resolve_max_output_tokens(limits: "Any") -> int:
    per_worker = int(getattr(limits, "max_output_tokens", 1_000_000) or 1_000_000)
    if per_worker != 1_000_000:
        return per_worker
    return _ws_default_int("max_output_tokens") or per_worker



_CWD_LOCK = threading.Lock()
_STDOUT_CAP = 12000
_STDERR_CAP = 12000
_PATH_VALUE_RE = re.compile(r"^(?:\.?/)?(?:out|outputs|output|artifacts|inputs)/[A-Za-z0-9._/@ -]+$")


def _safe_path(base: Path, *parts: str) -> Path:
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        raise ValueError(f"Path traversal attempt: {target}")
    return target


def _worker_dir_for_run(worker_id: str, config: Optional[WorkerConfig]) -> Path:
    # Delegate to the canonical resolver so the var/workers vs engine/workers
    # bundle_path drift (#1048 follow-up) is handled identically everywhere.
    from runner_utils import _resolve_worker_bundle_dir

    return _resolve_worker_bundle_dir(WORKERS_DIR, worker_id, config, _safe_path)


def _safe_path_under_any(roots: list[Path], path: str, default_root: Path) -> Path:
    raw = Path(path)
    target = raw.resolve() if raw.is_absolute() else default_root.joinpath(raw).resolve()
    for root in roots:
        try:
            target.relative_to(root.resolve())
            return target
        except ValueError:
            continue
    raise ValueError(f"Path traversal attempt: {target}")


def _truncate(value: str, cap: int) -> str:
    if len(value) <= cap:
        return value
    return value[:cap] + f"\n<truncated {len(value) - cap} chars>"


def _scrub(value: str, secrets: Dict[str, str]) -> str:
    scrubbed = value or ""
    for name, secret in secrets.items():
        if secret and len(secret) > 3:
            scrubbed = scrubbed.replace(secret, f"<REDACTED:{name}>")
    return scrubbed


def _json_dumps(value: Any) -> str:
    return json.dumps(value, default=str)


def _looks_like_relative_path_value(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or "\n" in text or "://" in text or text.startswith("/"):
        return False
    if _PATH_VALUE_RE.fullmatch(text):
        return True
    return "/" in text and text.lower().endswith((".md", ".txt", ".json", ".csv", ".html", ".pdf", ".docx"))


@dataclass
class _AgentRunState:
    worker_id: str
    run_id: str
    inputs: Dict[str, Any]
    secrets: Dict[str, str]
    log_fn: Callable[[str, str], None]
    trace_id: str
    config: WorkerConfig
    bundle_dir: Path
    input_dir: Path
    output_dir: Path
    context_dir: Path
    outputs: Dict[str, Any]
    artifacts: list[Dict[str, Any]]
    timeout_seconds: int
    connection_ids: Dict[str, str]
    user_id: str | None = None
    finished: bool = False


# Backwards-compatible alias: the shared capability module now owns this error
# type. Existing `_MCPConnectionError` references (raises + excepts) keep working
# because it is the SAME class.
_MCPConnectionError = MCPConnectionError


class AgentDriver(SandboxDriver):
    """Runs an agent worker through the OpenAI Agents SDK."""

    def __init__(self, openai_client: Any = None):
        # Kept only for constructor compatibility with older tests/callers.
        # The SDK owns OpenAI client construction.
        self._client = openai_client

    def run(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int = 300,
        config: Optional[WorkerConfig] = None,
        connection_ids: Optional[Dict[str, str]] = None,
        user_id: str | None = None,
    ) -> WorkerResult:
        try:
            return self._run_coro_sync(
                self._run_agent_async(
                    worker_id=worker_id,
                    run_id=run_id,
                    inputs=inputs,
                    secrets=secrets,
                    log_fn=log_fn,
                    trace_id=trace_id,
                    timeout_seconds=timeout_seconds,
                    config=config,
                    connection_ids=connection_ids or {},
                    user_id=user_id,
                )
            )
        except Exception as exc:
            exc_str = str(exc)
            if "response.incomplete" in exc_str or "max_output_tokens" in exc_str.lower():
                log_fn(f"Output token limit reached: {exc}", "error")
                return WorkerResult(
                    status="error",
                    error=(
                        "The model's response exceeded the per-turn output token limit. "
                        "Increase max_output_tokens in the worker's limits or simplify the task."
                    ),
                    error_code="output_token_limit",
                    retryable=False,
                )
            logger.exception("Agent driver failed for worker %s run %s", worker_id, run_id)
            log_fn(f"Agent runtime error: {exc}", "error")
            return WorkerResult(
                status="error",
                error=str(exc),
                error_code="agent_runtime_error",
                retryable=True,
            )

    def _run_coro_sync(self, coro: Any) -> WorkerResult:
        # #605: delegate to the shared async_bridge utility so the
        # sync-from-async-context pattern is maintained in one place.
        from async_bridge import run_coro_sync
        return run_coro_sync(coro)  # type: ignore[return-value]

    async def _run_agent_async(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int,
        config: Optional[WorkerConfig],
        connection_ids: Dict[str, str],
        user_id: str | None,
    ) -> WorkerResult:
        if not config or not config.runtime:
            return WorkerResult(status="error", error="Worker config not found", error_code="invalid_worker")

        limits = config.runtime.limits
        # #1127/#1314: resolve the effective timeout.
        # Workspace default_timeout_seconds is an OPT-IN ceiling (up to 3600 s).
        # When the workspace sets a value > per-worker limits, the larger value
        # wins (allows 1-hour runs without touching individual worker manifests).
        # The absolute ceiling is MAX_RUN_TIMEOUT_SECONDS (3600).
        timeout_seconds = _resolve_timeout_seconds(limits.timeout_seconds, limits)
        try:
            return await asyncio.wait_for(
                self._run_agent_inner(
                    worker_id=worker_id,
                    run_id=run_id,
                    inputs=inputs,
                    secrets=secrets,
                    log_fn=log_fn,
                    trace_id=trace_id,
                    timeout_seconds=timeout_seconds,
                    config=config,
                    connection_ids=connection_ids,
                    user_id=user_id,
                ),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            # Clean up any pending agent-tool approval that was waiting when the
            # outer timeout fired. The inner polling loop never got a chance to
            # call repos.approvals.reject(), so do it here.
            if user_id:
                try:
                    from db import get_repositories as _get_repos
                    _repos_t = _get_repos()
                    _apr = _repos_t.approvals.get_by_run_id(run_id=run_id)
                    if _apr and _apr.get("status") == "pending":
                        _repos_t.approvals.reject(
                            owner_id=user_id,
                            run_id=run_id,
                            approval_id=str(_apr.get("id") or ""),
                            decided_at=datetime.now(timezone.utc).isoformat(),
                            reason=f"Run timed out after {timeout_seconds}s",
                        )
                except Exception:
                    pass
            return WorkerResult(
                status="error",
                error=f"Agent run exceeded timeout of {timeout_seconds}s",
                error_code="timeout",
            )

    async def _run_agent_inner(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int,
        config: WorkerConfig,
        connection_ids: Dict[str, str],
        user_id: str | None,
    ) -> WorkerResult:
        from agents import Agent, ModelSettings, RunConfig

        limits = config.runtime.limits
        bundle_dir = _worker_dir_for_run(worker_id, config)
        if not bundle_dir.is_dir():
            try:
                from services.worker_materialization import rematerialize_worker_from_db

                if rematerialize_worker_from_db(worker_id, target_dir=bundle_dir):
                    log_fn("[agent] Re-materialized worker files from DB", "info")
            except Exception as exc:
                logger.warning(
                    "Worker re-materialization failed for %s at %s: %s",
                    worker_id,
                    bundle_dir,
                    exc,
                )

        if not bundle_dir.is_dir():
            return WorkerResult(
                status="error",
                error=f"Worker directory not found: {bundle_dir}",
                error_code="worker_not_found",
            )

        artifact_dir = _safe_path(ARTIFACTS_DIR, run_id)
        input_dir = _safe_path(artifact_dir, "inputs")
        output_dir = _safe_path(artifact_dir, "outputs")
        context_root = _safe_path(artifact_dir, "context")
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)
        _safe_path(input_dir, "inputs.json").write_text(json.dumps(inputs, indent=2), encoding="utf-8")

        # Stage attached brain packs (config.contexts) into a per-run context/
        # tree the agent's file tools can read, mirroring the e2b driver's
        # {workdir}/context/<name>/... layout. Owner-scoped: a run only ever
        # sees ITS attached packs, never another tenant's.
        staged_context_packs = self._stage_contexts(
            config=config,
            context_root=context_root,
            user_id=user_id,
            log_fn=log_fn,
        )

        outputs: Dict[str, Any] = {}
        artifacts: list[Dict[str, Any]] = []
        transcript: list[Dict[str, Any]] = []
        state = _AgentRunState(
            worker_id=worker_id,
            run_id=run_id,
            inputs=inputs,
            secrets=secrets,
            log_fn=log_fn,
            trace_id=trace_id,
            config=config,
            bundle_dir=bundle_dir,
            input_dir=input_dir,
            output_dir=output_dir,
            context_dir=context_root,
            outputs=outputs,
            artifacts=artifacts,
            timeout_seconds=timeout_seconds,
            connection_ids=connection_ids,
            user_id=user_id,
        )

        system_prompt = self._load_system_prompt(bundle_dir, config, staged_context_packs)
        run_input: str | list[dict[str, Any]] = json.dumps(
            {
                "worker_id": worker_id,
                "run_id": run_id,
                "inputs": inputs,
                "outputs_required": [output.name for output in config.outputs],
            },
            indent=2,
        )
        transcript.append({"role": "system", "content": system_prompt})
        transcript.append({"role": "user", "content": run_input})

        # OpenAI's hard cap is ~16 384 output tokens for most models. Passing
        # 1 000 000 (the WorkerLimits sentinel meaning "no limit") raises
        # InvalidRequestError before the first token is generated. Only forward
        # max_tokens when the worker explicitly set a value below the safe cap;
        # otherwise let the API use the model's own default.
        # Bedrock Claude rejects max_tokens above the model limit (128k for
        # Sonnet 4.6); the 1M "no limit" sentinel 400/429s before the first
        # token. Cap well under it so skill workers run on Bedrock out of the box
        # (no FLOOM_MAX_OUTPUT_TOKENS workaround needed) — see _agent_max_tokens
        # in the loop below.
        _effective_max_tokens = (
            _agent_effective_max_tokens(
                default_worker_agent_model(),
                _resolve_max_output_tokens(limits),
            )
        )
        model_settings = ModelSettings(
            max_tokens=_effective_max_tokens,
            include_usage=True,
        )
        # Per-run, loop-local OpenAI client. The SDK's default provider shares a
        # process-wide httpx client bound to the first loop that uses it; each
        # worker run executes in its own fresh asyncio loop (see
        # _run_coro_sync -> asyncio.run), so the shared client raises
        # "Event loop is closed" when concurrent runs overlap. Binding a fresh
        # client to THIS run's loop fully isolates concurrent runs.
        from .loop_local_provider import LoopLocalModelProvider

        loop_local_provider = LoopLocalModelProvider()
        run_config = RunConfig(
            workflow_name=f"workeros:{worker_id}",
            trace_id=trace_id,
            trace_metadata={"worker_id": worker_id, "run_id": run_id},
            model_settings=model_settings,
            model_provider=loop_local_provider.provider,
        )

        total_tokens = 0
        corrective_retry_used = False
        run_number = 1
        last_result: Any = None
        mcp_servers: list[Any] = []

        try:
            mcp_servers = await self._connect_mcp_servers(config, secrets, log_fn)
            while True:
                if self._cancel_requested(run_id):
                    log_fn("Cancel requested; stopping agent loop", "info")
                    return WorkerResult(
                        status="failed",
                        error="Run cancelled by user",
                        error_code="cancelled",
                    )
                if total_tokens >= limits.max_total_tokens:
                    return WorkerResult(
                        status="error",
                        error="Agent token cap exceeded",
                        error_code="token_cap_exceeded",
                    )

                force_finish = corrective_retry_used
                _agent_model = _llm.agent_model(
                    config.runtime.model
                    or _ws_default_model()
                    or _ws_fallback_model()
                    or default_worker_agent_model()
                )
                # Clamp output tokens to the provider's hard limit (caps above):
                # Bedrock -> 64k, OpenAI -> forward only when <=16k else None.
                _agent_max_tokens = _agent_effective_max_tokens(
                    _agent_model,
                    _resolve_max_output_tokens(limits),
                )
                agent = Agent(
                    name=worker_id,
                    instructions=system_prompt,
                    tools=self._sdk_tools(config, state),
                    mcp_servers=mcp_servers,
                    model=_agent_model,
                    model_settings=ModelSettings(
                        max_tokens=_agent_max_tokens,
                        include_usage=True,
                        tool_choice="finish_with_outputs" if force_finish else None,
                        extra_args=_llm.cache_control_extra_args(_agent_model),
                    ),
                    tool_use_behavior={"stop_at_tool_names": ["finish_with_outputs"]},
                )

                log_fn(f"Agent SDK run {run_number}", "debug")
                self._emit_part(run_id, {"type": "step-start", "stepNumber": run_number})
                transcript.append({"type": "step-start", "stepNumber": run_number})

                try:
                    result = await self._run_streamed(
                        agent=agent,
                        run_input=run_input,
                        max_turns=limits.max_tool_iterations,
                        run_config=run_config,
                    )
                except Exception as exc:
                    if exc.__class__.__name__ == "MaxTurnsExceeded":
                        return WorkerResult(
                            status="error",
                            error="Agent tool iteration cap exceeded",
                            error_code="tool_iteration_cap_exceeded",
                        )
                    raise
                last_result = result
                try:
                    stream_result = await self._consume_streamed_result(
                        result=result,
                        run_id=run_id,
                        transcript=transcript,
                        total_tokens=total_tokens,
                        max_total_tokens=limits.max_total_tokens,
                    )
                except Exception as exc:
                    if exc.__class__.__name__ == "MaxTurnsExceeded":
                        return WorkerResult(
                            status="error",
                            error="Agent tool iteration cap exceeded",
                            error_code="tool_iteration_cap_exceeded",
                        )
                    raise
                total_tokens = stream_result["total_tokens"]
                if stream_result["cancelled"]:
                    return WorkerResult(
                        status="failed",
                        error="Run cancelled by user",
                        error_code="cancelled",
                    )
                if stream_result["token_cap_exceeded"]:
                    return WorkerResult(
                        status="error",
                        error="Agent token cap exceeded",
                        error_code="token_cap_exceeded",
                    )

                if state.finished:
                    break

                missing_outputs = self._missing_required_outputs(config, outputs)
                if missing_outputs and not corrective_retry_used:
                    corrective_retry_used = True
                    run_number += 1
                    names = ", ".join(missing_outputs)
                    corrective_message = (
                        f"Required outputs not produced: {names}. "
                        "Call finish_with_outputs with the required top-level output names now."
                    )
                    transcript.append({"role": "user", "content": corrective_message})
                    try:
                        run_input = result.to_input_list()
                        run_input.append({"role": "user", "content": corrective_message})
                    except Exception:
                        run_input = corrective_message
                    continue
                break

            if last_result is not None:
                transcript.append({"type": "final_output", "content": str(getattr(last_result, "final_output", ""))})
            if total_tokens > 0:
                transcript.append({"type": "usage", "total_tokens": total_tokens})
            self._persist_transcript(output_dir, transcript, artifacts)
            missing_outputs = self._missing_required_outputs(config, outputs)
            if missing_outputs:
                return WorkerResult(
                    status="failed",
                    error=f"Output schema violation: Missing declared output '{missing_outputs[0]}'",
                    error_code="schema_violation",
                    artifacts=artifacts,
                )
            # Persist any edits the run made to writeable:true packs back to the
            # local store before returning success (mirrors e2b_driver).
            self._persist_writeable_contexts(
                config=config,
                context_root=context_root,
                user_id=user_id,
                log_fn=log_fn,
            )
            return WorkerResult(status="success", outputs=outputs, artifacts=artifacts)
        except _MCPConnectionError as exc:
            log_fn(str(exc), level="error")
            return WorkerResult(
                status="error",
                error=str(exc),
                error_code="mcp_connect_failed",
            )
        finally:
            await self._cleanup_mcp_servers(mcp_servers, log_fn)
            # Close the per-run OpenAI + httpx client while THIS run's loop is
            # still alive, so the connection pool is released cleanly (no leaks,
            # no "Event loop is closed" teardown warnings).
            await loop_local_provider.aclose()

    async def _run_streamed(self, agent: Any, run_input: Any, max_turns: int, run_config: Any) -> Any:
        from agents import Runner

        return Runner.run_streamed(
            agent,
            input=run_input,
            max_turns=max_turns,
            run_config=run_config,
        )

    async def _consume_streamed_result(
        self,
        result: Any,
        run_id: str,
        transcript: list[Dict[str, Any]],
        total_tokens: int,
        max_total_tokens: int,
    ) -> Dict[str, Any]:
        emitted_text_delta = False
        cancelled = False
        token_cap_exceeded = False

        async for event in result.stream_events():
            if self._cancel_requested(run_id):
                try:
                    result.cancel()
                except Exception:
                    logger.debug("Agent SDK cancellation failed for run %s", run_id, exc_info=True)
                cancelled = True
                break

            usage_tokens = self._usage_tokens_from_raw_event(event)
            if usage_tokens:
                total_tokens += usage_tokens
                if total_tokens > max_total_tokens:
                    try:
                        result.cancel()
                    except Exception:
                        logger.debug("Agent SDK token-cap cancellation failed for run %s", run_id, exc_info=True)
                    token_cap_exceeded = True
                    break

            part, emitted_delta = self._agent_event_to_part(event, emitted_text_delta)
            emitted_text_delta = emitted_text_delta or emitted_delta
            if part is None:
                continue
            transcript.append(part)
            self._emit_part(run_id, part)

        usage_total = self._usage_tokens_from_result(result)
        if usage_total and total_tokens < usage_total:
            total_tokens = usage_total
        return {
            "cancelled": cancelled,
            "token_cap_exceeded": token_cap_exceeded or total_tokens > max_total_tokens,
            "total_tokens": total_tokens,
        }

    def _usage_tokens_from_raw_event(self, event: Any) -> int:
        if getattr(event, "type", None) != "raw_response_event":
            return 0
        data = getattr(event, "data", None)
        response = getattr(data, "response", None)
        usage = getattr(response, "usage", None)
        return self._usage_tokens(usage)

    def _usage_tokens_from_result(self, result: Any) -> int:
        context_wrapper = getattr(result, "context_wrapper", None)
        usage = getattr(context_wrapper, "usage", None)
        return self._usage_tokens(usage)

    def _agent_event_to_part(self, event: Any, emitted_text_delta: bool) -> tuple[Optional[Dict[str, Any]], bool]:
        # Decoding is shared with chat_service.stream_chat (#605); this method
        # only formats the normalized item into transcript/run parts.
        from runner_sandbox.stream_adapter import decode_stream_event
        from services.chat_tool_cards import build_args_preview

        item = decode_stream_event(event)
        if item is None:
            return None, False

        if item.kind == "text_delta":
            return {"type": "text", "text": item.text}, True

        if item.kind == "reasoning_delta":
            return {"type": "reasoning", "text": item.text}, False

        if item.kind == "message_output":
            if emitted_text_delta or not item.text:
                return None, False
            return {"type": "text", "text": item.text}, False

        if item.kind == "reasoning":
            if not item.text:
                return None, False
            return {"type": "reasoning", "text": item.text}, False

        if item.kind == "tool_call":
            args_preview = build_args_preview(item.tool_name, item.args)
            return {
                "type": "tool-call",
                "toolName": item.tool_name,
                "args": args_preview,
                "args_preview": args_preview,
                "callId": item.call_id,
                **item.metadata,
            }, False

        if item.kind == "tool_output":
            result_preview = build_args_preview("tool-result", item.output)
            return {
                "type": "tool-result",
                "callId": item.call_id,
                "result": result_preview,
                "result_preview": result_preview,
                "isError": item.is_error,
                **item.metadata,
            }, False

        if item.kind == "mcp_approval":
            args_preview = build_args_preview(item.tool_name, item.args)
            return {
                "type": "tool-call",
                "toolName": item.tool_name,
                "args": args_preview,
                "args_preview": args_preview,
                "callId": item.call_id,
                "kind": "mcp-approval",
                **item.metadata,
            }, False

        if item.kind == "mcp_list_tools":
            return {
                "type": "tool-result",
                "callId": item.call_id,
                "result": {
                    "ok": True,
                    "event": "mcp_list_tools",
                    "server_label": item.server_label,
                },
                "isError": False,
                "kind": "mcp-list-tools",
                "mcpServer": item.server_label,
            }, False

        return None, False

    def _cancel_requested(self, run_id: str) -> bool:
        """Check if the run's cancel_requested flag is set."""
        return run_cancel_requested(run_id)

    def _stage_contexts(
        self,
        *,
        config: Optional[WorkerConfig],
        context_root: Path,
        user_id: str | None,
        log_fn: Callable[[str, str], None],
    ) -> list[str]:
        """Stage attached brain packs (delegates to the shared builder).

        Owner-scoped, per-pack ``context/<name>`` layout, git contexts skipped.
        See :func:`agent_capabilities.stage_context_packs`.
        """
        return agent_capabilities.stage_context_packs(
            config=config,
            context_root=context_root,
            user_id=user_id,
            log_fn=log_fn,
        )

    def _persist_writeable_contexts(
        self,
        *,
        config: Optional[WorkerConfig],
        context_root: Path,
        user_id: str | None,
        log_fn: Callable[[str, str], None],
    ) -> None:
        """Write back edits an agent-mode run made to ``writeable:true`` packs.

        Mirrors ``E2BSandboxDriver._persist_writeable_contexts`` (N3-2 / #364):
        agent-mode stages packs into ``context_root/<name>/...`` and the file
        tools are read-only, but a worker can still mutate staged files via
        ``run_command`` (shell). Without this, those edits are discarded on run
        end. We copy each ``writeable:true`` local pack's staged tree back over
        the canonical pack (``context_dir(name)``), owner-scoped — same scope,
        same per-pack layout, same source rules as e2b. Git packs are skipped
        (writeback target is the local store only). Only called on a successful
        run, matching the e2b trigger (``status not in ("error","failed")``).
        """
        if not config or not config.contexts:
            return

        with use_context_scope(context_scope_for_user(user_id)):
            for raw_context in config.contexts:
                try:
                    context = normalize_context_mount(raw_context)
                except ValueError as exc:
                    log_fn(f"[agent] Skipping invalid writeable context: {exc}", "warning")
                    continue
                if not context["writeable"]:
                    continue
                if context["source"] != "local":
                    log_fn(
                        f"[agent] Skipping writeback for git context {context['name']!r}",
                        "warning",
                    )
                    continue

                name = context["name"]
                staged_pack = _safe_path(context_root, name)
                if not staged_pack.is_dir():
                    log_fn(f"[agent] Writeable context {name!r} missing in staging", "warning")
                    continue

                try:
                    dest_root = context_dir(name)
                    dest_root.mkdir(parents=True, exist_ok=True)
                    # Mirror the staged tree onto the pack: write current staged
                    # files (covers edits + new files) then prune pack files the
                    # run deleted, so the persisted state matches the sandbox.
                    staged_rels: set[str] = set()
                    for fpath in iter_context_files(staged_pack):
                        rel = fpath.relative_to(staged_pack).as_posix()
                        staged_rels.add(rel)
                        target = _safe_path(dest_root, rel)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(fpath.read_bytes())
                    for existing in iter_context_files(dest_root):
                        rel = existing.relative_to(dest_root).as_posix()
                        if rel not in staged_rels:
                            existing.unlink(missing_ok=True)
                    log_fn(f"[agent] Persisted writeable context {name!r}", "info")
                except Exception as exc:
                    log_fn(f"[agent] Failed to persist writeable context {name!r}: {exc}", "warning")

    def _load_system_prompt(
        self,
        bundle_dir: Path,
        config: WorkerConfig,
        staged_context_packs: list[str] | None = None,
    ) -> str:
        prompt_parts: list[str] = []
        if config.runtime.system_prompt:
            prompt_parts.append(config.runtime.system_prompt.strip())
        output_contract = self._output_contract_block(config)
        if output_contract:
            prompt_parts.append(output_contract)
        entrypoint = config.runtime.entrypoint or "SKILL.md"
        entrypoint_path = _safe_path(bundle_dir, entrypoint)
        if entrypoint_path.is_file():
            prompt_parts.append(entrypoint_path.read_text(encoding="utf-8"))
        elif config.runtime.type != "none":
            raise FileNotFoundError(f"Agent entrypoint not found: {entrypoint}")
        if staged_context_packs:
            names = ", ".join(sorted(staged_context_packs))
            prompt_parts.append(
                "## Attached context packs\n\n"
                f"The following brain packs are attached: {names}. Their files are "
                "available under `context/<name>/` and readable with list_dir and "
                "read_file (e.g. list_dir('context'), read_file('context/"
                f"{sorted(staged_context_packs)[0]}/<file>')). Consult them as "
                "reference knowledge for this run."
            )
        if memory_enabled(config) and staged_context_packs:
            name = memory_context_name(config)
            if name in staged_context_packs:
                prompt_parts.append(
                    "## Worker memory\n\n"
                    f"This worker has durable memory in `context/{name}/`. Read it at "
                    "the start of each run. When the run discovers a durable user "
                    "preference, correction, or reusable fact, call remember_learning "
                    "with that learning. Memory is persisted only after a successful run."
                )
        prompt_parts.append(
            "Use tools to inspect bundle files as needed. "
            "Use web_search for fresh or external facts unless disabled. "
            "Call finish_with_outputs when all required outputs are ready."
        )
        return "\n\n".join(part for part in prompt_parts if part)

    def _output_contract_block(self, config: WorkerConfig) -> str:
        if not config.outputs:
            return ""
        lines = [
            "## Required outputs",
            "",
            "Produce exactly these declared output names. Required outputs must be present.",
            "When complete, call finish_with_outputs with the output names as top-level keys.",
            "",
        ]
        for output in config.outputs:
            lines.append(f"- name: {output.name}")
            lines.append(f"  type: {output.type}")
            lines.append(f"  required: {str(output.required).lower()}")
            if output.kind:
                lines.append(f"  kind: {output.kind}")
            if output.media_type:
                lines.append(f"  media_type: {output.media_type}")
            if output.path:
                lines.append(f"  path: {output.path}")
            if output.columns:
                lines.append(f"  columns: {json.dumps(output.columns)}")
            if output.json_required_keys:
                lines.append(f"  json_keys: {json.dumps(output.json_required_keys)}")
        return "\n".join(lines)

    def _finish_with_outputs_schema(self, config: WorkerConfig) -> Dict[str, Any]:
        properties = {
            output.name: self._output_value_schema(output)
            for output in config.outputs
        }
        required = [output.name for output in config.outputs if output.required]
        return {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        }

    def _output_value_schema(self, output: Any) -> Dict[str, Any]:
        output_type = output.type
        if output_type in {"markdown", "text", "csv", "file"}:
            return {"type": "string"}
        if output_type == "json":
            schema: Dict[str, Any] = {
                "type": "object",
                "additionalProperties": True,
            }
            if output.json_required_keys:
                schema["required"] = list(output.json_required_keys)
                schema["properties"] = {key: {} for key in output.json_required_keys}
            return schema
        if output_type == "number":
            return {"type": "number"}
        if output_type == "boolean":
            return {"type": "boolean"}
        return {"type": ["string", "object", "array", "number", "boolean"]}

    def _tool_schemas(self, config: WorkerConfig) -> list[Dict[str, Any]]:
        """Build tool schemas exposed to the agent.

        Workers opt out via `exec.disable_tools: [...]` in worker.yml.
        """
        declared_names = [output.name for output in config.outputs]
        output_name_schema: Dict[str, Any] = {"type": "string"}
        if declared_names:
            output_name_schema["enum"] = declared_names
        tools = [
            {"type": "web_search"},
            {
                "type": "function",
                "function": {
                    "name": "request_approval",
                    "description": (
                        "Pause the agent run and ask the human operator for approval. "
                        "The run status is set to pending_approval while waiting. "
                        "Returns {\"ok\": true, \"approved\": true/false, \"approval_id\": \"...\"} "
                        "once the operator decides. Use this to gate destructive or sensitive actions. "
                        "Do NOT use this if the worker manifest already declares approvals.required — "
                        "that is a separate manifest-level gate and combining both causes an infinite loop."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "description": "Short approval title shown to the operator.",
                            },
                            "description": {
                                "type": "string",
                                "description": "Longer description explaining what needs approval and why.",
                            },
                            "metadata": {
                                "type": "object",
                                "description": "Optional structured context (e.g. extracted fields) shown alongside the request.",
                                "additionalProperties": True,
                            },
                        },
                        "required": ["title"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_dir",
                    "description": "List files under the skill bundle.",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string", "default": "."}},
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a UTF-8 file under the skill bundle.",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "write_output",
                    "description": (
                        "Record a declared worker output. `content` MUST be the FINAL "
                        "output content itself: the complete markdown text, the full "
                        "JSON object, the full CSV body, etc. DO NOT pass a file path "
                        "or filename string (e.g. 'out/update.md') — the runtime writes "
                        "the content to the declared output path automatically. "
                        "Example: write_output(name='update', content='# Weekly update\\n\\n## Highlights\\n- Shipped X\\n- ...')."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": output_name_schema,
                            "content": {"type": ["string", "object", "array", "number", "boolean"]},
                        },
                        "required": ["name", "content"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "finish_with_outputs",
                    "description": (
                        "Write declared worker outputs and end the agent run successfully. "
                        "Each property in the arguments must be the FINAL CONTENT for "
                        "that named output (the complete markdown / JSON / text), NOT a "
                        "file path or filename. If a property is a markdown output, pass "
                        "the full markdown body inline. The runtime persists it to the "
                        "declared output path."
                    ),
                    "parameters": self._finish_with_outputs_schema(config),
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "run_command",
                    "description": "Run a local command in the bundle, inputs, or outputs directory.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "cmd": {"type": "string"},
                            "args": {"type": "array", "items": {"type": "string"}, "default": []},
                            "cwd": {"type": "string"},
                            "timeout": {"type": "integer"},
                            "env": {"type": "object", "additionalProperties": {"type": "string"}},
                        },
                        "required": ["cmd"],
                    },
                },
            },
        ]
        if memory_enabled(config):
            tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": "remember_learning",
                        "description": (
                            "Persist a durable learning, correction, preference, or reusable fact "
                            "to this worker's memory after the run succeeds."
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "learning": {"type": "string"},
                                "source": {"type": "string"},
                            },
                            "required": ["learning"],
                        },
                    },
                }
            )
        tools.extend([
            {
                "type": "function",
                "function": {
                    "name": "invoke_worker",
                    "description": "Synchronously invoke another Workeros worker.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "inputs": {"type": "object"},
                        },
                        "required": ["id", "inputs"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "log",
                    "description": "Emit a structured log message.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "message": {"type": "string"},
                            "level": {"type": "string", "enum": ["debug", "info", "warning", "error"]},
                        },
                        "required": ["message"],
                    },
                },
            },
        ])
        tools.extend(agent_capabilities.composio_tool_schemas(config, WORKER_POLICY))
        disabled = self._disabled_tool_names(config)
        if disabled:
            tools = [tool for tool in tools if not self._tool_is_disabled(tool, disabled)]
        return tools

    async def _connect_mcp_servers(
        self,
        config: WorkerConfig,
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
    ) -> list[Any]:
        servers: list[Any] = []
        for connection in self._mcp_connections(config):
            try:
                server = self._make_mcp_server(connection, secrets)
                await server.connect()
                log_fn(f"Connected MCP server {connection.label}", "debug")
                servers.append(server)
            except Exception as exc:  # noqa: BLE001 - normalize reload-split MCP errors
                if exc.__class__.__name__ == "MCPConnectionError":
                    raise _MCPConnectionError(str(exc)) from exc
                raise _MCPConnectionError(
                    f"MCP connection failed for {connection.label}: {exc}"
                ) from exc
        return servers

    async def _cleanup_mcp_servers(self, servers: list[Any], log_fn: Callable[[str, str], None]) -> None:
        await agent_capabilities.cleanup_mcp_servers(servers, log_fn)

    def _make_mcp_server(self, connection: Any, secrets: Dict[str, str]) -> Any:
        try:
            return agent_capabilities.make_mcp_server(connection, secrets, WORKER_POLICY)
        except Exception as exc:  # noqa: BLE001 - normalize reload-split MCP errors
            if exc.__class__.__name__ == "MCPConnectionError":
                raise _MCPConnectionError(str(exc)) from exc
            raise

    def _mcp_connections(self, config: WorkerConfig) -> list[Any]:
        return agent_capabilities.mcp_connections(config)

    def _sdk_tools(self, config: WorkerConfig, state: _AgentRunState) -> list[Any]:
        from agents import FunctionTool
        from web_search import web_search_tool

        sdk_tools: list[Any] = []
        for tool in self._tool_schemas(config):
            tool_type = tool.get("type")
            if tool_type == "web_search":
                sdk_tools.append(web_search_tool())
                continue
            if tool_type != "function":
                continue
            function = tool.get("function") or {}
            name = function["name"]

            async def _invoke(_ctx: Any, raw_args: str, *, tool_name: str = name) -> str:
                try:
                    args = json.loads(raw_args or "{}")
                    if not isinstance(args, dict):
                        return _json_dumps({"ok": False, "error": "Tool arguments must be an object"})
                except json.JSONDecodeError as exc:
                    return _json_dumps({"ok": False, "error": f"Invalid JSON arguments: {exc}"})
                # request_approval needs async polling — dispatch directly here
                if tool_name == "request_approval":
                    result = await self._request_approval_async(
                        args=args,
                        run_id=state.run_id,
                        worker_id=state.worker_id,
                        user_id=state.user_id,
                        log_fn=state.log_fn,
                        timeout_seconds=state.timeout_seconds,
                    )
                    return _json_dumps(result)
                result = self._handle_tool(
                    name=tool_name,
                    args=args,
                    worker_id=state.worker_id,
                    run_id=state.run_id,
                    inputs=state.inputs,
                    secrets=state.secrets,
                    log_fn=state.log_fn,
                    trace_id=state.trace_id,
                    config=state.config,
                    bundle_dir=state.bundle_dir,
                    input_dir=state.input_dir,
                    output_dir=state.output_dir,
                    outputs=state.outputs,
                    artifacts=state.artifacts,
                    timeout_seconds=state.timeout_seconds,
                    context_dir=state.context_dir,
                    connection_ids=state.connection_ids,
                    user_id=state.user_id,
                )
                if tool_name == "finish_with_outputs" and result.get("ok"):
                    state.finished = True
                return _json_dumps(result)

            sdk_tools.append(
                FunctionTool(
                    name=name,
                    description=function.get("description") or name,
                    params_json_schema=function.get("parameters") or {"type": "object", "properties": {}},
                    on_invoke_tool=_invoke,
                    strict_json_schema=False,
                )
            )
        return sdk_tools

    def _composio_connection_names(self, config: WorkerConfig) -> list[str]:
        return agent_capabilities.composio_connection_names(config)

    def _disabled_tool_names(self, config: WorkerConfig) -> set[str]:
        disabled = getattr(config.runtime, "disable_tools", None) or []
        return {str(name).strip().lower() for name in disabled if str(name).strip()}

    def _tool_is_disabled(self, tool: Dict[str, Any], disabled: set[str]) -> bool:
        tool_type = tool.get("type")
        if tool_type and tool_type != "function":
            return tool_type.lower() in disabled
        fn = tool.get("function") or {}
        name = (fn.get("name") or "").lower()
        if name in disabled:
            return True
        if name.startswith("composio__"):
            parts = name.split("__")
            if len(parts) >= 3 and parts[1] in disabled:
                return True
        return False

    def _handle_tool(
        self,
        name: str,
        args: Dict[str, Any],
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        config: WorkerConfig,
        bundle_dir: Path,
        input_dir: Path,
        output_dir: Path,
        outputs: Dict[str, Any],
        artifacts: list[Dict[str, Any]],
        timeout_seconds: int,
        context_dir: Path,
        connection_ids: Optional[Dict[str, str]] = None,
        user_id: str | None = None,
    ) -> Dict[str, Any]:
        try:
            if name == "list_dir":
                return self._list_dir(bundle_dir, str(args.get("path") or "."), context_dir)
            if name == "read_file":
                return self._read_file(bundle_dir, str(args.get("path") or ""), context_dir)
            if name == "write_output":
                return self._write_output(args, output_dir, outputs, artifacts, config)
            if name == "finish_with_outputs":
                return self._finish_with_outputs(args, output_dir, outputs, artifacts, config)
            if name == "run_command":
                return self._run_command(
                    args=args,
                    secrets=secrets,
                    config=config,
                    bundle_dir=bundle_dir,
                    input_dir=input_dir,
                    output_dir=output_dir,
                    timeout_seconds=timeout_seconds,
                    user_id=user_id,
                    run_id=run_id,
                )
            if name == "remember_learning":
                return self._remember_learning(args, context_dir, config)
            if name == "invoke_worker":
                return self._invoke_worker(args, state_user_id=user_id, config=config, run_id=run_id)
            if name == "request_approval":
                # request_approval is async (polls DB); callers must use the async path
                # in _sdk_tools._invoke_async_tool instead of this sync dispatcher.
                return {"ok": False, "error": "request_approval must be invoked via the async dispatch path"}
            if name == "log":
                level = str(args.get("level") or "info")
                log_fn(str(args.get("message") or ""), level)
                return {"ok": True}
            if name.startswith("composio__") or name.startswith("composio."):
                return self._composio_execute(name, args, worker_id, log_fn, config, connection_ids or {}, user_id)
            return {"ok": False, "error": f"Unknown tool: {name}"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _remember_learning(
        self,
        args: Dict[str, Any],
        context_root: Path,
        config: WorkerConfig,
    ) -> Dict[str, Any]:
        if not memory_enabled(config):
            return {"ok": False, "error": "worker memory is not enabled"}
        learning = str(args.get("learning") or "").strip()
        if not learning:
            return {"ok": False, "error": "learning is required"}
        source = str(args.get("source") or "").strip()
        name = memory_context_name(config)
        pack_dir = _safe_path(context_root, name)
        pack_dir.mkdir(parents=True, exist_ok=True)
        path = _safe_path(pack_dir, "learnings.jsonl")
        record: Dict[str, Any] = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "learning": learning,
        }
        if source:
            record["source"] = source
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        return {"ok": True, "path": f"context/{name}/learnings.jsonl"}

    def _resolve_read_path(self, bundle_dir: Path, context_dir: Path, path: str) -> Path:
        """Resolve a file-tool path to the bundle, or the staged context tree.

        Attached brain packs live under ``context/<name>/...`` (mirroring the
        e2b driver). ``context`` itself and any ``context/...`` path resolve
        against the per-run staged context root; everything else resolves
        against the read-only bundle. Both roots are path-traversal-guarded.
        """
        normalized = Path(path or ".").as_posix().strip("/")
        if normalized == "context":
            return context_dir.resolve()
        if normalized.startswith("context/"):
            return _safe_path(context_dir, normalized[len("context/") :])
        return _safe_path(bundle_dir, path)

    def _list_dir(self, bundle_dir: Path, path: str, context_dir: Path) -> Dict[str, Any]:
        target = self._resolve_read_path(bundle_dir, context_dir, path)
        if not target.is_dir():
            return {"ok": False, "error": f"Not a directory: {path}"}
        entries = []
        for child in sorted(target.iterdir(), key=lambda item: item.name):
            entries.append({"name": child.name, "type": "dir" if child.is_dir() else "file"})
        return {"ok": True, "entries": entries}

    def _read_file(self, bundle_dir: Path, path: str, context_dir: Path) -> Dict[str, Any]:
        target = self._resolve_read_path(bundle_dir, context_dir, path)
        if not target.is_file():
            return {"ok": False, "error": f"File not found: {path}"}
        return {"ok": True, "content": target.read_text(encoding="utf-8")}

    def _write_output(
        self,
        args: Dict[str, Any],
        output_dir: Path,
        outputs: Dict[str, Any],
        artifacts: list[Dict[str, Any]],
        config: WorkerConfig,
    ) -> Dict[str, Any]:
        name = str(args.get("name") or "")
        declared_names = {output.name for output in config.outputs}
        if declared_names and name not in declared_names:
            allowed = ", ".join(sorted(declared_names))
            return {"ok": False, "error": f"Undeclared output: {name}. Declared outputs: {allowed}"}
        content = args.get("content")
        declared = self._declared_output(config, name)
        if self._scalar_output_leaked_path(declared, content):
            return {
                "ok": False,
                "error": f"Scalar output {name} looks like a file path. Provide the actual output content.",
            }
        outputs[name] = content
        serialized = content if isinstance(content, str) else json.dumps(content, indent=2)
        artifact_root = output_dir.parent
        relative_path = declared.path if declared and declared.path else f"outputs/{name}.txt"
        path = _safe_path(artifact_root, relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")
        artifact = {
            "name": relative_path,
            "type": self._artifact_media_type(declared),
            "path": str(path),
            "relative_path": relative_path,
            "size_bytes": path.stat().st_size,
        }
        artifacts[:] = [item for item in artifacts if item.get("path") != str(path)]
        artifacts.append(artifact)
        return {"ok": True, "name": name, "path": relative_path}

    def _finish_with_outputs(
        self,
        args: Dict[str, Any],
        output_dir: Path,
        outputs: Dict[str, Any],
        artifacts: list[Dict[str, Any]],
        config: WorkerConfig,
    ) -> Dict[str, Any]:
        declared_names = {output.name for output in config.outputs}
        unexpected = sorted(set(args) - declared_names)
        if unexpected:
            return {
                "ok": False,
                "error": f"Undeclared outputs: {', '.join(unexpected)}",
            }
        for name, content in args.items():
            declared = self._declared_output(config, name)
            if self._scalar_output_leaked_path(declared, content):
                return {
                    "ok": False,
                    "error": f"Scalar output {name} looks like a file path. Provide the actual output content.",
                }
            result = self._write_output(
                {"name": name, "content": content},
                output_dir,
                outputs,
                artifacts,
                config,
            )
            if not result.get("ok"):
                return result
        missing = self._missing_required_outputs(config, outputs)
        if missing:
            return {
                "ok": False,
                "error": f"Required outputs not produced: {', '.join(missing)}",
            }
        return {"ok": True, "finished": True, "outputs": sorted(args)}

    def _declared_output(self, config: WorkerConfig, name: str) -> Any:
        for output in config.outputs:
            if output.name == name:
                return output
        return None

    def _scalar_output_leaked_path(self, output: Any, content: Any) -> bool:
        if not output:
            return False
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        return kind != "file" and _looks_like_relative_path_value(content)

    def _artifact_media_type(self, output: Any) -> str:
        if output and output.media_type:
            return output.media_type
        if output and output.type == "markdown":
            return "text/markdown"
        if output and output.type == "csv":
            return "text/csv"
        if output and output.type == "json":
            return "application/json"
        return "text/plain"

    def _missing_required_outputs(self, config: WorkerConfig, outputs: Dict[str, Any]) -> list[str]:
        return [
            output.name
            for output in config.outputs
            if output.required and output.name not in outputs
        ]

    def _persist_transcript(
        self,
        output_dir: Path,
        messages: list[Dict[str, Any]],
        artifacts: list[Dict[str, Any]],
    ) -> None:
        transcript_path = _safe_path(output_dir, "transcript.jsonl")
        transcript_path.write_text("\n".join(json.dumps(message, default=str) for message in messages) + "\n", encoding="utf-8")
        artifacts[:] = [item for item in artifacts if item.get("path") != str(transcript_path)]
        artifacts.append(
            {
                "name": transcript_path.name,
                "type": "application/jsonl",
                "path": str(transcript_path),
                "relative_path": "outputs/transcript.jsonl",
                "size_bytes": transcript_path.stat().st_size,
            }
        )

    def _run_command(
        self,
        args: Dict[str, Any],
        secrets: Dict[str, str],
        config: WorkerConfig,
        bundle_dir: Path,
        input_dir: Path,
        output_dir: Path,
        timeout_seconds: int,
        user_id: str | None = None,
        run_id: str | None = None,
    ) -> Dict[str, Any]:
        cmd = str(args.get("cmd") or "")
        if not cmd:
            return {"ok": False, "error": "cmd is required"}
        if Path(cmd).is_absolute():
            return {"ok": False, "error": "absolute command paths are not allowed"}
        cmd_args = args.get("args") or []
        if not isinstance(cmd_args, list) or not all(isinstance(item, str) for item in cmd_args):
            return {"ok": False, "error": "args must be a string array"}
        cwd = _safe_path_under_any(
            [bundle_dir, input_dir, output_dir],
            str(args.get("cwd") or "."),
            bundle_dir,
        )
        requested_env = args.get("env") or {}
        if not isinstance(requested_env, dict):
            return {"ok": False, "error": "env must be an object"}
        undeclared = sorted(set(requested_env) - set(config.secrets))
        if undeclared:
            return {"ok": False, "error": f"env keys are not declared secrets: {undeclared}"}
        env = {
            "PATH": os.environ.get("PATH", ""),
            "FLOOM_WORKER_DIR": str(bundle_dir),
            "FLOOM_INPUT_DIR": str(input_dir),
            "FLOOM_OUTPUT_DIR": str(output_dir),
        }
        for key in requested_env:
            if key in secrets:
                env[key] = secrets[key]

        # Inject worker-to-worker call capability when the manifest declares calls:
        _workeros_helper_dir: str | None = None
        if config.calls and user_id and run_id:
            from run_token import issue_worker_call_token, parse_call_depth
            _api_url = os.environ.get("WORKEROS_API_URL") or (
                f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"
            )
            # #994: the token carries THIS run's call depth (from its
            # trigger_source), so children created with it land one level
            # deeper and the cap actually accumulates across the chain.
            _self_depth = 0
            try:
                from db import get_repositories
                _row = get_repositories().runs.get_any(run_id=run_id)
                _self_depth = parse_call_depth((_row or {}).get("trigger_source"))
            except Exception:
                _self_depth = 0
            _wrt = issue_worker_call_token(
                user_id=user_id,
                parent_run_id=run_id,
                callable_workers=list(config.calls),
                depth=_self_depth,
            )
            env["WORKEROS_API_URL"] = _api_url
            env["WORKEROS_RUN_TOKEN"] = _wrt
            env["WORKEROS_CALL_DEPTH"] = str(_self_depth)
            # Write workeros.py into a temp dir and add to PYTHONPATH so that
            # run.py workers can do: from workeros import call_worker
            import tempfile
            from runner_sandbox.workeros_helper import WORKEROS_PY_CONTENT
            _workeros_helper_dir = tempfile.mkdtemp(prefix="workeros_helper_")
            (Path(_workeros_helper_dir) / "workeros.py").write_text(WORKEROS_PY_CONTENT)
            existing_path = env.get("PYTHONPATH", os.environ.get("PYTHONPATH", ""))
            env["PYTHONPATH"] = (
                _workeros_helper_dir + (":" + existing_path if existing_path else "")
            )

        timeout = min(int(args.get("timeout") or timeout_seconds), timeout_seconds)
        if config.runtime.runner == "e2b":
            return self._run_command_e2b(
                cmd=cmd,
                cmd_args=cmd_args,
                cwd=cwd,
                env=env,
                timeout=timeout,
                bundle_dir=bundle_dir,
                input_dir=input_dir,
                output_dir=output_dir,
                secrets=secrets,
            )
        # #1000: the local-subprocess path (runner != e2b) runs on the API
        # HOST, so it is a shell-injection surface (unlike E2B, where
        # python -c inside the sandbox is fine). Refuse it unless explicitly
        # opted in, and only allow a bare PATH executable — no slashes, no
        # interpreter -c/-e/-m invocations.
        if os.environ.get("WORKEROS_DEV") != "1" and os.environ.get("WORKEROS_ALLOW_LOCAL_RUNNER") != "1":
            return {
                "ok": False,
                "error": "local subprocess runner is disabled (E2B only); set runner: e2b",
            }
        if "/" in cmd or "\\" in cmd:
            return {"ok": False, "error": "command must be a bare PATH executable name"}
        _INTERP = {"sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3",
                   "node", "nodejs", "ruby", "perl", "php", "env", "eval", "exec"}
        _CODE_FLAGS = {"-c", "-e", "--eval", "-m", "--command"}
        if cmd.lower() in _INTERP and any(a in _CODE_FLAGS for a in cmd_args):
            return {"ok": False, "error": "interpreter -c/-e/-m invocations are not allowed"}
        try:
            with _CWD_LOCK:
                proc = subprocess.run(
                    [cmd, *cmd_args],
                    cwd=str(cwd),
                    env=env,
                    text=True,
                    capture_output=True,
                    timeout=timeout,
                    check=False,
                )
            return {
                "ok": proc.returncode == 0,
                "exit_code": proc.returncode,
                "stdout": _truncate(_scrub(proc.stdout or "", secrets), _STDOUT_CAP),
                "stderr": _truncate(_scrub(proc.stderr or "", secrets), _STDERR_CAP),
            }
        except FileNotFoundError:
            return {"ok": False, "error": f"command not found: {cmd}", "exit_code": 127}
        finally:
            if _workeros_helper_dir:
                import shutil
                shutil.rmtree(_workeros_helper_dir, ignore_errors=True)

    def _run_command_e2b(
        self,
        cmd: str,
        cmd_args: list[str],
        cwd: Path,
        env: Dict[str, str],
        timeout: int,
        bundle_dir: Path,
        input_dir: Path,
        output_dir: Path,
        secrets: Dict[str, str],
    ) -> Dict[str, Any]:
        api_key = os.environ.get("E2B_API_KEY")
        if not api_key:
            return {"ok": False, "error": "E2B_API_KEY is not configured"}

        from e2b import Sandbox
        from runner_sandbox.e2b_driver import _e2b_network_policy

        sandbox = Sandbox.create(
            api_key=api_key,
            timeout=max(timeout + 60, 180),
            network=_e2b_network_policy(None, api_url=os.environ.get("WORKEROS_API_URL")),
        )
        try:
            remote_bundle = "/home/user/worker"
            remote_inputs = "/home/user/inputs"
            remote_outputs = "/home/user/outputs"
            for remote_dir in (remote_bundle, remote_inputs, remote_outputs):
                sandbox.files.make_dir(remote_dir)
            self._upload_tree(sandbox, bundle_dir, remote_bundle)
            self._upload_tree(sandbox, input_dir, remote_inputs)
            self._upload_tree(sandbox, output_dir, remote_outputs)
            remote_cwd = self._remote_cwd(
                cwd=cwd,
                bundle_dir=bundle_dir,
                input_dir=input_dir,
                output_dir=output_dir,
                remote_bundle=remote_bundle,
                remote_inputs=remote_inputs,
                remote_outputs=remote_outputs,
            )
            proc = sandbox.commands.run(
                " ".join([self._shell_quote(cmd), *[self._shell_quote(arg) for arg in cmd_args]]),
                cwd=remote_cwd,
                envs=env,
                timeout=float(timeout),
            )
            return {
                "ok": proc.exit_code == 0,
                "exit_code": proc.exit_code,
                "stdout": _truncate(_scrub(proc.stdout or "", secrets), _STDOUT_CAP),
                "stderr": _truncate(_scrub(proc.stderr or "", secrets), _STDERR_CAP),
            }
        finally:
            try:
                sandbox.kill()
            except Exception as exc:
                logger.debug("E2B sandbox already gone (kill suppressed): %s", exc)

    def _upload_tree(self, sandbox: Any, local_root: Path, remote_root: str) -> None:
        if not local_root.exists():
            return
        upload_tree_tarball(
            sandbox,
            local_root,
            remote_root,
            log_fn=lambda message, level: logger.warning(message)
            if level == "warning"
            else logger.debug(message),
            label="agent tree",
        )
    def _remote_cwd(
        self,
        cwd: Path,
        bundle_dir: Path,
        input_dir: Path,
        output_dir: Path,
        remote_bundle: str,
        remote_inputs: str,
        remote_outputs: str,
    ) -> str:
        for local_root, remote_root in (
            (bundle_dir, remote_bundle),
            (input_dir, remote_inputs),
            (output_dir, remote_outputs),
        ):
            try:
                rel = cwd.relative_to(local_root)
                suffix = rel.as_posix()
                return remote_root if suffix == "." else f"{remote_root}/{suffix}"
            except ValueError:
                continue
        return remote_bundle

    def _shell_quote(self, value: str) -> str:
        return "'" + value.replace("'", "'\"'\"'") + "'"

    def _invoke_worker(
        self,
        args: Dict[str, Any],
        *,
        state_user_id: str | None,
        config: Optional[WorkerConfig] = None,
        run_id: str | None = None,
    ) -> Dict[str, Any]:
        target_id = str(args.get("id") or "")
        target_inputs = args.get("inputs") or {}
        if not target_id:
            return {"ok": False, "error": "id is required"}
        if not isinstance(target_inputs, dict):
            return {"ok": False, "error": "inputs must be an object"}
        if not state_user_id:
            return {"ok": False, "error": "invoke_worker requires an authenticated owner"}

        # Enforce calls: allowlist declared in worker.yml
        if config is not None and config.calls:
            if target_id not in config.calls:
                return {
                    "ok": False,
                    "error": (
                        f"Worker {target_id!r} is not in this worker's calls: list. "
                        f"Add it to the calls: section of worker.yml to allow this."
                    ),
                }

        from db import get_repositories
        from run_service import create_run, execute_run
        from run_token import MAX_CALL_DEPTH

        repos = get_repositories()

        # Depth tracking: the current run's trigger_source encodes depth as
        # "invoke_worker:depth=N".  The first call (directly triggered by a run)
        # has no depth encoded, so we default to 0.
        current_depth = 0
        if run_id:
            parent_row = repos.runs.get(user_id=state_user_id, run_id=run_id)
            if parent_row:
                ts = parent_row.get("trigger_source") or ""
                if ts.startswith("invoke_worker:depth="):
                    try:
                        current_depth = int(ts.split("=", 1)[1])
                    except (ValueError, IndexError):
                        current_depth = 0

        if current_depth >= MAX_CALL_DEPTH:
            return {
                "ok": False,
                "error": f"Maximum worker call depth ({MAX_CALL_DEPTH}) exceeded",
            }

        if repos.workers.get(user_id=state_user_id, worker_id=target_id) is None:
            return {"ok": False, "error": f"Worker not found or not owned by this run: {target_id}"}

        child_trigger_source = f"invoke_worker:depth={current_depth + 1}"
        child_run_id = create_run(
            target_id,
            target_inputs,
            trigger_source=child_trigger_source,
            user_id=state_user_id,
            repos=repos,
        )
        execute_run(child_run_id, target_id, target_inputs, user_id=state_user_id, repos=repos)
        row = repos.runs.get(user_id=state_user_id, run_id=child_run_id)
        if not row:
            return {"ok": False, "error": f"Child run not found: {child_run_id}"}
        return {
            "ok": row["status"] in {"completed", "pending_approval"},
            "run_id": child_run_id,
            "status": row["status"],
            "outputs": json.loads(row.get("output_json") or "{}"),
            "error": row.get("error"),
        }

    def _composio_execute(
        self,
        name: str,
        args: Dict[str, Any],
        worker_id: str,
        log_fn: Callable[[str, str], None],
        config: WorkerConfig,
        connection_ids: Dict[str, str],
        user_id: str | None,
    ) -> Dict[str, Any]:
        # Autonomous workers run under the full WORKER_POLICY (worker.yml scopes
        # govern). The interactive assistant runs the same shared execute path
        # under a read-only policy.
        return agent_capabilities.composio_execute(
            name=name,
            args=args,
            config=config,
            policy=WORKER_POLICY,
            connection_ids=connection_ids or {},
            user_id=user_id,
            log_fn=log_fn,
        )

    async def _request_approval_async(
        self,
        args: Dict[str, Any],
        run_id: str,
        worker_id: str,
        user_id: str | None,
        log_fn: Callable[[str, str], None],
        timeout_seconds: int,
    ) -> Dict[str, Any]:
        """Create an approval record, set run status to pending_approval, and poll
        until the operator approves/rejects or the run timeout is reached.

        Returns:
            {"ok": True, "approved": True/False, "approval_id": "apr_..."}
        """
        if not user_id:
            return {"ok": False, "error": "request_approval requires an authenticated run owner"}

        title = str(args.get("title") or "").strip() or "Approval required"
        description = str(args.get("description") or "").strip()
        metadata = args.get("metadata") or {}

        from db import get_repositories
        from run_service import publish_run_part
        from models import RunStatus

        repos = get_repositories()
        approval_id = f"apr_{uuid.uuid4().hex[:12]}"
        now_ts = datetime.now(timezone.utc).isoformat()

        # Build label/preview from title + description + metadata
        label = title
        preview_parts = [description] if description else []
        if metadata and isinstance(metadata, dict):
            try:
                preview_parts.append(json.dumps(metadata, default=str))
            except Exception:
                pass
        preview = "\n".join(preview_parts)[:500]

        try:
            repos.approvals.create(
                owner_id=user_id,
                id=approval_id,
                run_id=run_id,
                worker_id=worker_id,
                status="pending",
                label=label,
                preview=preview,
                created_at=now_ts,
                decision_input_json=json.dumps({"kind": "agent_tool"}),
            )
        except Exception as exc:
            logger.error("request_approval: failed to create approval row for run %s: %s", run_id, exc)
            return {"ok": False, "error": f"Failed to create approval record: {exc}"}

        # Set run status to pending_approval and emit SSE
        try:
            repos.runs.update_status(
                user_id=user_id,
                run_id=run_id,
                status=RunStatus.PENDING_APPROVAL.value,
            )
        except Exception as exc:
            logger.warning("request_approval: could not update run status for %s: %s", run_id, exc)

        try:
            from run_service import _publish_sse
            _publish_sse(run_id, {
                "type": "status",
                "run_id": run_id,
                "status": RunStatus.PENDING_APPROVAL.value,
                "approval_id": approval_id,
                "label": label,
            })
        except Exception:
            pass
        publish_run_part(run_id, {"type": "tool-approval-pending", "approval_id": approval_id, "label": label})
        log_fn(f"Approval requested: {label} (approval_id={approval_id})", "info")

        # Fan-out: notify the run owner over WhatsApp if they have an active binding.
        try:
            from channels.common import notify_pending_approval_via_whatsapp
            _worker_name_agent: str = worker_id
            try:
                _w_row_agent = repos.workers.get_any(worker_id=worker_id)
                _worker_name_agent = (_w_row_agent or {}).get("name") or worker_id
            except Exception:
                pass
            notify_pending_approval_via_whatsapp(
                owner_id=user_id,
                run_id=run_id,
                worker_name=_worker_name_agent,
                label=label,
                approval_id=approval_id,
            )
        except Exception:
            logger.warning(
                "request_approval: WhatsApp notify failed for run %s", run_id, exc_info=True
            )

        # Poll DB every 3 seconds until decided or timeout
        deadline = _time.monotonic() + timeout_seconds
        _poll_interval = 3.0
        while True:
            await asyncio.sleep(_poll_interval)
            try:
                # Poll by approval_id (not run_id) to avoid reading a different
                # approval row when multiple sequential request_approval() calls
                # are in flight for the same run.
                row = repos.approvals.get(owner_id=user_id, approval_id=approval_id) if user_id else None
            except Exception as exc:
                logger.warning("request_approval: poll error for %s: %s", run_id, exc)
                row = None

            if row and row.get("status") in ("approved", "rejected"):
                approved = row["status"] == "approved"
                # Restore run status to running so the agent loop continues
                try:
                    repos.runs.update_status(
                        user_id=user_id,
                        run_id=run_id,
                        status=RunStatus.RUNNING.value,
                    )
                except Exception:
                    pass
                log_fn(
                    f"Approval {'approved' if approved else 'rejected'}: {label} (approval_id={approval_id})",
                    "info",
                )
                edited_output = None
                try:
                    raw = row.get("edited_output_json")
                    if raw:
                        edited_output = json.loads(raw)
                except Exception:
                    pass
                return {
                    "ok": True,
                    "approved": approved,
                    "approval_id": approval_id,
                    "edited_output": edited_output,
                }

            if _time.monotonic() >= deadline:
                log_fn(f"Approval timed out after {timeout_seconds}s: {label}", "warning")
                try:
                    repos.runs.update_status(
                        user_id=user_id,
                        run_id=run_id,
                        status=RunStatus.RUNNING.value,
                    )
                except Exception:
                    pass
                try:
                    repos.approvals.reject(
                        owner_id=user_id,
                        run_id=run_id,
                        approval_id=approval_id,
                        decided_at=datetime.now(timezone.utc).isoformat(),
                        reason=f"Timed out after {timeout_seconds}s — no decision received",
                    )
                except Exception:
                    pass
                return {
                    "ok": False,
                    "approved": False,
                    "approval_id": approval_id,
                    "error": f"Approval timed out after {timeout_seconds}s",
                }

            # Check cancel flag so a cancelled run doesn't spin forever
            if self._cancel_requested(run_id):
                log_fn("request_approval: run cancelled while waiting for approval", "info")
                try:
                    repos.runs.update_status(
                        user_id=user_id,
                        run_id=run_id,
                        status=RunStatus.RUNNING.value,
                    )
                except Exception:
                    pass
                try:
                    repos.approvals.reject(
                        owner_id=user_id,
                        run_id=run_id,
                        approval_id=approval_id,
                        decided_at=datetime.now(timezone.utc).isoformat(),
                        reason="Run cancelled while awaiting approval",
                    )
                except Exception:
                    pass
                return {
                    "ok": False,
                    "approved": False,
                    "approval_id": approval_id,
                    "error": "Run cancelled while waiting for approval",
                }

    def _usage_tokens(self, usage: Any) -> int:
        if usage is None:
            return 0
        if isinstance(usage, dict):
            return int(usage.get("total_tokens") or 0)
        return int(getattr(usage, "total_tokens", 0) or 0)

    def _emit_part(self, run_id: str, part: Dict[str, Any]) -> None:
        try:
            from run_service import publish_run_part
            publish_run_part(run_id, part)
        except Exception:
            logger.debug("Run part emit failed for run %s", run_id, exc_info=True)
