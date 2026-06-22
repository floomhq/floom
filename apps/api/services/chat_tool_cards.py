"""Tool-card / chat-event rendering pipeline.

Builds the redacted argument previews, tool-card metadata, and chat-event
envelopes streamed to the UI. Extracted verbatim from chat_service.py; the few
chat_service-owned symbols it needs (CHAT_EVENT_* protocol constants, the
approvals base URL + public-token signer) are imported lazily inside the two
functions that use them, so there is no module-load circular import. chat_service
re-imports these names for backward compatibility.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from services.chat_sanitize import (
    _arg_key_tokens,
    _is_sensitive_arg_key,
    _looks_sensitive_string,
    _redacted_marker,
    _safe_json_dumps,
    _sanitize_preview_text,
)

ARGS_PREVIEW_MAX_STRING = 240
ARGS_PREVIEW_MAX_ITEMS = 12
ARGS_PREVIEW_MAX_DEPTH = 4

# Arg names whose values are large content bodies (previewed by length, never inlined).
_CONTENT_ARG_KEYS = {
    "content",
    "file_content",
    "body",
    "text",
    "markdown",
    "yaml_text",
    "worker_yml",
    "run_py",
    "skill_md",
    "code",
    "value",
}


def _looks_like_large_markup(key: str, value: str) -> bool:
    lower_key = key.lower()
    if lower_key in {"yaml_text", "worker_yml"}:
        return True
    if len(value.encode("utf-8")) > ARGS_PREVIEW_MAX_STRING:
        return True
    stripped = value.lstrip()
    return stripped.startswith(("schema_version:", "name:", "---", "```"))


def _preview_scalar(value: Any, *, key: str = "") -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = str(value)
    if key.lower() in {"content", "file_content", "run_py", "skill_md", "code"}:
        return _redacted_marker("file content", text)
    if _looks_sensitive_string(text):
        return _redacted_marker("secret-like value", text)
    text = _sanitize_preview_text(text)
    if _looks_like_large_markup(key, text):
        return {
            "redacted": True,
            "reason": "large or structured content",
            "bytes": len(text.encode("utf-8", errors="replace")),
            "chars": len(text),
        }
    if len(text) > ARGS_PREVIEW_MAX_STRING:
        return {
            "preview": text[:ARGS_PREVIEW_MAX_STRING] + "...",
            "truncated": True,
            "chars": len(text),
        }
    return text


def build_args_preview(tool_name: str, args: Any) -> Any:
    """Return a renderable, secret-free summary of tool arguments."""
    def _walk(value: Any, key: str = "", depth: int = 0) -> Any:
        key_lower = _arg_key_tokens(key)
        if key_lower == "value" and tool_name == "secrets__set":
            return _redacted_marker("secret value", value)
        if _is_sensitive_arg_key(key):
            return _redacted_marker("sensitive field", value)
        if key_lower in _CONTENT_ARG_KEYS and isinstance(value, str):
            return _preview_scalar(value, key=key_lower)
        if depth >= ARGS_PREVIEW_MAX_DEPTH:
            return _redacted_marker("max depth", value)
        if isinstance(value, dict):
            preview: Dict[str, Any] = {}
            for idx, item_key in enumerate(sorted(value.keys(), key=str)):
                if idx >= ARGS_PREVIEW_MAX_ITEMS:
                    preview["_truncated"] = True
                    preview["_remaining_keys"] = len(value) - idx
                    break
                preview[str(item_key)] = _walk(value[item_key], str(item_key), depth + 1)
            return preview
        if isinstance(value, list):
            items = [_walk(item, key, depth + 1) for item in value[:ARGS_PREVIEW_MAX_ITEMS]]
            if len(value) > ARGS_PREVIEW_MAX_ITEMS:
                items.append({"truncated": True, "remaining_items": len(value) - ARGS_PREVIEW_MAX_ITEMS})
            return items
        return _preview_scalar(value, key=key)

    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            return _preview_scalar(args, key="arguments")
    return _walk(args)


def _preview_result(result: Any) -> Any:
    if isinstance(result, dict):
        return build_args_preview("tool-result", result)
    return _preview_scalar(result, key="result")


def _card_kind_for_tool(tool_name: str) -> str:
    if tool_name == "workers__list_all":
        return "worker-list"
    if tool_name == "workers__run":
        return "run"
    if tool_name.startswith("workers__"):
        return "worker"
    if tool_name.startswith("runs__"):
        return "run"
    if tool_name.startswith("secrets__"):
        return "secret"
    if tool_name.startswith("connections__"):
        return "connection"
    if tool_name.startswith("contexts__") or tool_name.startswith("brain__"):
        return "brain"
    if tool_name.startswith("approvals__"):
        return "approval"
    if tool_name.startswith("slack__"):
        return "slack"
    return "tool"


def _tool_title(tool_name: str, args_preview: Any) -> str:
    if tool_name == "workers__list_all":
        return "List workers"
    if tool_name == "workers__run":
        return "Run worker"
    if tool_name == "workers__create_from_prompt":
        return "Create worker from prompt"
    if tool_name == "workers__create":
        return "Create worker from YAML"
    if tool_name == "secrets__set":
        name = args_preview.get("name") if isinstance(args_preview, dict) else None
        return f"Set secret {name}" if name else "Set secret"
    return tool_name.replace("__", ".").replace("_", " ")


def _tool_resource(tool_name: str, payload: Any) -> Optional[Dict[str, Any]]:
    from chat_service import _APPROVALS_BASE_URL, _approval_public_token
    if not isinstance(payload, dict):
        return None
    nested_run = payload.get("run") if isinstance(payload.get("run"), dict) else {}
    worker_id = (
        payload.get("worker_id")
        or nested_run.get("worker_id")
        or payload.get("id")
    )
    run_id = payload.get("run_id") or nested_run.get("run_id") or nested_run.get("id")
    if tool_name == "workers__create_from_prompt":
        worker_id = payload.get("worker_id") or "worker-author"
    if run_id:
        return {"kind": "run", "worker_id": worker_id, "run_id": run_id}
    if worker_id and tool_name.startswith("workers__"):
        return {"kind": "worker", "worker_id": worker_id}
    return None


def _tool_streams(resource: Optional[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    if not resource or not resource.get("run_id"):
        return None
    run_id = str(resource["run_id"])
    return {"events": f"/runs/{run_id}/events", "parts": f"/runs/{run_id}/stream"}


def _tool_actions(tool_name: str, resource: Optional[Dict[str, Any]], status: str) -> List[Dict[str, Any]]:
    actions: List[Dict[str, Any]] = []
    if resource and resource.get("run_id"):
        run_id = str(resource["run_id"])
        actions.append(
            {
                "id": "open_run",
                "label": "View run",
                "method": "GET",
                "href": f"/runs/{run_id}?tab=logs",
            }
        )
        if status in {"starting", "running", "queued"}:
            actions.append({"id": "cancel_run", "method": "POST", "href": f"/runs/{run_id}/cancel"})
    if resource and resource.get("worker_id") and status == "completed":
        worker_id = str(resource["worker_id"])
        if worker_id != "worker-author":
            actions.append({"id": "open_worker", "method": "GET", "href": f"/workers/{worker_id}"})
            actions.append({"id": "edit_worker", "method": "GET", "href": f"/workers/{worker_id}?edit=1"})
    if resource and resource.get("approval_id"):
        run_id = str(resource.get("run_id") or "")
        if run_id:
            actions.append({"id": "approve", "method": "POST", "href": f"/runs/{run_id}/approve"})
            actions.append({"id": "reject", "method": "POST", "href": f"/runs/{run_id}/reject"})
    if resource and resource.get("kind") == "connection":
        app_name = str(resource.get("app_name") or "")
        body: Dict[str, str] = {"app_name": app_name} if app_name else {}
        actions.append({"id": "connect", "method": "POST", "href": "/connections", "body": body})
    if tool_name == "secrets__set":
        actions.append({"id": "open_secrets", "method": "GET", "href": "/settings/secrets"})
    return actions


def _action_required_reason(tool_name: str, result: Any, resource: Optional[Dict[str, Any]]) -> Optional[str]:
    if isinstance(resource, dict) and resource.get("approval_id") and tool_name != "approvals__list_pending":
        return "approval_required"
    if isinstance(result, dict):
        code = str(result.get("error_code") or result.get("error") or "")
        lowered = code.lower()
        if "missing_connection" in lowered or ("connection" in lowered and not result.get("ok", True)):
            return "missing_connection"
        if "missing_secret" in lowered or ("secret" in lowered and not result.get("ok", True)):
            return "missing_secret"
    return None


def build_tool_event_metadata(
    tool_name: str,
    call_id: str,
    *,
    args: Any = None,
    result: Any = None,
    phase: str,
) -> Dict[str, Any]:
    from chat_service import (
        CHAT_EVENT_PROTOCOL_VERSION,
        CHAT_EVENT_VERSION,
    )
    from core.approval_signing import try_approval_review_url
    args_preview = build_args_preview(tool_name, args)
    status = "starting" if phase == "call" else "completed"
    if phase == "result" and isinstance(result, dict) and not result.get("ok", True):
        status = "failed"
    if phase == "result" and isinstance(result, dict) and result.get("ok", True) and result.get("run_id"):
        status = "running"
    payload_for_resource = result if phase == "result" else args
    resource = _tool_resource(tool_name, payload_for_resource)
    if not resource and isinstance(result, dict):
        resource = _tool_resource(tool_name, result)
    if (
        resource
        and resource.get("kind") == "run"
        and not resource.get("worker_id")
        and isinstance(args, dict)
        and args.get("id")
    ):
        resource["worker_id"] = str(args["id"])
    approval_actions: List[Dict[str, Any]] = []
    if tool_name == "approvals__list_pending" and isinstance(result, dict):
        approvals = result.get("approvals") if isinstance(result.get("approvals"), list) else []
        if approvals:
            first = approvals[0]
            if isinstance(first, dict):
                for approval in approvals:
                    if not isinstance(approval, dict):
                        continue
                    approval_id = str(approval.get("id") or "").strip()
                    if not approval_id:
                        continue
                    # DEGRADE, never 503: omit the "Open review" deep-link action
                    # when no signer secret is configured (e.g. hosted mode) instead
                    # of crashing the card render. The card still shows the pending
                    # approval; only the optional signed deep link is dropped.
                    # Shared helper is the single source of truth for the host +
                    # token shape (id/run_id/owner_id validated inside).
                    href = try_approval_review_url(approval)
                    if not href:
                        continue
                    approval_actions.append(
                        {
                            "id": f"open_review_{approval_id}",
                            "label": "Open review",
                            "method": "GET",
                            "href": href,
                        }
                    )
                resource = {
                    "kind": "approval",
                    "approval_id": first.get("id"),
                    "run_id": first.get("run_id"),
                    "worker_id": first.get("worker_id"),
                    "count": result.get("count") or len(approvals),
                }
                status = "pending_approval"
    reason = _action_required_reason(tool_name, result, resource)
    if reason:
        status = "action_required"
        if not resource and reason == "missing_connection":
            app_name = ""
            if isinstance(result, dict):
                app_name = str(result.get("app_name") or result.get("connection") or "")
            if isinstance(args, dict) and not app_name:
                app_name = str(args.get("app_name") or args.get("connection") or "")
            resource = {"kind": "connection", "app_name": app_name or None, "status": "missing"}
        if not resource and reason == "missing_secret":
            secret_name = ""
            if isinstance(result, dict):
                secret_name = str(result.get("secret_name") or result.get("name") or "")
            if isinstance(args, dict) and not secret_name:
                secret_name = str(args.get("name") or "")
            resource = {"kind": "secret", "name": secret_name or None, "status": "missing"}
    card_id = f"card_{call_id}" if not str(call_id).startswith("card_") else str(call_id)
    title = _tool_title(tool_name, args_preview)
    if tool_name == "approvals__list_pending" and approval_actions and status == "pending_approval":
        title = "Pending approvals"
    card = {
        "id": card_id,
        "kind": _card_kind_for_tool(tool_name),
        "title": title,
        "status": status,
    }
    streams = _tool_streams(resource)
    actions = approval_actions or _tool_actions(tool_name, resource, status)
    return {
        "protocol": CHAT_EVENT_PROTOCOL_VERSION,
        "version": CHAT_EVENT_VERSION,
        "card": card,
        "resource": resource,
        "streams": streams,
        "actions": actions,
        "args_preview": args_preview,
        "result_preview": _preview_result(result) if phase == "result" else None,
        "reason": reason,
    }


def normalize_tool_args_for_event(tool_name: str, args: Any) -> Any:
    from chat_service import strip_em_dashes

    if (
        tool_name == "finish_with_outputs"
        and isinstance(args, dict)
        and isinstance(args.get("reply"), str)
    ):
        return {**args, "reply": _sanitize_preview_text(strip_em_dashes(args["reply"]))}
    return args


