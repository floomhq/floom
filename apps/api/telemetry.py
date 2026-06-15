from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx

from apps.api.config import get_supabase_service_client


logger = logging.getLogger(__name__)

MAX_EVENTS_PER_REQUEST = 50
MAX_PROPERTIES = 40
MAX_PROPERTY_KEY_LENGTH = 64
MAX_STRING_LENGTH = 500
MAX_LIST_LENGTH = 25
MAX_DEPTH = 4
VALID_SOURCES = {"web", "api", "cli", "worker", "system"}

EVENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_.:-]{1,96}$")
SENSITIVE_KEY_RE = re.compile(
    r"(authorization|bearer|cookie|credential|jwt|key|oauth|password|refresh|secret|session|token)",
    re.IGNORECASE,
)
EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
TOKEN_RE = re.compile(
    r"\b(floom_[A-Za-z0-9_-]{12,}|[A-Fa-f0-9]{40,}|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_.-]{16,})\b"
)


class TelemetryError(ValueError):
    pass


def hash_identifier(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    return hashlib.sha256(text.encode()).hexdigest()[:24]


def validate_event_name(name: str) -> str:
    value = name.strip()
    if not EVENT_NAME_RE.match(value):
        raise TelemetryError("event_name must be lowercase dot/colon/dash/underscore text")
    return value


def _redact_string(value: str) -> str:
    text = EMAIL_RE.sub("[redacted-email]", value)
    text = TOKEN_RE.sub("[redacted-token]", text)
    if len(text) > MAX_STRING_LENGTH:
        return text[:MAX_STRING_LENGTH] + "..."
    return text


def _safe_property_key(key: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_.:-]", "_", key.strip())[:MAX_PROPERTY_KEY_LENGTH]
    return normalized or "property"


def sanitize_properties(value: Any, *, _depth: int = 0) -> Any:
    if _depth > MAX_DEPTH:
        return "[truncated]"
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value
    if isinstance(value, str):
        return _redact_string(value)
    if isinstance(value, list | tuple):
        return [sanitize_properties(item, _depth=_depth + 1) for item in list(value)[:MAX_LIST_LENGTH]]
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for raw_key, raw_item in list(value.items())[:MAX_PROPERTIES]:
            key = _safe_property_key(str(raw_key))
            if SENSITIVE_KEY_RE.search(key):
                sanitized[key] = "[redacted]"
            else:
                sanitized[key] = sanitize_properties(raw_item, _depth=_depth + 1)
        return sanitized
    return _redact_string(str(value))


def _iso_timestamp(value: datetime | None = None) -> str:
    ts = value or datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc).isoformat()


def _posthog_config() -> tuple[str, str] | None:
    key = (os.environ.get("POSTHOG_KEY") or os.environ.get("NEXT_PUBLIC_POSTHOG_KEY") or "").strip()
    host = (os.environ.get("POSTHOG_HOST") or os.environ.get("NEXT_PUBLIC_POSTHOG_HOST") or "").strip()
    if not key:
        return None
    return key, (host or "https://us.i.posthog.com").rstrip("/")


def capture_posthog_event(
    *,
    distinct_id: str,
    event_name: str,
    properties: dict[str, Any] | None = None,
    timestamp: str | None = None,
) -> None:
    config = _posthog_config()
    if config is None:
        return
    key, host = config
    try:
        event = validate_event_name(event_name)
    except TelemetryError:
        logger.warning("invalid PostHog event skipped: %s", event_name)
        return

    try:
        httpx.post(
            f"{host}/capture/",
            json={
                "api_key": key,
                "event": event,
                "distinct_id": distinct_id,
                "properties": sanitize_properties(properties or {}),
                **({"timestamp": timestamp} if timestamp else {}),
            },
            timeout=2.0,
        ).raise_for_status()
    except Exception as exc:
        logger.warning(
            "PostHog capture failed for event %s: %s: %s",
            event_name,
            type(exc).__name__,
            exc,
        )


def telemetry_enabled(*, workspace_id: str) -> bool:
    response = (
        get_supabase_service_client()
        .table("telemetry_preferences")
        .select("product_telemetry_enabled")
        .eq("workspace_id", workspace_id)
        .limit(1)
        .execute()
    )
    data = getattr(response, "data", None) or []
    if not data:
        return True
    return bool(data[0].get("product_telemetry_enabled", True))


def set_telemetry_enabled(*, user_id: str, workspace_id: str, enabled: bool) -> dict[str, Any]:
    payload = {
        "workspace_id": workspace_id,
        "user_id": user_id,
        "product_telemetry_enabled": bool(enabled),
        "updated_at": _iso_timestamp(),
    }
    response = (
        get_supabase_service_client()
        .table("telemetry_preferences")
        .upsert(payload, on_conflict="workspace_id")
        .execute()
    )
    data = getattr(response, "data", None) or [payload]
    return dict(data[0] if isinstance(data, list) and data else payload)


def record_events(
    *,
    user_id: str,
    workspace_id: str,
    events: list[dict[str, Any]],
) -> int:
    if len(events) > MAX_EVENTS_PER_REQUEST:
        raise TelemetryError(f"at most {MAX_EVENTS_PER_REQUEST} events can be recorded at once")
    if not telemetry_enabled(workspace_id=workspace_id):
        return 0

    rows: list[dict[str, Any]] = []
    for event in events:
        event_name = validate_event_name(str(event.get("event_name") or ""))
        source = str(event.get("source") or "web")
        if source not in VALID_SOURCES:
            raise TelemetryError("source must be web, api, cli, worker, or system")
        rows.append(
            {
                "user_id": user_id,
                "workspace_id": workspace_id,
                "event_name": event_name,
                "event_version": int(event.get("event_version") or 1),
                "source": source,
                "session_id_hash": hash_identifier(event.get("session_id")),
                "properties": sanitize_properties(event.get("properties") or {}),
                "occurred_at": _iso_timestamp(event.get("occurred_at")),
            }
        )
    if not rows:
        return 0
    response = get_supabase_service_client().table("telemetry_events").insert(rows).execute()
    data = getattr(response, "data", None)
    for row in rows:
        capture_posthog_event(
            distinct_id=user_id,
            event_name=str(row["event_name"]),
            timestamp=str(row["occurred_at"]),
            properties={
                **dict(row["properties"] or {}),
                "workspace_id": workspace_id,
                "source": row["source"],
            },
        )
    return len(data) if isinstance(data, list) else len(rows)


def export_events(*, workspace_id: str, limit: int = 500) -> list[dict[str, Any]]:
    capped_limit = max(1, min(int(limit), 1000))
    response = (
        get_supabase_service_client()
        .table("telemetry_events")
        .select("id,event_name,event_version,source,session_id_hash,properties,occurred_at,created_at")
        .eq("workspace_id", workspace_id)
        .order("created_at", desc=False)
        .limit(capped_limit)
        .execute()
    )
    data = getattr(response, "data", None) or []
    return [dict(row) for row in data]


def delete_workspace_events(*, workspace_id: str) -> int:
    response = (
        get_supabase_service_client()
        .table("telemetry_events")
        .delete()
        .eq("workspace_id", workspace_id)
        .execute()
    )
    data = getattr(response, "data", None)
    return len(data) if isinstance(data, list) else 0
