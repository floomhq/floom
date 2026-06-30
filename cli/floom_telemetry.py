"""Fail-open PostHog telemetry for the Floom Python CLI."""

from __future__ import annotations

import hashlib
import json
import os
import platform
from datetime import datetime, timezone
from pathlib import Path
from urllib import request


POSTHOG_CAPTURE_TIMEOUT = 0.75


def emit_cli_command(
    *,
    command: str,
    ok: bool,
    duration_ms: int,
    cli_version: str,
    no_telemetry: bool = False,
    workspace_id: str | None = None,
) -> None:
    """Send a privacy-safe CLI command event, swallowing all telemetry errors."""
    try:
        if no_telemetry or _do_not_track_enabled():
            return

        api_key = os.environ.get("POSTHOG_KEY") or os.environ.get("NEXT_PUBLIC_POSTHOG_KEY")
        if not api_key:
            return

        properties: dict[str, object] = {
            "command": command,
            "ok": ok,
            "duration_ms": duration_ms,
            "cli_version": cli_version,
            "source": "cli",
        }
        if workspace_id:
            properties["$groups"] = {"workspace": workspace_id}

        payload = {
            "api_key": api_key,
            "event": "cli_command",
            "distinct_id": _distinct_id(),
            "properties": properties,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        host = os.environ.get("POSTHOG_HOST", "https://us.posthog.com").rstrip("/")
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(
            f"{host}/capture/",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=POSTHOG_CAPTURE_TIMEOUT):
            pass
    except Exception:
        return


def _do_not_track_enabled() -> bool:
    return os.environ.get("DO_NOT_TRACK", "").lower() in {"1", "true"}


def _distinct_id() -> str:
    cached = _read_cached_distinct_id()
    if cached:
        return cached

    raw = f"{platform.node()}:{Path.home()}"
    anonymous_id = "anon_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    _write_cached_distinct_id(anonymous_id)
    return anonymous_id


def _config_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    if base:
        return Path(base) / "floom"
    return Path.home() / ".config" / "floom"


def _cache_path() -> Path:
    return _config_dir() / "cli_telemetry_id"


def _read_cached_distinct_id() -> str | None:
    try:
        value = _cache_path().read_text(encoding="utf-8").strip()
        return value or None
    except Exception:
        return None


def _write_cached_distinct_id(value: str) -> None:
    try:
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")
    except Exception:
        return
