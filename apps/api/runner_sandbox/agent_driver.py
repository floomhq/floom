"""Agent-mode worker driver.

The agent runtime treats a worker folder as a skill bundle. It loads the
declared entrypoint (default: SKILL.md) as the system prompt, sends run inputs
as a JSON user message, and lets the model call a small set of local tools.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from models import WorkerConfig, WorkerResult
from runner_local import ARTIFACTS_DIR, _validate_output_schema
from worker_registry import WORKERS_DIR

from .base import SandboxDriver

logger = logging.getLogger("floom.runner_sandbox.agent")

_CWD_LOCK = threading.Lock()
_STDOUT_CAP = 12000
_STDERR_CAP = 12000


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


class AgentDriver(SandboxDriver):
    """Runs a worker through an OpenAI tool loop."""

    def __init__(self, openai_client: Any = None):
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
    ) -> WorkerResult:
        try:
            return self._run_agent(
                worker_id=worker_id,
                run_id=run_id,
                inputs=inputs,
                secrets=secrets,
                log_fn=log_fn,
                trace_id=trace_id,
                timeout_seconds=timeout_seconds,
                config=config,
            )
        except Exception as exc:
            logger.exception("Agent driver failed for worker %s run %s", worker_id, run_id)
            log_fn(f"Agent runtime error: {exc}", "error")
            return WorkerResult(
                status="error",
                error=str(exc),
                error_code="agent_runtime_error",
                retryable=True,
            )

    def _run_agent(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int,
        config: Optional[WorkerConfig],
    ) -> WorkerResult:
        if not config or not config.runtime:
            return WorkerResult(status="error", error="Worker config not found", error_code="invalid_worker")

        limits = config.runtime.limits
        timeout_seconds = min(timeout_seconds, limits.timeout_seconds)
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
        input_dir.mkdir(parents=True, exist_ok=True)
        output_dir.mkdir(parents=True, exist_ok=True)
        _safe_path(input_dir, "inputs.json").write_text(json.dumps(inputs, indent=2))

        system_prompt = self._load_system_prompt(bundle_dir, config)
        messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "worker_id": worker_id,
                        "run_id": run_id,
                        "inputs": inputs,
                        "outputs_required": [output.name for output in config.outputs],
                    },
                    indent=2,
                ),
            },
        ]

        outputs: Dict[str, Any] = {}
        artifacts: list[Dict[str, Any]] = []
        total_tokens = 0
        client = self._client or self._make_openai_client()
        tools = self._tool_schemas(config)
        model = config.runtime.model or "gpt-5-mini"

        for iteration in range(limits.max_tool_iterations):
            # Check cancel_requested before each iteration so the agent stops
            # promptly on user cancel (runaway LLM token loops).
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

            log_fn(f"Agent iteration {iteration + 1}", "debug")
            # GPT-5 family + reasoning models require max_completion_tokens (not max_tokens).
            # Old openai SDK doesn't expose it as a kwarg, so we pass via extra_body.
            create_kwargs: Dict[str, Any] = {
                "model": model,
                "messages": messages,
                "tools": tools,
                "tool_choice": "auto",
            }
            if model.startswith(("gpt-5", "gpt-4.1", "o1", "o3")):
                create_kwargs["extra_body"] = {"max_completion_tokens": limits.max_output_tokens}
            else:
                create_kwargs["max_tokens"] = limits.max_output_tokens
            response = client.chat.completions.create(**create_kwargs)
            total_tokens += self._usage_tokens(response)
            if total_tokens > limits.max_total_tokens:
                return WorkerResult(
                    status="error",
                    error="Agent token cap exceeded",
                    error_code="token_cap_exceeded",
                )

            choice = self._first_choice(response)
            message = self._choice_message(choice)
            tool_calls = self._message_tool_calls(message)
            messages.append(self._assistant_message_dict(message, tool_calls))

            if not tool_calls:
                break

            for tool_call in tool_calls:
                tool_name = self._tool_call_name(tool_call)
                tool_args = self._tool_call_args(tool_call)
                tool_result = self._handle_tool(
                    name=tool_name,
                    args=tool_args,
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
                    outputs=outputs,
                    artifacts=artifacts,
                    timeout_seconds=timeout_seconds,
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": self._tool_call_id(tool_call),
                        "content": json.dumps(tool_result),
                    }
                )
        else:
            return WorkerResult(
                status="error",
                error="Agent tool iteration cap exceeded",
                error_code="tool_iteration_cap_exceeded",
            )

        schema_error = _validate_output_schema(worker_id, outputs, log_fn, config=config)
        if schema_error:
            log_fn(f"Schema validation failed: {schema_error}", level="error")
            return WorkerResult(
                status="failed",
                error=f"Output schema violation: {schema_error}",
                error_code="schema_violation",
            )

        transcript_path = _safe_path(output_dir, "transcript.jsonl")
        transcript_path.write_text("\n".join(json.dumps(message) for message in messages) + "\n")
        artifacts.append(
            {
                "name": "transcript.jsonl",
                "type": "application/jsonl",
                "path": str(transcript_path),
                "size_bytes": transcript_path.stat().st_size,
            }
        )
        return WorkerResult(status="success", outputs=outputs, artifacts=artifacts)

    def _cancel_requested(self, run_id: str) -> bool:
        """Check if the run's cancel_requested flag is set in the DB."""
        try:
            from db import get_db
            with get_db() as conn:
                row = conn.execute(
                    "SELECT cancel_requested FROM runs WHERE id = ?", (run_id,)
                ).fetchone()
            return bool(row and row["cancel_requested"])
        except Exception:
            return False

    def _make_openai_client(self) -> Any:
        from openai import OpenAI

        return OpenAI()

    def _load_system_prompt(self, bundle_dir: Path, config: WorkerConfig) -> str:
        prompt_parts: list[str] = []
        if config.runtime.system_prompt:
            prompt_parts.append(config.runtime.system_prompt.strip())
        entrypoint = config.runtime.entrypoint or "SKILL.md"
        entrypoint_path = _safe_path(bundle_dir, entrypoint)
        if entrypoint_path.is_file():
            prompt_parts.append(entrypoint_path.read_text())
        elif config.runtime.type != "none":
            raise FileNotFoundError(f"Agent entrypoint not found: {entrypoint}")
        prompt_parts.append(
            "Use tools to inspect bundle files as needed. "
            "Call write_output once for each declared output before finishing."
        )
        return "\n\n".join(part for part in prompt_parts if part)

    def _tool_schemas(self, config: WorkerConfig) -> list[Dict[str, Any]]:
        tools = [
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
                    "description": "Record a declared worker output.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "content": {"type": ["string", "object", "array", "number", "boolean"]},
                        },
                        "required": ["name", "content"],
                    },
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
        for app in config.connections:
            safe_app = "".join(ch if ch.isalnum() else "_" for ch in app.lower())
            tools.append(
                {
                    "type": "function",
                    "function": {
                        "name": f"composio__{safe_app}__execute",
                        "description": f"Execute a Composio tool as composio.{app}.<tool>(arguments).",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "tool": {"type": "string"},
                                "arguments": {"type": "object"},
                            },
                            "required": ["tool", "arguments"],
                        },
                    },
                }
            )
        return tools

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
    ) -> Dict[str, Any]:
        try:
            if name == "list_dir":
                return self._list_dir(bundle_dir, str(args.get("path") or "."))
            if name == "read_file":
                return self._read_file(bundle_dir, str(args.get("path") or ""))
            if name == "write_output":
                return self._write_output(args, output_dir, outputs, artifacts, config)
            if name == "run_command":
                return self._run_command(
                    args=args,
                    secrets=secrets,
                    config=config,
                    bundle_dir=bundle_dir,
                    input_dir=input_dir,
                    output_dir=output_dir,
                    timeout_seconds=timeout_seconds,
                )
            if name == "invoke_worker":
                return self._invoke_worker(args)
            if name == "log":
                level = str(args.get("level") or "info")
                log_fn(str(args.get("message") or ""), level)
                return {"ok": True}
            if name.startswith("composio__") or name.startswith("composio."):
                return self._composio_execute(name, args, worker_id, log_fn)
            return {"ok": False, "error": f"Unknown tool: {name}"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _list_dir(self, bundle_dir: Path, path: str) -> Dict[str, Any]:
        target = _safe_path(bundle_dir, path)
        if not target.is_dir():
            return {"ok": False, "error": f"Not a directory: {path}"}
        entries = []
        for child in sorted(target.iterdir(), key=lambda item: item.name):
            entries.append({"name": child.name, "type": "dir" if child.is_dir() else "file"})
        return {"ok": True, "entries": entries}

    def _read_file(self, bundle_dir: Path, path: str) -> Dict[str, Any]:
        target = _safe_path(bundle_dir, path)
        if not target.is_file():
            return {"ok": False, "error": f"File not found: {path}"}
        return {"ok": True, "content": target.read_text()}

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
            return {"ok": False, "error": f"Undeclared output: {name}"}
        content = args.get("content")
        outputs[name] = content
        serialized = content if isinstance(content, str) else json.dumps(content, indent=2)
        path = _safe_path(output_dir, f"{name}.txt")
        path.write_text(serialized)
        artifacts.append(
            {
                "name": path.name,
                "type": "text/plain",
                "path": str(path),
                "size_bytes": path.stat().st_size,
            }
        )
        return {"ok": True, "name": name}

    def _run_command(
        self,
        args: Dict[str, Any],
        secrets: Dict[str, str],
        config: WorkerConfig,
        bundle_dir: Path,
        input_dir: Path,
        output_dir: Path,
        timeout_seconds: int,
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

    def _invoke_worker(self, args: Dict[str, Any]) -> Dict[str, Any]:
        target_id = str(args.get("id") or "")
        target_inputs = args.get("inputs") or {}
        if not target_id:
            return {"ok": False, "error": "id is required"}
        if not isinstance(target_inputs, dict):
            return {"ok": False, "error": "inputs must be an object"}
        from db import get_db
        from run_service import create_run, execute_run

        child_run_id = create_run(target_id, target_inputs, trigger_source="invoke_worker")
        execute_run(child_run_id, target_id, target_inputs)
        with get_db() as conn:
            row = conn.execute("SELECT status, output_json, error FROM runs WHERE id = ?", (child_run_id,)).fetchone()
        if not row:
            return {"ok": False, "error": f"Child run not found: {child_run_id}"}
        return {
            "ok": row["status"] in {"completed", "pending_approval"},
            "run_id": child_run_id,
            "status": row["status"],
            "outputs": json.loads(row["output_json"] or "{}"),
            "error": row["error"],
        }

    def _composio_execute(
        self,
        name: str,
        args: Dict[str, Any],
        worker_id: str,
        log_fn: Callable[[str, str], None],
    ) -> Dict[str, Any]:
        tool = str(args.get("tool") or "")
        arguments = args.get("arguments") or {}
        if not tool:
            return {"ok": False, "error": "tool is required"}
        if not isinstance(arguments, dict):
            return {"ok": False, "error": "arguments must be an object"}
        from db import get_db
        import requests

        app_name = ""
        if name.startswith("composio__"):
            parts = name.split("__")
            app_name = parts[1] if len(parts) >= 3 else ""
        elif name.startswith("composio."):
            parts = name.split(".")
            app_name = parts[1] if len(parts) >= 3 else ""
        with get_db() as conn:
            row = conn.execute(
                "SELECT composio_connection_id FROM composio_connections WHERE app_name = ? AND status = 'active'",
                (app_name.lower(),),
            ).fetchone()
        if not row:
            return {"ok": False, "error": f"Missing active Composio connection for {app_name}"}
        api_key = os.environ.get("COMPOSIO_API_KEY")
        if not api_key:
            return {"ok": False, "error": "COMPOSIO_API_KEY is not configured"}
        log_fn(f"Executing Composio tool {tool}", "debug")
        response = requests.post(
            f"https://backend.composio.dev/api/v3/tools/execute/{tool}",
            headers={"x-api-key": api_key, "Content-Type": "application/json"},
            json={
                "connected_account_id": row["composio_connection_id"],
                "arguments": arguments,
            },
            timeout=30,
        )
        response.raise_for_status()
        result = response.json()
        return {"ok": True, "result": result}

    def _usage_tokens(self, response: Any) -> int:
        usage = getattr(response, "usage", None)
        if usage is None and isinstance(response, dict):
            usage = response.get("usage")
        if usage is None:
            return 0
        if isinstance(usage, dict):
            return int(usage.get("total_tokens") or 0)
        return int(getattr(usage, "total_tokens", 0) or 0)

    def _first_choice(self, response: Any) -> Any:
        choices = response.get("choices") if isinstance(response, dict) else getattr(response, "choices")
        return choices[0]

    def _choice_message(self, choice: Any) -> Any:
        return choice.get("message") if isinstance(choice, dict) else getattr(choice, "message")

    def _message_tool_calls(self, message: Any) -> list[Any]:
        calls = message.get("tool_calls") if isinstance(message, dict) else getattr(message, "tool_calls", None)
        return list(calls or [])

    def _assistant_message_dict(self, message: Any, tool_calls: list[Any]) -> Dict[str, Any]:
        content = message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
        result: Dict[str, Any] = {"role": "assistant", "content": content}
        if tool_calls:
            result["tool_calls"] = [self._tool_call_dict(call) for call in tool_calls]
        return result

    def _tool_call_dict(self, tool_call: Any) -> Dict[str, Any]:
        function = tool_call.get("function") if isinstance(tool_call, dict) else getattr(tool_call, "function")
        return {
            "id": self._tool_call_id(tool_call),
            "type": "function",
            "function": {
                "name": function.get("name") if isinstance(function, dict) else getattr(function, "name"),
                "arguments": function.get("arguments") if isinstance(function, dict) else getattr(function, "arguments"),
            },
        }

    def _tool_call_id(self, tool_call: Any) -> str:
        value = tool_call.get("id") if isinstance(tool_call, dict) else getattr(tool_call, "id", None)
        return value or f"call_{uuid.uuid4().hex[:12]}"

    def _tool_call_name(self, tool_call: Any) -> str:
        function = tool_call.get("function") if isinstance(tool_call, dict) else getattr(tool_call, "function")
        return function.get("name") if isinstance(function, dict) else getattr(function, "name")

    def _tool_call_args(self, tool_call: Any) -> Dict[str, Any]:
        function = tool_call.get("function") if isinstance(tool_call, dict) else getattr(tool_call, "function")
        raw = function.get("arguments") if isinstance(function, dict) else getattr(function, "arguments")
        if not raw:
            return {}
        if isinstance(raw, dict):
            return raw
        return json.loads(raw)
