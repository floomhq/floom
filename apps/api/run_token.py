"""Run-scoped capability tokens for sandbox workers.

Every run that executes inside a sandbox (E2B micro-VM) receives a short-lived
HMAC-signed token via the WORKEROS_RUN_TOKEN environment variable.  The token:

  - Proves the holder is a legitimate active run (tied to run_id).
  - Is accepted ONLY on /runs/{run_id}/composio-execute/* — every other API
    endpoint returns 403 when a run token is presented instead of the operator
    secret.  This makes it *cryptographically impossible* for sandboxed worker
    code to delete workers, modify other workers, or read secrets it was not
    explicitly given.
  - Expires after MAX_TTL_SECONDS (default 4 h — longer than any realistic run).

Token format (URL-safe, plain text):
    run:<run_id>:<hex_expires>.<hex_hmac_sha256>

where hex_expires is seconds-since-epoch as a zero-padded 10-char hex string
and hex_hmac_sha256 is the HMAC-SHA256 of "run:<run_id>:<hex_expires>" keyed
on FLOOM_SECRET (the operator API secret).

Design notes:
  - No database lookup on every sandbox API call — the HMAC is the proof.
  - The run_id in the token is still validated against the path parameter
    inside the composio-execute handler (existing logic), so a stolen token
    cannot be used for a *different* run's composio calls.
  - Token generation happens entirely server-side in run_service; the sandbox
    only ever sees the opaque token string.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets as _pysecrets
import time
from typing import Any, Callable

MAX_TTL_SECONDS = 14_400  # 4 hours


def make_run_token(run_id: str, *, secret: str | None = None) -> str:
    """Create a signed run capability token for a sandbox worker.

    Args:
        run_id: The run's unique identifier.
        secret: FLOOM_SECRET value.  Defaults to os.environ["FLOOM_SECRET"].

    Returns:
        An opaque token string to be set as WORKEROS_RUN_TOKEN in the sandbox.
    """
    if secret is None:
        secret = os.environ.get("FLOOM_SECRET", "")
    expires = int(time.time()) + MAX_TTL_SECONDS
    hex_expires = format(expires, "010x")
    data = f"run:{run_id}:{hex_expires}"
    sig = hmac.new(secret.encode(), data.encode(), hashlib.sha256).hexdigest()
    return f"{data}.{sig}"


def verify_run_token(token: str, *, secret: str | None = None) -> str | None:
    """Verify a run capability token.

    Args:
        token: Token string (from X-Workeros-Run-Token header).
        secret: FLOOM_SECRET value.  Defaults to os.environ["FLOOM_SECRET"].

    Returns:
        The run_id embedded in the token if valid and not expired, else None.
    """
    if not token:
        return None
    if secret is None:
        secret = os.environ.get("FLOOM_SECRET", "")
    if not secret:
        return None
    try:
        data, sig = token.rsplit(".", 1)
        _, run_id, hex_expires = data.split(":", 2)
        expires = int(hex_expires, 16)
        if expires < time.time():
            return None  # expired
        expected = hmac.new(secret.encode(), data.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None  # tampered
        return run_id
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Worker-to-worker call tokens
# ---------------------------------------------------------------------------
# These tokens are distinct from the composio sandbox tokens above.  They are
# issued to a *parent* run and injected as WORKEROS_RUN_TOKEN in the child
# subprocess's environment, enabling run.py workers to call other workers via
# the workeros.call_worker() helper.
#
# Token format:  wrt_<base64url-json-payload>.<hmac-sha256-hex>

WORKER_CALL_TOKEN_PREFIX = "wrt_"
MAX_CALL_DEPTH = 3


class WorkerCallDepthExceeded(ValueError):
    """#994: a worker-call token cannot be minted at or beyond MAX_CALL_DEPTH."""


def parse_call_depth(trigger_source: str | None) -> int:
    """#994: extract the worker-call depth a run is at from its trigger_source.

    Both call paths encode depth in trigger_source: agent ``invoke_worker:depth=N``
    and script/token ``worker_call:depth=N``. A run with no marker is the root
    (depth 0).
    """
    ts = str(trigger_source or "")
    for marker in ("worker_call:depth=", "invoke_worker:depth="):
        if ts.startswith(marker):
            try:
                return max(0, int(ts.split("=", 1)[1]))
            except (ValueError, IndexError):
                return 0
    return 0


class WorkerCallSecretMissing(ValueError):
    """Raised when no real signing secret is configured for worker-call tokens.

    #972: the old code fell back to a public constant ("dev-secret-not-set"),
    so any deployment without FLOOM_SECRET signed worker-call tokens with a
    key an attacker already knows — allowing forged wrt_ tokens and arbitrary
    call_worker() invocations. Fail closed instead of signing/validating with
    a guessable key.

    Subclasses ValueError so existing `except ValueError` validation handlers
    reject the token (401) rather than 500 on a misconfigured server, while
    the issue path surfaces it as a clear run failure.
    """


