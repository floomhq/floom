"""Cloud-side WhatsApp binding repository: Supabase persistence + engine override.

Dual-write pattern (Phase 3):
- The engine's channels/whatsapp.py continues to write SQLite (unchanged).
- When WORKEROS_DEPLOY=cloud, this module patches the engine's binding functions
  to also read/write Supabase, making Supabase the authoritative source for cloud.
- A one-shot backfill script (scripts/backfill_wa_bindings.py) copies existing
  SQLite bindings into Supabase idempotently.

Override surface: apply_cloud_whatsapp_overrides() is called from startup.py
and patches channels.whatsapp module-level functions directly, the same pattern
used by cloud_webhooks.py (apply_engine_overrides) and cloud_workspace_agent.py
(apply_cloud_workspace_agent_overrides).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from apps.api._engine import ensure_engine_api_path, import_engine_module
from apps.api.config import get_supabase_service_client
from apps.api.obs import get_logger, log_failure

ensure_engine_api_path()

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Supabase helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sb():
    return get_supabase_service_client()


def _rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None)
    return list(data) if data else []


# ---------------------------------------------------------------------------
# Supabase WhatsApp binding CRUD
# ---------------------------------------------------------------------------

def get_binding(wa_id: str) -> dict[str, Any] | None:
    """Fetch the active binding for a normalized wa_id from Supabase."""
    resp = (
        _sb()
        .table("whatsapp_sender_bindings")
        .select("wa_id, user_id, workspace_id, profile_name, status, claim_token, claim_expires_at, created_at, updated_at, last_seen_at")
        .eq("wa_id", wa_id)
        .limit(1)
        .execute()
    )
    rows = _rows(resp)
    return rows[0] if rows else None


def upsert_binding(wa_id: str, **fields: Any) -> dict[str, Any]:
    """Upsert a binding row in Supabase. Returns the resulting row."""
    now = _now_iso()
    payload = {"wa_id": wa_id, "updated_at": now, **fields}
    resp = (
        _sb()
        .table("whatsapp_sender_bindings")
        .upsert(payload, on_conflict="wa_id")
        .execute()
    )
    rows = _rows(resp)
    return rows[0] if rows else payload


def update_last_seen(wa_id: str) -> None:
    """Bump last_seen_at + updated_at on the binding row (best-effort)."""
    now = _now_iso()
    try:
        _sb().table("whatsapp_sender_bindings").update(
            {"last_seen_at": now, "updated_at": now}
        ).eq("wa_id", wa_id).execute()
    except Exception:
        logger.warning("WhatsApp last_seen update failed for %s", wa_id, exc_info=True)


def reset_binding_to_pending(wa_id: str, new_token: str, expires_at: str) -> None:
    """Reset an active binding to pending with a fresh claim token."""
    now = _now_iso()
    try:
        _sb().table("whatsapp_sender_bindings").update({
            "status": "pending",
            "user_id": None,
            "workspace_id": None,
            "claim_token": new_token,
            "claim_expires_at": expires_at,
            "updated_at": now,
        }).eq("wa_id", wa_id).execute()
    except Exception:
        logger.warning("WhatsApp binding reset in Supabase failed for %s", wa_id, exc_info=True)


# ---------------------------------------------------------------------------
# Engine function overrides
# ---------------------------------------------------------------------------

def _cloud_binding_info(wa_id: str) -> Optional[Tuple[str, str]]:
    """Supabase-backed replacement for channels.whatsapp._whatsapp_binding_info.

    Safety guarantee: if the Supabase table does not exist yet (migration 0033
    not applied) or any Supabase error occurs, falls back to the original
    engine SQLite lookup so the WhatsApp flow is never interrupted.
    """
    import re
    normalized = re.sub(r"\D", "", str(wa_id or ""))
    if not normalized:
        return None
    try:
        row = get_binding(normalized)
        if row and row.get("status") == "active" and row.get("user_id"):
            update_last_seen(normalized)
            workspace_id = str(row.get("workspace_id") or "local-default")
            return str(row["user_id"]), workspace_id
        # Row found but not active/bound — do not fall back to SQLite.
        if row is not None:
            return None
    except Exception:
        logger.warning(
            "Supabase WhatsApp binding lookup failed for %s — falling back to SQLite",
            normalized, exc_info=True,
        )
        # Fall back to SQLite (engine original) so a missing/broken Supabase
        # table (migration 0033 not yet applied) never breaks inbound messages.
        wa_mod = import_engine_module("channels.whatsapp")
        orig = getattr(wa_mod, "_orig_binding_info", None)
        if orig is not None:
            try:
                return orig(normalized)
            except Exception:
                # Both Supabase AND the SQLite fallback failed: the inbound
                # WhatsApp message cannot be resolved to a user and is dropped.
                log_failure(
                    logger,
                    "WhatsApp binding lookup failed on both Supabase and SQLite for wa_id=%s",
                    normalized,
                )
    return None


def _cloud_create_claim(wa_id: str, profile_name: str = "") -> Dict[str, str]:
    """Supabase-backed replacement for channels.whatsapp._whatsapp_create_claim.

    Writes to BOTH SQLite (via the original engine function) AND Supabase (dual-write).
    """
    import secrets as pysecrets

    # Delegate to the original engine function for SQLite write.
    wa_mod = import_engine_module("channels.whatsapp")
    result = wa_mod._orig_create_claim(wa_id, profile_name)

    # Dual-write to Supabase.
    import re
    normalized = re.sub(r"\D", "", str(wa_id or ""))
    if normalized:
        try:
            existing = get_binding(normalized)
            if existing and existing.get("status") == "active":
                # Active binding: don't overwrite with a pending row.
                pass
            else:
                upsert_binding(
                    normalized,
                    profile_name=profile_name or None,
                    status="pending",
                    claim_token=result["claim_token"],
                    claim_expires_at=result["claim_expires_at"],
                    created_at=result.get("created_at") or _now_iso(),
                )
        except Exception:
            logger.warning(
                "Supabase WhatsApp claim dual-write failed for %s", normalized, exc_info=True
            )
    return result


def _cloud_reset_binding_to_pending(wa_id: str) -> Optional[str]:
    """Supabase-backed replacement for channels.whatsapp._reset_binding_to_pending.

    Writes to BOTH SQLite AND Supabase (dual-write).
    """
    import re
    import secrets as pysecrets
    from datetime import timedelta

    wa_mod = import_engine_module("channels.whatsapp")
    claim_url = wa_mod._orig_reset_binding(wa_id)

    # Dual-write to Supabase.
    normalized = re.sub(r"\D", "", str(wa_id or ""))
    if normalized and claim_url:
        try:
            # Extract the new token from the URL.
            import urllib.parse as _up
            qs = _up.parse_qs(_up.urlparse(claim_url).query)
            token = (qs.get("whatsapp_claim") or [""])[0]
            if token:
                expires_at = (
                    datetime.now(timezone.utc) + timedelta(hours=24)
                ).isoformat()
                reset_binding_to_pending(normalized, token, expires_at)
        except Exception:
            logger.warning(
                "Supabase WhatsApp binding reset dual-write failed for %s", normalized, exc_info=True
            )
    return claim_url


# ---------------------------------------------------------------------------
# Startup hook
# ---------------------------------------------------------------------------

def apply_cloud_whatsapp_overrides() -> None:
    """Patch engine channels.whatsapp to use Supabase for binding reads/writes.

    Called from apps/api/startup.py alongside apply_engine_overrides() and
    apply_cloud_workspace_agent_overrides().

    Dual-write: engine functions are preserved as _orig_* so cloud overrides
    can delegate SQLite writes before (or in addition to) Supabase writes.
    """
    deploy = __import__("os").environ.get("WORKEROS_DEPLOY", "local").strip().lower()
    if deploy != "cloud":
        return

    wa_mod = import_engine_module("channels.whatsapp")

    # Preserve originals for dual-write delegation.
    if not hasattr(wa_mod, "_orig_binding_info"):
        wa_mod._orig_binding_info = wa_mod._whatsapp_binding_info
    if not hasattr(wa_mod, "_orig_create_claim"):
        wa_mod._orig_create_claim = wa_mod._whatsapp_create_claim
    if not hasattr(wa_mod, "_orig_reset_binding"):
        wa_mod._orig_reset_binding = wa_mod._reset_binding_to_pending

    # Apply cloud overrides.
    wa_mod._whatsapp_binding_info = _cloud_binding_info
    wa_mod._whatsapp_create_claim = _cloud_create_claim
    wa_mod._reset_binding_to_pending = _cloud_reset_binding_to_pending

    logger.info("Applied cloud Supabase overrides for channels.whatsapp")
