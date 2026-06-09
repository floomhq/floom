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
import sqlite3
import subprocess
import threading
import uuid
from dataclasses import dataclass
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
    DEFAULT_WORKER_AGENT_MODEL,
    WorkerConfig,
    WorkerResult,
)
from runner_utils import ARTIFACTS_DIR
from worker_registry import WORKERS_DIR

from . import agent_capabilities
from .agent_capabilities import WORKER_POLICY, MCPConnectionError
from .base import SandboxDriver

logger = logging.getLogger("floom.runner_sandbox.agent")

_CWD_LOCK = threading.Lock()
_CANCEL_FLAG_DB_READ_ERRORS_LOCK = threading.Lock()
_CANCEL_FLAG_DB_READ_ERRORS_TOTAL = 0
_STDOUT_CAP = 12000
_STDERR_CAP = 12000
_PATH_VALUE_RE = re.compile(r"^(?:\.?/)?(?:out|outputs|output|artifacts|inputs)/[A-Za-z0-9._/@ -]+$")


def cancel_flag_db_read_errors_total() -> int:
    with _CANCEL_FLAG_DB_READ_ERRORS_LOCK:
        return _CANCEL_FLAG_DB_READ_ERRORS_TOTAL


def _safe_path(base: Path, *parts: str) -> Path:
    target = base.joinpath(*parts).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        raise ValueError(f"Path traversal attempt: {target}")
    return target


