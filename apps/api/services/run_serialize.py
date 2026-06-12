"""Run serialization helpers: run-row -> API response shaping + transcript parsing.

The pure transforms that turn a stored run row (plus its artifacts/transcript)
into the API's RunSummary/RunDetail shapes, the agent-transcript normalizer and
its tool-call/token extractors, the run-status filter resolver, and the
primary-output-file extractor. Shared by the runs, workers, and overview route
groups. Extracted verbatim from main.py.

Pure/leaf deps only: ``models`` response types, ``core.utils`` row coercion,
``services.public_view`` operator-error shaping; ``runner_utils`` (artifacts
dir) is imported lazily. Never imports ``main``.
"""

from __future__ import annotations

import base64
import json
import mimetypes
from base64 import b64decode
from mimetypes import guess_extension
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from core.utils import row_to_dict
from models import Artifact, RunStatus, RunSummary, ToolCallEntry
from services.public_view import _operator_error_message

def _resolve_run_status_filters(raw_status: Optional[str]) -> List[str]:
    if not raw_status:
        return []
    mapping = {
        "success": ["completed"],
        "error": ["failed"],
        "running": ["running", "queued"],
        "cancelled": ["cancelled"],
        "completed": ["completed"],
        "failed": ["failed"],
        "queued": ["queued"],
        "pending_approval": ["pending_approval"],
    }
    statuses: List[str] = []
    for token in raw_status.split(","):
        key = token.strip().lower()
        if not key:
            continue
        resolved = mapping.get(key)
        if resolved is None:
            raise HTTPException(status_code=400, detail=f"Invalid status filter: {token.strip()}")
        for item in resolved:
            if item not in statuses:
                statuses.append(item)
    return statuses


def _read_transcript_rows(run_runner: str, artifacts: List[Artifact]) -> List[Dict[str, Any]]:
    runner = (run_runner or "").lower()
    is_agent = runner.startswith("agent") or "agent" in runner

    if not is_agent:
        return []
    candidate_names = {"outputs/transcript.jsonl", "transcript.jsonl"}

    transcript = next(
        (a for a in artifacts if (a.name or "") in candidate_names),
        None,
    )
    if not transcript:
        return []

    from runner_utils import ARTIFACTS_DIR

    try:
        artifacts_dir = ARTIFACTS_DIR.resolve()
        path = Path(transcript.path).resolve()
        path.relative_to(artifacts_dir)
    except Exception:
        return []
    if not path.is_file() or path.stat().st_size > 2_000_000:
        return []

    raw_rows: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            parsed = {"type": "parse_error", "content": line}
        if isinstance(parsed, dict):
            raw_rows.append(parsed)

    # AgentDriver writes message dicts. Normalize to the
    # {type, id, name, arguments, content} shape consumed by run detail callers.
    rows: List[Dict[str, Any]] = []
    for msg in raw_rows:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if isinstance(content, str):
            rows.append({"type": "message", "role": role, "content": content, "tool_calls": []})
            continue
        if not isinstance(content, list):
            rows.append(msg)
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type", "")
            if btype == "text":
                rows.append({"type": "message", "role": role, "content": block.get("text", ""), "tool_calls": []})
            elif btype == "tool_use":
                rows.append({
                    "type": "tool_call",
                    "id": block.get("id", ""),
                    "name": block.get("name", ""),
                    "arguments": block.get("input") or {},
                })
            elif btype == "tool_result":
                result_content = block.get("content", "")
                if isinstance(result_content, list):
                    result_content = " ".join(
                        b.get("text", "") for b in result_content if isinstance(b, dict)
                    )
                rows.append({
                    "type": "tool_result",
                    "tool_call_id": block.get("tool_use_id", ""),
                    "content": result_content,
                })
    return rows


def _extract_total_tokens_from_transcript(rows: List[Dict[str, Any]]) -> Optional[int]:
    """Return total_tokens from the usage row appended by agent_driver, or None."""
    for row in rows:
        if row.get("type") == "usage" and isinstance(row.get("total_tokens"), int):
            return row["total_tokens"]
    return None


