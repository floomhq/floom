"""Structured, secret-safe observability for the cloud API.

One place to configure logging so the whole app gets, for free:

1. **Request/run correlation.** ``request_id``, ``workspace_id``, ``user_id`` and
   ``run_id`` are bound to contextvars (by middleware / the run executor) and
   auto-injected into every log line — so you can grep one request or one run
   end-to-end across modules and threads (``asyncio.to_thread`` copies context).

2. **Secret redaction.** A formatter-level filter scrubs common credential shapes
   (JWTs, ``sk-``/``ghp_``/``sbp_`` tokens, AWS keys, ``Bearer`` headers, creds in
   URLs) from the FINAL formatted line — defence in depth, so an accidental
   ``logger.info("got %s", token)`` can never leak. This does NOT replace the rule
   "don't log secret values" — it's the backstop.

3. **Reliable output.** ``logging.StreamHandler`` flushes per record, so logs
   appear even without ``PYTHONUNBUFFERED`` (the engine's ``print()`` calls do
   buffer — prefer ``get_logger`` over ``print``).

Convention (see also docs):
  * Real failure that breaks a feature  -> ``logger.error`` / ``log_failure`` (exc_info).
  * Recoverable / degraded path          -> ``logger.warning``.
  * Routine lifecycle / state            -> ``logger.info``.
  * Verbose tracing                      -> ``logger.debug`` (off in prod).
  * NEVER swallow an exception at debug and return success. If a thing failed,
    say so at WARNING/ERROR. Silent ``except: ... debug()`` is the bug this exists
    to kill (#319).
"""
from __future__ import annotations

import contextlib
import contextvars
import logging
import os
import re
import sys
from typing import Any, Iterator, Optional

# ---------------------------------------------------------------------------
# Correlation context (bound per request / per run; propagates via to_thread)
# ---------------------------------------------------------------------------

_request_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("obs_request_id", default=None)
_workspace_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("obs_workspace_id", default=None)
_user_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("obs_user_id", default=None)
_run_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("obs_run_id", default=None)

_FIELDS = {
    "request_id": _request_id,
    "workspace_id": _workspace_id,
    "user_id": _user_id,
    "run_id": _run_id,
}


def set_context(**fields: Optional[str]) -> None:
    """Bind correlation fields for the current context (request/run/thread).

    Only known fields are honoured; unknown keys are ignored. Values are
    stringified and truncated. Safe to call repeatedly (e.g. user_id once auth
    resolves). Does not unbind on its own — use :func:`bound` for scoping.
    """
    for key, value in fields.items():
        var = _FIELDS.get(key)
        if var is not None and value is not None:
            var.set(str(value)[:128])


@contextlib.contextmanager
def bound(**fields: Optional[str]) -> Iterator[None]:
    """Scope correlation fields, restoring the previous values on exit."""
    tokens = []
    for key, value in fields.items():
        var = _FIELDS.get(key)
        if var is not None:
            tokens.append((var, var.set(None if value is None else str(value)[:128])))
    try:
        yield
    finally:
        for var, tok in reversed(tokens):
            var.reset(tok)


def current_context() -> dict[str, str]:
    return {k: v.get() for k, v in _FIELDS.items() if v.get()}  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Secret redaction (defence-in-depth; applied to the final formatted line)
# ---------------------------------------------------------------------------

# Each pattern matches a credential shape; the matched run is replaced with a
# short masked token. Tuned to be aggressive on shape, not on field names, so it
# survives reformatting and string interpolation.
_SECRET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JWT
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),                                       # OpenAI
    re.compile(r"\bsk-proj-[A-Za-z0-9_-]{16,}"),                                  # OpenAI project
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),                                  # GitHub PAT/OAuth
    re.compile(r"\bsbp_[A-Za-z0-9]{20,}"),                                        # Supabase mgmt token
    re.compile(r"\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{12,}"),                # Supabase API keys
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                                          # AWS access key id
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._-]{8,}"),                             # Bearer <token>
    re.compile(r"(?i)\b(?:apikey|api[_-]?key|authorization|password|passwd|secret|token|service_role)\b\s*[:=]\s*[^\s,;'\"]{6,}"),
    re.compile(r"://[^\s/:@]+:[^\s/@]{6,}@"),                                      # creds in URL
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),                                # Slack tokens
]


def redact(text: str) -> str:
    if not text:
        return text
    out = text
    for pat in _SECRET_PATTERNS:
        out = pat.sub(_mask, out)
    return out


def _mask(m: "re.Match[str]") -> str:
    s = m.group(0)
    # Keep a tiny prefix for debuggability, mask the rest.
    head = s[:6]
    return f"{head}…[REDACTED]"


class _ContextFilter(logging.Filter):
    """Attach correlation fields to every record (empty string when unset)."""

    def filter(self, record: logging.LogRecord) -> bool:
        ctx = current_context()
        for key in _FIELDS:
            setattr(record, key, ctx.get(key, ""))
        # Compact "[k=v k=v]" suffix for human-readable handlers.
        record.ctx = (" [" + " ".join(f"{k}={v}" for k, v in ctx.items()) + "]") if ctx else ""  # type: ignore[attr-defined]
        return True


class _RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


# ---------------------------------------------------------------------------
# Setup + accessors
# ---------------------------------------------------------------------------

_CONFIGURED = False


def setup_logging(level: Optional[str] = None) -> None:
    """Install the cloud log handler on the root logger (idempotent).

    Routes everything through one stdout handler with the context filter +
    redacting formatter. Leaves uvicorn's own access logger alone. Call once,
    early, at process startup.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return
    lvl = (level or os.environ.get("WORKEROS_LOG_LEVEL") or "INFO").upper()

    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(_ContextFilter())
    handler.setFormatter(
        _RedactingFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s%(ctx)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )
    )

    root = logging.getLogger()
    # Replace any pre-existing root handlers so we don't double-log.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(getattr(logging, lvl, logging.INFO))

    # Keep noisy third-party loggers from flooding at our level.
    for noisy in ("httpx", "httpcore", "hpack", "urllib3", "postgrest", "websockets"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Preferred logger accessor. Equivalent to ``logging.getLogger`` but the
    canonical entry point so call sites are greppable and inherit central config.
    """
    return logging.getLogger(name)


def log_failure(
    logger: logging.Logger,
    msg: str,
    *args: Any,
    exc_info: bool = True,
    **fields: Any,
) -> None:
    """Log a real failure at ERROR with exception info and structured fields.

    Use at ``except`` sites that previously swallowed-and-continued silently.
    Logging is best-effort and never raises.
    """
    try:
        suffix = ("".join(f" {k}={v}" for k, v in fields.items())) if fields else ""
        logger.error(msg + suffix, *args, exc_info=exc_info)
    except Exception:  # logging must never break the caller
        pass