def _worker_dir_for_run(worker_id: str, config: Optional[WorkerConfig]) -> Path:
    bundle_path = config.runtime.bundle_path if config and config.runtime else None
    if bundle_path:
        raw_path = Path(bundle_path)
        target = raw_path if raw_path.is_absolute() else WORKERS_DIR.parent.joinpath(raw_path)
        resolved = target.resolve()
        allowed_root = WORKERS_DIR.parent.resolve()
        try:
            resolved.relative_to(allowed_root)
        except ValueError:
            raise ValueError(f"Path traversal attempt: {resolved}")
        return resolved
    return _safe_path(WORKERS_DIR, worker_id)


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
        timeout_seconds = min(timeout_seconds, limits.timeout_seconds)
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

        model_settings = ModelSettings(
            max_tokens=limits.max_output_tokens,
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
                agent = Agent(
                    name=worker_id,
                    instructions=system_prompt,
                    tools=self._sdk_tools(config, state),
                    mcp_servers=mcp_servers,
                    model=config.runtime.model or DEFAULT_WORKER_AGENT_MODEL,
                    model_settings=ModelSettings(
                        max_tokens=limits.max_output_tokens,
                        include_usage=True,
                        tool_choice="finish_with_outputs" if force_finish else None,
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
        event_type = getattr(event, "type", None)
        if event_type == "raw_response_event":
            part = self._raw_response_event_to_part(getattr(event, "data", None))
            return part, bool(part and part.get("type") == "text")

        if event_type != "run_item_stream_event":
            return None, False

        name = getattr(event, "name", None)
        item = getattr(event, "item", None)
        raw_item = getattr(item, "raw_item", None)

        if name == "message_output_created":
            if emitted_text_delta:
                return None, False
            text = self._message_item_text(item)
            if text:
                return {"type": "text", "text": text}, False
            return None, False

        if name == "reasoning_item_created":
            text = self._object_get(raw_item, "summary") or self._object_get(raw_item, "content")
            if isinstance(text, list):
                text = " ".join(str(part) for part in text)
            if text:
                return {"type": "reasoning", "text": str(text)}, False
            return None, False

        if name == "tool_called":
            tool_name = self._raw_tool_name(raw_item, item)
            return {
                "type": "tool-call",
                "toolName": tool_name,
                "args": self._raw_tool_args(raw_item),
                "callId": self._raw_tool_call_id(raw_item),
                **self._tool_part_metadata(raw_item, item),
            }, False

        if name == "tool_output":
            output = getattr(item, "output", None)
            parsed_output = self._maybe_json_loads(output)
            return {
                "type": "tool-result",
                "callId": self._raw_tool_call_id(raw_item),
                "result": parsed_output,
                "isError": self._tool_output_is_error(parsed_output),
                **self._tool_part_metadata(raw_item, item),
            }, False

        if name == "mcp_approval_requested":
            return {
                "type": "tool-call",
                "toolName": self._raw_tool_name(raw_item, item) or "mcp_approval_requested",
                "args": self._raw_tool_args(raw_item),
                "callId": self._raw_tool_call_id(raw_item),
                "kind": "mcp-approval",
                **self._tool_part_metadata(raw_item, item),
            }, False

        if name == "mcp_list_tools":
            server_label = self._object_get(raw_item, "server_label") or self._object_get(raw_item, "serverLabel")
            return {
                "type": "tool-result",
                "callId": self._raw_tool_call_id(raw_item),
                "result": {
                    "ok": True,
                    "event": "mcp_list_tools",
                    "server_label": server_label,
                },
                "isError": False,
                "kind": "mcp-list-tools",
                "mcpServer": server_label,
            }, False

        return None, False

    def _raw_response_event_to_part(self, data: Any) -> Optional[Dict[str, Any]]:
        data_type = str(getattr(data, "type", "") or "")
        delta = getattr(data, "delta", None)
        if delta and data_type.endswith("output_text.delta"):
            return {"type": "text", "text": str(delta)}
        if delta and "reasoning" in data_type:
            return {"type": "reasoning", "text": str(delta)}
        return None

    def _message_item_text(self, item: Any) -> str:
        try:
            from agents.items import ItemHelpers

            return ItemHelpers.text_message_output(item)
        except Exception:
            raw_item = getattr(item, "raw_item", None)
            content = self._object_get(raw_item, "content") or []
            parts: list[str] = []
            for entry in content:
                text = self._object_get(entry, "text")
                if text:
                    parts.append(str(text))
            return "".join(parts)

    def _raw_tool_name(self, raw_item: Any, item: Any = None) -> str:
        server_label = self._object_get(raw_item, "server_label") or self._object_get(raw_item, "serverLabel")
        name = self._object_get(raw_item, "name")
        raw_type = self._object_get(raw_item, "type")
        if server_label and name:
            return f"{server_label}.{name}"
        if name:
            return str(name)
        if raw_type:
            return str(raw_type)
        title = getattr(item, "title", None)
        return str(title or "tool")

    def _raw_tool_args(self, raw_item: Any) -> Any:
        raw_args = (
            self._object_get(raw_item, "arguments")
            or self._object_get(raw_item, "input")
            or self._object_get(raw_item, "action")
        )
        return self._maybe_json_loads(raw_args)

    def _raw_tool_call_id(self, raw_item: Any) -> str:
        value = (
            self._object_get(raw_item, "call_id")
            or self._object_get(raw_item, "callId")
            or self._object_get(raw_item, "id")
        )
        return str(value or f"call_{uuid.uuid4().hex[:12]}")

    def _tool_part_metadata(self, raw_item: Any, item: Any = None) -> Dict[str, Any]:
        metadata: Dict[str, Any] = {}
        server_label = self._object_get(raw_item, "server_label") or self._object_get(raw_item, "serverLabel")
        tool_origin = getattr(item, "tool_origin", None)
        origin_server = getattr(tool_origin, "mcp_server_name", None)
        if server_label or origin_server:
            metadata["kind"] = "mcp"
            metadata["mcpServer"] = server_label or origin_server
        raw_type = self._object_get(raw_item, "type")
        if raw_type == "web_search_call":
            metadata["kind"] = "web_search"
        return metadata

    def _tool_output_is_error(self, output: Any) -> bool:
        if isinstance(output, dict) and "ok" in output:
            return not bool(output.get("ok"))
        return False

    def _maybe_json_loads(self, value: Any) -> Any:
        if not isinstance(value, str):
            return value if value is not None else {}
        try:
            return json.loads(value)
        except Exception:
            return value

    def _cancel_requested(self, run_id: str) -> bool:
        """Check if the run's cancel_requested flag is set in the DB."""
        global _CANCEL_FLAG_DB_READ_ERRORS_TOTAL
        try:
            from db import get_db
            with get_db() as conn:
                row = conn.execute(
                    "SELECT cancel_requested FROM runs WHERE id = ?", (run_id,)
                ).fetchone()
            return bool(row and row["cancel_requested"])
        except sqlite3.OperationalError as exc:
            if "no such table: runs" in str(exc).lower():
                return False
            with _CANCEL_FLAG_DB_READ_ERRORS_LOCK:
                _CANCEL_FLAG_DB_READ_ERRORS_TOTAL += 1
            logger.warning(
                "Cancel flag read failed for run %s; treating as cancelled",
                run_id,
                exc_info=True,
            )
            return True
        except Exception:
            with _CANCEL_FLAG_DB_READ_ERRORS_LOCK:
                _CANCEL_FLAG_DB_READ_ERRORS_TOTAL += 1
            logger.warning(
                "Cancel flag read failed for run %s; treating as cancelled",
                run_id,
                exc_info=True,
            )
            return True

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
        ]
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
        from agents import FunctionTool, WebSearchTool

        sdk_tools: list[Any] = []
        for tool in self._tool_schemas(config):
            tool_type = tool.get("type")
            if tool_type == "web_search":
                sdk_tools.append(WebSearchTool())
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
            if name == "invoke_worker":
                return self._invoke_worker(args, state_user_id=user_id, config=config, run_id=run_id)
            if name == "log":
                level = str(args.get("level") or "info")
                log_fn(str(args.get("message") or ""), level)
                return {"ok": True}
            if name.startswith("composio__") or name.startswith("composio."):
                return self._composio_execute(name, args, worker_id, log_fn, config, connection_ids or {}, user_id)
            return {"ok": False, "error": f"Unknown tool: {name}"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

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
            from run_token import issue_worker_call_token, MAX_CALL_DEPTH
            _api_url = os.environ.get("WORKEROS_API_URL") or (
                f"http://127.0.0.1:{os.environ.get('PORT', '8000')}"
            )
            _wrt = issue_worker_call_token(
                user_id=user_id,
                parent_run_id=run_id,
                callable_workers=list(config.calls),
                depth=0,
            )
            env["WORKEROS_API_URL"] = _api_url
            env["WORKEROS_RUN_TOKEN"] = _wrt
            env["WORKEROS_CALL_DEPTH"] = "0"
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

        sandbox = Sandbox.create(api_key=api_key, timeout=max(timeout + 60, 180))
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
        for path in sorted(local_root.rglob("*")):
            rel = path.relative_to(local_root).as_posix()
            remote_path = f"{remote_root}/{rel}"
            if path.is_dir():
                sandbox.files.make_dir(remote_path)
            elif path.is_file():
                sandbox.files.write(remote_path, path.read_bytes())

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

    def _object_get(self, obj: Any, key: str) -> Any:
        if isinstance(obj, dict):
            return obj.get(key)
        return getattr(obj, key, None)