def _parse_tool_calls_from_transcript(rows: List[Dict[str, Any]]) -> List[ToolCallEntry]:
    """Build paired ToolCallEntry list from normalised transcript rows."""
    # Index tool_call rows by id first, then attach matching tool_result rows.
    calls: Dict[str, ToolCallEntry] = {}
    order: List[str] = []
    for row in rows:
        rtype = row.get("type", "")
        if rtype == "tool_call":
            call_id = str(row.get("id") or "")
            args = row.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {"_raw": args}
            entry = ToolCallEntry(
                id=call_id or f"tc_{len(calls)}",
                name=str(row.get("name") or "unknown"),
                arguments=args if isinstance(args, dict) else {},
            )
            calls[call_id] = entry
            order.append(call_id)
        elif rtype == "tool_result":
            call_id = str(row.get("tool_call_id") or "")
            if call_id in calls:
                result = row.get("content")
                calls[call_id] = ToolCallEntry(
                    id=calls[call_id].id,
                    name=calls[call_id].name,
                    arguments=calls[call_id].arguments,
                    result=result,
                )
    return [calls[cid] for cid in order if cid in calls]


def _make_run_summary(row: Any) -> RunSummary:
    d = row_to_dict(row)
    status_value = str(d.get("status") or "").lower()
    status_aliases = {
        "approved": RunStatus.COMPLETED.value,
        "success": RunStatus.COMPLETED.value,
        "rejected": RunStatus.FAILED.value,
        "error": RunStatus.FAILED.value,
        "cancelled": RunStatus.FAILED.value,
    }
    normalized_status = status_aliases.get(status_value, status_value or RunStatus.FAILED.value)
    return RunSummary(
        id=d["id"],
        worker_id=d["worker_id"],
        worker_name=d.get("worker_name"),
        status=RunStatus(normalized_status),
        trigger_source=d["trigger_source"],
        created_at=d.get("created_at"),
        started_at=d.get("started_at"),
        completed_at=d.get("completed_at"),
        duration_ms=d.get("duration_ms"),
        error=_operator_error_message(d.get("error"), d.get("error_code")),
        error_code=d.get("error_code"),
    )


def _extract_primary_output_file(output_payload: Dict[str, Any]) -> Optional[tuple[str, bytes]]:
    def _decode_data_uri(value: str) -> Optional[tuple[bytes, Optional[str]]]:
        if not value.startswith("data:") or ";base64," not in value:
            return None
        header, _, encoded = value.partition(",")
        if not encoded:
            return None
        media_type = "application/octet-stream"
        if ":" in header:
            media_type = header.split(":", 1)[1].split(";", 1)[0] or media_type
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except Exception:
            return None
        guessed = mimetypes.guess_extension(media_type) or ".bin"
        return decoded, guessed

    def _decode_entry(entry: Any) -> Optional[tuple[str, bytes]]:
        if isinstance(entry, str):
            maybe_uri = _decode_data_uri(entry)
            if maybe_uri:
                payload, ext = maybe_uri
                return (f"output{ext or '.bin'}", payload)
            return None
        if not isinstance(entry, dict):
            return None
        b64_value = None
        for key in ("content_base64", "data_base64", "base64", "data"):
            value = entry.get(key)
            if isinstance(value, str) and value:
                b64_value = value
                break
        if not b64_value:
            return None
        maybe_uri = _decode_data_uri(b64_value)
        if maybe_uri:
            payload, ext = maybe_uri
            filename = entry.get("filename") if isinstance(entry.get("filename"), str) else None
            if filename:
                ext = Path(filename).suffix or ext
            return (f"output{ext or '.bin'}", payload)
        try:
            payload = base64.b64decode(b64_value, validate=True)
        except Exception:
            return None
        filename = entry.get("filename") if isinstance(entry.get("filename"), str) else ""
        if filename:
            ext = Path(filename).suffix or ".bin"
        else:
            content_type = (
                entry.get("content_type")
                if isinstance(entry.get("content_type"), str)
                else entry.get("mime_type")
                if isinstance(entry.get("mime_type"), str)
                else ""
            )
            ext = mimetypes.guess_extension(content_type) if content_type else None
            ext = ext or ".bin"
        return (f"output{ext}", payload)

    for key in ("primary_output", "output_artifact", "artifact", "file"):
        if key in output_payload:
            decoded = _decode_entry(output_payload.get(key))
            if decoded:
                return decoded
    for value in output_payload.values():
        decoded = _decode_entry(value)
        if decoded:
            return decoded
    return None
