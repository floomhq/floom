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

import hashlib
import hmac
import os
import time

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
        # Dev mode — no secret configured, treat any token as valid
        # but still parse the run_id from the payload.
        try:
            data, _ = token.rsplit(".", 1)
            _, run_id, _ = data.split(":", 2)
            return run_id or None
        except Exception:
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
