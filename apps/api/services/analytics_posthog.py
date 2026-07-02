"""Server-side PostHog product analytics — fail-soft, non-blocking.

This is the single server entry point for emitting WorkerOS product-outcome
events to PostHog (run lifecycle, worker lifecycle, approvals). It is a thin
wrapper over ``posthog`` (posthog-python) with three hard contracts:

1. **Fail-soft.** When ``POSTHOG_API_KEY`` is unset (local dev, self-hosted,
   the test suite) the client is a no-op: ``capture_event`` returns immediately
   and nothing is sent. This keeps dev/self-hosted working with zero config:
   the build ships only inert wiring with no key and no destination, so nothing
   is collected unless an operator sets their own key.
2. **Never raises.** posthog-python's ``capture`` is already wrapped in a
   ``@no_throw`` decorator, but we additionally guard init + every call in a
   ``try/except`` that logs and swallows. Telemetry must NEVER fail a run.
3. **Non-blocking.** posthog-python batches on a background thread; ``capture``
   does not block the run executor. ``flush()`` is registered on FastAPI
   shutdown so buffered events survive a redeploy/restart.

Privacy: callers send sizes/flags/hashes (``*_bytes``, ``*_present``,
``*_count``, ``*_hash``), NEVER raw run input/output/transcript, secret
names/values, or connection tokens. Use ``hash_value`` for any identifier that
must be sent as a hash.

Property/event taxonomy is owned by ``posthog_event_contract`` (the single
source of truth for event/property names); error categories are owned by
``run_metrics.classify_failure`` and must never be hand-typed at a call site.
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
from contextvars import ContextVar, Token
from typing import Any, Dict, Optional

logger = logging.getLogger("floom.analytics")

# Schema version carried on every server event. Bump on a breaking property
# change; old + new rows coexist in HogQL.
SCHEMA_VERSION = 1

# Emitter tag so client (web) vs server events are unambiguous in HogQL.
EMITTER = "server"

_DEFAULT_HOST = "https://us.i.posthog.com"

_client: Optional[Any] = None
_init_lock = threading.Lock()
_init_attempted = False
_request_source: ContextVar[str] = ContextVar("floom_analytics_source", default="api")
_request_do_not_track: ContextVar[bool] = ContextVar("floom_analytics_do_not_track", default=False)
_ALLOWED_SOURCES = {"web", "api", "cli", "mcp", "schedule"}
_ANALYTICS_OPT_OUT_KEY = "analytics_opt_out"


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def normalize_source(value: Optional[str]) -> str:
    source = (value or "").strip().lower()
    return source if source in _ALLOWED_SOURCES else "api"


def current_source() -> str:
    return _request_source.get()


def set_request_context(*, source: Optional[str] = None, do_not_track: bool = False) -> tuple[Token[str], Token[bool]]:
    return (
        _request_source.set(normalize_source(source)),
        _request_do_not_track.set(bool(do_not_track)),
    )


def reset_request_context(tokens: tuple[Token[str], Token[bool]]) -> None:
    source_token, dnt_token = tokens
    _request_source.reset(source_token)
    _request_do_not_track.reset(dnt_token)


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _workspace_analytics_opted_out(workspace_id: str) -> bool:
    if not workspace_id:
        return False
    try:
        from db import get_db

        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ? LIMIT 1",
                (workspace_id, _ANALYTICS_OPT_OUT_KEY),
            ).fetchone()
        return bool(row and _truthy(row["value"]))
    except Exception:
        return False


def _workspace_id_from_groups(groups: Optional[Dict[str, str]]) -> str:
    if not groups:
        return ""
    return str(groups.get("workspace") or "").strip()


def _capture_suppressed(groups: Optional[Dict[str, str]]) -> bool:
    if _request_do_not_track.get():
        return True
    return _workspace_analytics_opted_out(_workspace_id_from_groups(groups))


def _on_delivery_error(error: Any, items: Any = None) -> None:
    """posthog-python ``on_error`` hook: a batch failed to deliver (4xx/5xx /
    queue drop). Route to the AI-obs delivery counter so the swallowed failure
    becomes a visible metric. Lazy import avoids an init-time circular import.
    Never raises."""
    try:
        from services.ai_observability import record_delivery_event

        n = 1
        try:
            n = max(1, len(items)) if items is not None else 1
        except Exception:
            n = 1
        record_delivery_event("emit_failed", n)
    except Exception:  # pragma: no cover - defensive
        logger.debug("PostHog on_error hook failed", exc_info=True)


def _get_client() -> Optional[Any]:
    """Lazily construct the module-level Posthog client.

    Returns ``None`` (no-op mode) when the API key is unset or the SDK / init
    fails. Construction is attempted at most once per process; a failed attempt
    stays a no-op rather than retrying on every event.
    """
    global _client, _init_attempted
    if _init_attempted:
        return _client
    with _init_lock:
        if _init_attempted:
            return _client
        _init_attempted = True
        api_key = _env("POSTHOG_API_KEY")
        if not api_key:
            logger.info("PostHog analytics disabled: POSTHOG_API_KEY unset (no-op).")
            _client = None
            return None
        host = _env("POSTHOG_HOST") or _DEFAULT_HOST
        try:
            from posthog import Posthog

            _client = Posthog(
                project_api_key=api_key,
                host=host,
                # Batch on a background thread; flush at 20 events or every 2s.
                flush_at=20,
                flush_interval=2,
                # Surface delivery failures (4xx/5xx, queue drops) the SDK would
                # otherwise swallow, so AI-obs delivery telemetry can count them.
                on_error=_on_delivery_error,
            )
            logger.info("PostHog analytics enabled (host=%s).", host)
        except Exception:  # pragma: no cover - defensive init guard
            logger.warning("PostHog analytics init failed; running no-op.", exc_info=True)
            _client = None
    return _client


def is_enabled() -> bool:
    """True when a live PostHog client is configured (key present + init ok)."""
    return _get_client() is not None


def hash_value(value: Optional[str], length: int = 24) -> str:
    """sha256[:length] of a string, for sending identifiers as opaque hashes.

    Used for secret names and any identifier that must not be sent in clear.
    Empty/None -> "".
    """
    text = (value or "").strip()
    if not text:
        return ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:length]


def _base_properties(extra: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    props: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "emitter": EMITTER,
        "source": _request_source.get(),
    }
    if extra:
        # Drop None-valued keys so PostHog property breakdowns stay clean, but
        # KEEP explicit nulls for the outcome fields the spec mandates as
        # "null unless failed" — those are passed through as None deliberately
        # only when the caller wants them; here we simply keep all provided keys
        # except those the caller set to the sentinel below.
        props.update(extra)
    props["$geoip_disable"] = True
    props["$ip"] = None
    return props


def capture_event(
    distinct_id: str,
    event: str,
    properties: Optional[Dict[str, Any]] = None,
    groups: Optional[Dict[str, str]] = None,
) -> None:
    """Emit a product event. No-op + swallow on any failure.

    Args:
        distinct_id: the owning user_id (person attribution). Required; a falsy
            value is dropped (no anonymous person bloat).
        event: snake_case product event name.
        properties: event properties. ``schema_version`` + ``emitter`` are
            injected automatically. NEVER pass raw payloads/secrets.
        groups: ``{"workspace": workspace_id}`` for per-workspace funnels.
    """
    client = _get_client()
    if client is None:
        return
    if _capture_suppressed(groups):
        return
    if not distinct_id:
        logger.debug("Dropping PostHog event %s: empty distinct_id", event)
        return
    try:
        client.capture(
            event,
            distinct_id=str(distinct_id),
            properties=_base_properties(properties),
            groups={k: str(v) for k, v in (groups or {}).items() if v},
        )
    except Exception:  # pragma: no cover - belt-and-suspenders; capture is @no_throw
        logger.debug("PostHog capture failed for %s", event, exc_info=True)


def identify_user(
    *,
    distinct_id: str,
    anonymous_distinct_id: str,
    properties: Optional[Dict[str, Any]] = None,
    groups: Optional[Dict[str, str]] = None,
) -> None:
    """Link a stable anonymous install id to the authenticated user id."""
    client = _get_client()
    if client is None:
        return
    if _capture_suppressed(groups):
        return
    if not distinct_id or not anonymous_distinct_id:
        return
    try:
        identify_props = {"$anon_distinct_id": str(anonymous_distinct_id)}
        if properties:
            identify_props.update(properties)
        client.capture(
            "$identify",
            distinct_id=str(distinct_id),
            properties=_base_properties(identify_props),
            groups={k: str(v) for k, v in (groups or {}).items() if v},
        )
    except Exception:  # pragma: no cover
        logger.debug("PostHog identify failed", exc_info=True)


def flush() -> None:
    """Flush buffered events. Safe to call when disabled. Never raises."""
    client = _get_client()
    if client is None:
        return
    try:
        client.flush()
    except Exception:  # pragma: no cover
        logger.debug("PostHog flush failed", exc_info=True)


def shutdown() -> None:
    """Flush + stop background threads on app shutdown. Never raises."""
    client = _get_client()
    if client is None:
        return
    try:
        client.shutdown()
    except Exception:  # pragma: no cover
        logger.debug("PostHog shutdown failed", exc_info=True)


def _reset_for_tests() -> None:
    """Test-only: clear the cached client so env changes re-init."""
    global _client, _init_attempted
    with _init_lock:
        _client = None
        _init_attempted = False
