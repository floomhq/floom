"""Single source of truth for the approval public-share link HMAC signer.

The approval "public link" (`/approvals/review?id=...&token=...`) and the
`/approvals/public/*` reviewer surface are gated by a deterministic HMAC token
over `id.run_id.owner_id`. This module owns both the secret resolution and the
two token functions so the router and the chat tool can't drift (they used to
each carry a private copy — DRY violation that made the cloud 503 below hard to
reason about).

Why the secret is decoupled from FLOOM_SECRET (#998 follow-up):

`_approval_public_token()` historically read `FLOOM_SECRET` only and fail-closed
(503) when it was empty (#998 — never sign a share token with a public constant).
That is correct for OSS single-tenant, but a downstream multi-tenant host
DELIBERATELY strips FLOOM_SECRET at startup (and installs an os.environ guard that
blocks it) so the engine's OSS `x-floom-secret` auth gate stays off while auth is
Supabase JWT/PAT. The result: in hosted mode FLOOM_SECRET is intentionally absent,
so EVERY approval row's token mint 503'd — and because the list/detail serializer
mints a link for every row, `GET /api/approvals` 503'd the whole list whenever any
approval existed (the Approvals page showed "Could not load approvals").

Fix, mirroring the existing decoupled signers (WORKEROS_MAGIC_LINK_SECRET,
WORKEROS_UPLOAD_URL_SIGNING_SECRET):

  1. A dedicated `WORKEROS_APPROVAL_SIGNING_SECRET` env var the cloud can set
     (startup.py only blocks FLOOM_SECRET, not this name) so share links work in
     cloud without re-enabling the OSS auth hijack.
  2. Fallback to FLOOM_SECRET so OSS single-tenant keeps working unchanged.
  3. When NEITHER is set: the mint path (`approval_public_token`) still fails
     closed with 503 so a forgeable/unsigned link is never emitted; the serializer
     uses `try_approval_public_token` which returns None so the authenticated
     owner still gets their approvals list/detail (only the optional public share
     link is omitted).
"""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any, Dict, Optional


def _approval_signing_secret() -> Optional[str]:
    """Resolve the approval-link signing secret, or None.

    Precedence: dedicated WORKEROS_APPROVAL_SIGNING_SECRET, then FLOOM_SECRET
    (OSS single-tenant default). Never falls back to a public constant.
    """
    secret = (
        os.environ.get("WORKEROS_APPROVAL_SIGNING_SECRET")
        or os.environ.get("FLOOM_SECRET")
        or ""
    ).strip()
    return secret or None


def _approval_public_payload(approval: Dict[str, Any]) -> str:
    return ".".join(
        str(approval.get(key) or "")
        for key in ("id", "run_id", "owner_id")
    )


def _sign(secret: str, approval: Dict[str, Any]) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        _approval_public_payload(approval).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def approval_public_token(approval: Dict[str, Any]) -> str:
    """Mint a public-share token, FAIL CLOSED (503) when no signer is configured.

    Use this on the explicit public-link MINT paths (`/approvals/public/*` verify,
    and anywhere that emits a share link as the primary purpose). Never emits an
    unsigned/forgeable link.
    """
    secret = _approval_signing_secret()
    if not secret:
        # #998: never sign/verify a public share token with a public constant —
        # a missing secret would let anyone forge share links. Fail closed.
        from fastapi import HTTPException  # noqa: PLC0415
        raise HTTPException(status_code=503, detail="Server signing secret not configured")
    return _sign(secret, approval)


def try_approval_public_token(approval: Dict[str, Any]) -> Optional[str]:
    """Mint a public-share token, or return None when no signer is configured.

    Use this on the list/detail SERIALIZER path so a missing signer degrades the
    optional share link to None instead of 503-ing the owner's whole approvals
    list. The authenticated owner always gets their approvals.
    """
    secret = _approval_signing_secret()
    if not secret:
        return None
    return _sign(secret, approval)


def _approvals_base_url() -> str:
    """Public frontend base for user-facing approval deep links.

    Honour the same host the rest of the engine uses: WORKEROS_PUBLIC_URL is the
    explicit override; otherwise fall back to WORKERS_FRONTEND_URL (used by the
    email/alert links) so a self-hosted deployment that sets one host gets
    correct links everywhere, not a hardcoded example.com.
    """
    return (
        os.environ.get("WORKEROS_PUBLIC_URL")
        or os.environ.get("WORKERS_FRONTEND_URL")
        or "https://localhost:3000"
    ).rstrip("/")


def try_approval_review_url(approval: Dict[str, Any]) -> Optional[str]:
    """Build the tokenised `/approvals/review` deep link for an approval, or None.

    Single source of truth for the operator-facing approval/review URL so the
    chat tool (Emily), the run-detail serializer, and the CLI all emit the SAME
    link instead of each re-deriving the host + token shape. `approval` must
    carry ``id``, ``run_id`` and ``owner_id``.

    DEGRADE, never raise: when no signer secret is configured (e.g. hosted mode)
    the token mint returns None, so this returns None and callers simply omit the
    link rather than failing the whole response.
    """
    approval_id = approval.get("id")
    run_id = approval.get("run_id")
    owner_id = approval.get("owner_id")
    if not (approval_id and run_id and owner_id):
        return None
    token = try_approval_public_token(
        {"id": approval_id, "run_id": run_id, "owner_id": owner_id}
    )
    if not token:
        return None
    return f"{_approvals_base_url()}/approvals/review?id={approval_id}&token={token}"
