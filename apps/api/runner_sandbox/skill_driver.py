"""LLM-backed runtime driver for workers whose exec.runtime starts with skill."""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional

import requests

from .base import SandboxDriver
from models import WorkerConfig, WorkerResult
from worker_registry import WORKERS_DIR

logger = logging.getLogger("floom.runner_sandbox.skill")

ARTIFACTS_DIR = Path(os.environ.get("FLOOM_ARTIFACTS_DIR", "../../data/artifacts")).resolve()
MAX_TOOL_ITERATIONS = 12
COMPOSIO_BASE = "https://backend.composio.dev/api/v3"


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


def _sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("._")
    return cleaned or "output"


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _object_get(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _message_to_dict(message: Any) -> Dict[str, Any]:
    if isinstance(message, dict):
        return dict(message)
    if hasattr(message, "model_dump"):
        return message.model_dump(exclude_none=True)
    result = {
        "role": _object_get(message, "role", "assistant"),
        "content": _object_get(message, "content"),
    }
    tool_calls = _object_get(message, "tool_calls")
    if tool_calls:
        result["tool_calls"] = [_tool_call_to_dict(call) for call in tool_calls]
    return {key: value for key, value in result.items() if value is not None}


def _tool_call_to_dict(tool_call: Any) -> Dict[str, Any]:
    if isinstance(tool_call, dict):
        return dict(tool_call)
    function = _object_get(tool_call, "function", {})
    if hasattr(function, "model_dump"):
        function = function.model_dump(exclude_none=True)
    elif not isinstance(function, dict):
        function = {
            "name": _object_get(function, "name"),
            "arguments": _object_get(function, "arguments", "{}"),
        }
    return {
        "id": _object_get(tool_call, "id"),
        "type": _object_get(tool_call, "type", "function"),
        "function": function,
    }


def _tool_call_name(tool_call: Any) -> str:
    function = _object_get(tool_call, "function", {})
    return str(_object_get(function, "name", ""))


def _tool_call_arguments(tool_call: Any) -> Dict[str, Any]:
    function = _object_get(tool_call, "function", {})
    raw_args = _object_get(function, "arguments", "{}") or "{}"
    if isinstance(raw_args, dict):
        return raw_args
    try:
        parsed = json.loads(raw_args)
    except json.JSONDecodeError:
        return {"_raw": raw_args}
    return parsed if isinstance(parsed, dict) else {"value": parsed}


def _tool_call_id(tool_call: Any) -> str:
    return str(_object_get(tool_call, "id", "tool_call"))


def _message_from_completion(completion: Any) -> Any:
    choices = _object_get(completion, "choices", [])
    first = choices[0]
    return _object_get(first, "message")


def _message_content(message: Any) -> str:
    content = _object_get(message, "content", "") or ""
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return str(content)


def _message_tool_calls(message: Any) -> list[Any]:
    return list(_object_get(message, "tool_calls", []) or [])


class SkillRuntimeDriver(SandboxDriver):
    """Runs a worker by handing its SKILL.md and JSON inputs to an LLM."""

    def __init__(
        self,
        openai_client: Any = None,
        requests_session: Optional[requests.Session] = None,
    ) -> None:
        self._openai_client = openai_client
        self._requests = requests_session or requests.Session()

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
            return self._run_skill(worker_id, run_id, inputs, secrets, log_fn, timeout_seconds, config)
        except Exception as exc:
            logger.exception("Skill runtime failed for worker %s run %s: %s", worker_id, run_id, exc)
            log_fn(f"Skill runtime error: {exc}", "error")
            return WorkerResult(
                status="error",
                error=str(exc),
                error_code="skill_runtime_error",
                retryable=True,
            )

    def _run_skill(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        timeout_seconds: int,
        config: Optional[WorkerConfig],
    ) -> WorkerResult:
        worker_dir = _worker_dir_for_run(worker_id, config)
        entrypoint = config.runtime.entrypoint if config and config.runtime else "SKILL.md"
        skill_path = _safe_path(worker_dir, entrypoint or "SKILL.md")
        if not skill_path.is_file():
            return WorkerResult(
                status="error",
                error=f"Skill entrypoint not found: {skill_path}",
                error_code="skill_not_found",
            )

        artifact_dir = _safe_path(ARTIFACTS_DIR, run_id)
        artifact_dir.mkdir(parents=True, exist_ok=True)

        system_prompt = skill_path.read_text(encoding="utf-8")
        user_message = json.dumps(inputs, ensure_ascii=False, indent=2, sort_keys=True)
        messages: list[Dict[str, Any]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ]
        transcript: list[Dict[str, Any]] = [
            {"type": "message", "role": "system", "content": system_prompt},
            {"type": "message", "role": "user", "content": user_message},
        ]
        outputs: Dict[str, str] = {}
        output_artifacts: list[Dict[str, Any]] = []
        tools = self._build_tools(config)
        model = self._model_for(config)
        client = self._client(secrets)

        log_fn(f"[skill] Calling OpenAI model {model}", "info")
        final_content = ""

        for iteration in range(MAX_TOOL_ITERATIONS):
            completion = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                temperature=0.5,
                timeout=timeout_seconds,
            )
            assistant_message = _message_from_completion(completion)
            final_content = _message_content(assistant_message)
            messages.append(_message_to_dict(assistant_message))
            transcript.append({
                "type": "message",
                "role": "assistant",
                "content": final_content,
                "tool_calls": [_tool_call_to_dict(call) for call in _message_tool_calls(assistant_message)],
            })

            tool_calls = _message_tool_calls(assistant_message)
            if not tool_calls:
                break

            for tool_call in tool_calls:
                name = _tool_call_name(tool_call)
                args = _tool_call_arguments(tool_call)
                call_id = _tool_call_id(tool_call)
                transcript.append({
                    "type": "tool_call",
                    "id": call_id,
                    "name": self._logical_tool_name(name, args),
                    "arguments": args,
                })
                result = self._dispatch_tool(
                    name=name,
                    args=args,
                    worker_id=worker_id,
                    run_id=run_id,
                    artifact_dir=artifact_dir,
                    outputs=outputs,
                    output_artifacts=output_artifacts,
                    config=config,
                    log_fn=log_fn,
                )
                transcript.append({
                    "type": "tool_result",
                    "tool_call_id": call_id,
                    "name": self._logical_tool_name(name, args),
                    "content": result,
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": _json_dumps(result),
                })
        else:
            return WorkerResult(
                status="error",
                error=f"Skill runtime exceeded {MAX_TOOL_ITERATIONS} tool iterations",
                error_code="tool_loop_exhausted",
            )

        if not outputs:
            self._capture_final_as_single_output(final_content, artifact_dir, outputs, output_artifacts, config)

        transcript_artifact = self._write_transcript(run_id, artifact_dir, transcript, secrets)
        artifacts = output_artifacts + [transcript_artifact]

        schema_error = self._validate_outputs(worker_id, outputs, log_fn, config)
        if schema_error:
            log_fn(f"Schema validation failed: {schema_error}", "error")
            return WorkerResult(
                status="failed",
                outputs=outputs,
                artifacts=artifacts,
                error=f"Output schema violation: {schema_error}",
                error_code="schema_violation",
            )

        log_fn("[skill] Run completed", "info")
        return WorkerResult(
            status="success",
            outputs=outputs,
            artifacts=artifacts,
        )

    def _client(self, secrets: Dict[str, str]) -> Any:
        if self._openai_client is not None:
            return self._openai_client
        from openai import OpenAI

        api_key = secrets.get("OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")
        return OpenAI(api_key=api_key) if api_key else OpenAI()

    def _model_for(self, config: Optional[WorkerConfig]) -> str:
        return (config.model if config and config.model else None) or os.environ.get("OPENAI_DEFAULT_MODEL") or "gpt-4.1"

    def _build_tools(self, config: Optional[WorkerConfig]) -> list[Dict[str, Any]]:
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "write_output",
                    "description": "Write a named worker output file. Use this for every declared output.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "content": {"type": "string"},
                        },
                        "required": ["name", "content"],
                        "additionalProperties": False,
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "floom__skills__invoke",
                    "description": "Placeholder for logical tool floom.skills.invoke(slug, inputs).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "slug": {"type": "string"},
                            "inputs": {"type": "object"},
                        },
                        "required": ["slug", "inputs"],
                        "additionalProperties": False,
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "floom__workers__invoke",
                    "description": "Placeholder for logical tool floom.workers.invoke(id, inputs).",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "inputs": {"type": "object"},
                        },
                        "required": ["id", "inputs"],
                        "additionalProperties": False,
                    },
                },
            },
        ]

        for app in self._declared_connections(config):
            tool_name = f"composio__{self._safe_tool_token(app)}__execute"
            tools.append({
                "type": "function",
                "function": {
                    "name": tool_name,
                    "description": (
                        f"Execute a Composio tool for {app}. Logical surface: "
                        f"composio.{app}.<tool_slug>. Provide the Composio tool slug and arguments."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "tool_slug": {"type": "string"},
                            "arguments": {"type": "object"},
                            "text": {"type": "string"},
                        },
                        "required": ["tool_slug"],
                        "additionalProperties": False,
                    },
                },
            })
        return tools

    def _dispatch_tool(
        self,
        name: str,
        args: Dict[str, Any],
        worker_id: str,
        run_id: str,
        artifact_dir: Path,
        outputs: Dict[str, str],
        output_artifacts: list[Dict[str, Any]],
        config: Optional[WorkerConfig],
        log_fn: Callable[[str, str], None],
    ) -> Dict[str, Any]:
        if name == "write_output":
            return self._write_output(args, artifact_dir, outputs, output_artifacts, config)
        if name in {"floom__skills__invoke", "floom.skills.invoke"}:
            return {"ok": False, "error": "not yet"}
        if name in {"floom__workers__invoke", "floom.workers.invoke"}:
            return {"ok": False, "error": "not yet"}
        if name.startswith("composio__") or name.startswith("composio."):
            return self._execute_composio_tool(name, args, worker_id, config, log_fn)
        return {"ok": False, "error": f"Unknown tool: {name}"}

    def _write_output(
        self,
        args: Dict[str, Any],
        artifact_dir: Path,
        outputs: Dict[str, str],
        output_artifacts: list[Dict[str, Any]],
        config: Optional[WorkerConfig],
    ) -> Dict[str, Any]:
        raw_name = str(args.get("name") or "output")
        content = str(args.get("content") or "")
        outputs[raw_name] = content

        filename = self._filename_for_output(raw_name, config)
        path = _safe_path(artifact_dir, filename)
        path.write_text(content, encoding="utf-8")

        artifact = {
            "name": filename,
            "type": self._artifact_type_for_output(raw_name, config),
            "path": str(path),
            "size_bytes": path.stat().st_size,
        }
        output_artifacts[:] = [item for item in output_artifacts if item.get("name") != filename]
        output_artifacts.append(artifact)
        return {"ok": True, "name": raw_name, "artifact": filename}

    def _capture_final_as_single_output(
        self,
        final_content: str,
        artifact_dir: Path,
        outputs: Dict[str, str],
        output_artifacts: list[Dict[str, Any]],
        config: Optional[WorkerConfig],
    ) -> None:
        if not final_content.strip() or not config or len(config.outputs) != 1:
            return
        self._write_output(
            {"name": config.outputs[0].name, "content": final_content},
            artifact_dir,
            outputs,
            output_artifacts,
            config,
        )

    def _write_transcript(
        self,
        run_id: str,
        artifact_dir: Path,
        transcript: Iterable[Dict[str, Any]],
        secrets: Dict[str, str],
    ) -> Dict[str, Any]:
        path = _safe_path(artifact_dir, "transcript.jsonl")
        with path.open("w", encoding="utf-8") as handle:
            for row in transcript:
                handle.write(_json_dumps(self._scrub(row, secrets)) + "\n")
        return {
            "name": "transcript.jsonl",
            "type": "jsonl",
            "path": str(path),
            "size_bytes": path.stat().st_size,
        }

    def _execute_composio_tool(
        self,
        name: str,
        args: Dict[str, Any],
        worker_id: str,
        config: Optional[WorkerConfig],
        log_fn: Callable[[str, str], None],
    ) -> Dict[str, Any]:
        tool_slug = str(args.get("tool_slug") or self._tool_slug_from_dotted_name(name) or "")
        if not tool_slug:
            return {"ok": False, "error": "Missing tool_slug"}
        app_name = self._app_from_composio_tool_name(name)
        connection_id = self._connection_id_for(app_name, worker_id, config)
        body: Dict[str, Any] = {
            "user_id": "federico",
            "arguments": args.get("arguments") or {},
        }
        if args.get("text"):
            body["text"] = args["text"]
        if connection_id:
            body["connected_account_id"] = connection_id

        api_key = os.environ.get("COMPOSIO_API_KEY", "")
        if not api_key:
            return {"ok": False, "error": "COMPOSIO_API_KEY is not set"}

        log_fn(f"[skill] Executing Composio tool {tool_slug}", "info")
        response = self._requests.post(
            f"{COMPOSIO_BASE}/tools/execute/{tool_slug}",
            headers={"x-api-key": api_key, "Content-Type": "application/json"},
            json=body,
            timeout=30,
        )
        try:
            data = response.json()
        except ValueError:
            data = {"text": response.text}
        if response.status_code >= 400:
            return {"ok": False, "status_code": response.status_code, "error": data}
        return {"ok": True, "data": data}

    def _connection_id_for(
        self,
        app_name: str,
        worker_id: str,
        config: Optional[WorkerConfig],
    ) -> Optional[str]:
        if not app_name:
            return None
        try:
            from db import get_db

            with get_db() as conn:
                row = conn.execute(
                    """
                    SELECT composio_connection_id
                    FROM composio_connections
                    WHERE app_name = ? AND status = 'active'
                    ORDER BY updated_at DESC
                    LIMIT 1
                    """,
                    (app_name.lower(),),
                ).fetchone()
            if row:
                return row["composio_connection_id"]
        except Exception:
            logger.debug("Failed to resolve Composio connection from DB", exc_info=True)

        try:
            from composio_client import get_entity_connection_id

            return get_entity_connection_id(app_name)
        except Exception:
            logger.debug("Failed to resolve Composio connection from API", exc_info=True)
        return None

    def _declared_connections(self, config: Optional[WorkerConfig]) -> list[str]:
        if not config:
            return []
        return sorted({app.lower() for app in (config.connections or []) if app})

    def _filename_for_output(self, name: str, config: Optional[WorkerConfig]) -> str:
        output = self._declared_output(name, config)
        extension = {
            "markdown": ".md",
            "csv": ".csv",
            "json": ".json",
            "text": ".txt",
        }.get(output.type if output else "text", ".txt")
        sanitized = _sanitize_filename(name)
        if sanitized.endswith(extension):
            return sanitized
        return f"{sanitized}{extension}"

    def _artifact_type_for_output(self, name: str, config: Optional[WorkerConfig]) -> str:
        output = self._declared_output(name, config)
        return output.type if output else "text"

    def _declared_output(self, name: str, config: Optional[WorkerConfig]) -> Any:
        if not config:
            return None
        for output in config.outputs:
            if output.name == name:
                return output
        return None

    def _validate_outputs(
        self,
        worker_id: str,
        outputs: Dict[str, Any],
        log_fn: Callable[[str, str], None],
        config: Optional[WorkerConfig],
    ) -> Optional[str]:
        from runner_local import _validate_output_schema

        return _validate_output_schema(worker_id, outputs, log_fn, config=config)

    def _logical_tool_name(self, name: str, args: Dict[str, Any]) -> str:
        if name == "floom__skills__invoke":
            return "floom.skills.invoke"
        if name == "floom__workers__invoke":
            return "floom.workers.invoke"
        if name.startswith("composio__"):
            app = self._app_from_composio_tool_name(name)
            tool_slug = args.get("tool_slug") or "<tool_slug>"
            return f"composio.{app}.{tool_slug}"
        return name

    def _tool_slug_from_dotted_name(self, name: str) -> Optional[str]:
        parts = name.split(".")
        return parts[2] if len(parts) >= 3 and parts[0] == "composio" else None

    def _app_from_composio_tool_name(self, name: str) -> str:
        if name.startswith("composio."):
            parts = name.split(".")
            return parts[1].lower() if len(parts) >= 2 else ""
        match = re.match(r"^composio__([a-z0-9_]+)__execute$", name)
        return (match.group(1).replace("_", "-") if match else "").lower()

    def _safe_tool_token(self, value: str) -> str:
        token = re.sub(r"[^A-Za-z0-9_-]+", "_", value)
        return token or "app"

    def _scrub(self, value: Any, secrets: Dict[str, str]) -> Any:
        if isinstance(value, dict):
            return {key: self._scrub(item, secrets) for key, item in value.items()}
        if isinstance(value, list):
            return [self._scrub(item, secrets) for item in value]
        if isinstance(value, str):
            scrubbed = value
            for name, secret in secrets.items():
                if secret and len(secret) > 3:
                    scrubbed = scrubbed.replace(secret, f"<REDACTED:{name}>")
            return scrubbed
        return value