# #992: the worker-call signing secret is decoupled from FLOOM_SECRET so a
# multi-tenant host (managed-deployment) that deliberately strips FLOOM_SECRET (to
# keep the x-floom-secret gate off; auth is Supabase JWT/PAT) can still sign
# wrt_ tokens with a real secret. Resolution order:
#   1. explicit `secret` arg
#   2. registered resolver (host sets it at startup; mirrors
#      contexts.set_context_scope_resolver)
#   3. WORKEROS_WORKER_CALL_SECRET env var
#   4. FLOOM_SECRET env var (OSS default)
#   5. none -> raise (preserves #972 fail-closed: never sign with a constant)
_worker_call_secret_resolver: "Callable[[], str | None] | None" = None


def set_worker_call_secret_resolver(resolver: "Callable[[], str | None] | None") -> None:
    """Register a callable returning the worker-call signing secret, or None.

    The host (e.g. managed-deployment) registers this at startup so wrt_ tokens are
    signed with a real secret derived from its own config, without re-enabling
    the FLOOM_SECRET / x-floom-secret gate. Pass None to clear (OSS mode).
    """
    global _worker_call_secret_resolver
    _worker_call_secret_resolver = resolver


def _worker_call_signing_key(secret: str | None = None) -> str:
    candidate = secret
    if candidate is None and _worker_call_secret_resolver is not None:
        try:
            candidate = _worker_call_secret_resolver()
        except Exception:
            candidate = None
    if candidate is None:
        candidate = os.environ.get("WORKEROS_WORKER_CALL_SECRET") or os.environ.get("FLOOM_SECRET")
    key = (candidate or "").strip()
    if not key:
        raise WorkerCallSecretMissing(
            "No worker-call signing secret is configured. Set "
            "WORKEROS_WORKER_CALL_SECRET (or FLOOM_SECRET), or register a "
            "resolver via set_worker_call_secret_resolver(); worker-call tokens "
            "are never signed with a public constant (#972)."
        )
    return key


def _wrt_b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _wrt_b64url_decode(value: str) -> bytes:
    padded = value + "=" * (4 - len(value) % 4)
    return base64.urlsafe_b64decode(padded)


def issue_worker_call_token(
    *,
    user_id: str,
    parent_run_id: str,
    callable_workers: list[str],
    depth: int = 0,
    ttl_seconds: int = 3600,
    secret: str | None = None,
) -> str:
    """Issue a signed token that allows a run to invoke specific child workers."""
    # #994: cap worker-to-worker recursion. A token at or beyond MAX_CALL_DEPTH
    # may not be minted, so a chain of script workers calling each other
    # (call_worker) cannot recurse without bound.
    if depth > MAX_CALL_DEPTH:
        raise WorkerCallDepthExceeded(
            f"Worker call depth {depth} exceeds the cap ({MAX_CALL_DEPTH}); "
            "cannot issue a worker-call token this deep."
        )
    payload: dict[str, Any] = {
        "user_id": user_id,
        "parent_run_id": parent_run_id,
        "callable_workers": callable_workers,
        "depth": depth,
        "nonce": _pysecrets.token_urlsafe(12),
        "exp": int(time.time()) + ttl_seconds,
    }
    encoded = _wrt_b64url_encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    sig = hmac.new(
        _worker_call_signing_key(secret).encode("utf-8"),
        encoded.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    return f"{WORKER_CALL_TOKEN_PREFIX}{encoded}.{sig}"


def validate_worker_call_token(raw_token: str, *, secret: str | None = None) -> dict[str, Any]:
    """Validate a worker-call token and return its payload.

    Raises ValueError on any failure (bad format, bad signature, expired).
    """
    if not raw_token.startswith(WORKER_CALL_TOKEN_PREFIX):
        raise ValueError("not a worker-call token")
    body = raw_token[len(WORKER_CALL_TOKEN_PREFIX):]
    try:
        encoded, signature = body.split(".", 1)
    except ValueError:
        raise ValueError("invalid worker-call token format")
    expected = hmac.new(
        _worker_call_signing_key(secret).encode("utf-8"),
        encoded.encode("ascii"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("invalid worker-call token signature")
    try:
        payload = json.loads(_wrt_b64url_decode(encoded).decode("utf-8"))
    except Exception:
        raise ValueError("invalid worker-call token payload")
    if int(payload.get("exp") or 0) < int(time.time()):
        raise ValueError("worker-call token expired")
    return payload
