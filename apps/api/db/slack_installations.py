from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException

from apps.api.config import get_supabase_service_client
from apps.api.db._secret_crypto import vault_read_secret, vault_store_secret, vault_update_secret
from apps.api.db import workspaces as workspace_repo
from apps.api.obs import get_logger, log_failure

logger = get_logger(__name__)


INSTALL_STATUSES = {
    "installed",
    "unclaimed",
    "claimed",
    "claim_pending",
    "revoked",
    "uninstalled",
    "token_invalid",
}

CLAIM_TTL_SECONDS = 20 * 60
VERIFICATION_TTL_SECONDS = 10 * 60


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_workspace_name(team_name: str | None) -> str:
    cleaned = re.sub(r"\s+", " ", (team_name or "").strip())
    cleaned = re.sub(r"[^\w .&'()+,-]", "", cleaned, flags=re.UNICODE).strip(" .")
    return cleaned[:80] or "Slack workspace"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _secret_name(team_id: str) -> str:
    safe_team = re.sub(r"[^A-Za-z0-9_-]", "_", team_id.strip())
    return f"workeros/slack/{safe_team}/bot-token"


def _row(response: Any) -> dict[str, Any] | None:
    data = getattr(response, "data", None)
    if not data:
        return None
    if isinstance(data, list):
        return dict(data[0]) if data else None
    if isinstance(data, dict):
        return dict(data)
    return None


def _rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None)
    if not data:
        return []
    if isinstance(data, list):
        return [dict(row) for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        return [dict(data)]
    return []


def _client_ip_hash(ip: str | None) -> str | None:
    if not ip:
        return None
    salt = (
        os.environ.get("SLACK_INSTALL_RATE_LIMIT_SALT")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SLACK_CLIENT_SECRET")
        or "workeros-slack-install"
    )
    return hmac.new(salt.encode("utf-8"), ip.encode("utf-8"), hashlib.sha256).hexdigest()


def audit(
    *,
    action: str,
    team_id: str | None = None,
    workspace_id: str | None = None,
    installation_id: str | None = None,
    actor_user_id: str | None = None,
    slack_user_id: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    payload = {
        "action": action,
        "team_id": team_id,
        "workspace_id": workspace_id,
        "installation_id": installation_id,
        "actor_user_id": actor_user_id,
        "slack_user_id": slack_user_id,
        "ip_hash": _client_ip_hash(ip),
        "user_agent": (user_agent or "")[:500] or None,
        "metadata_json": metadata or {},
    }
    get_supabase_service_client().table("slack_install_audit_logs").insert(payload).execute()


def enforce_global_rate_limit(*, limit: int = 500, window_seconds: int = 3600) -> None:
    since = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat()
    response = (
        get_supabase_service_client()
        .table("slack_install_audit_logs")
        .select("id")
        .eq("action", "install_start")
        .gte("created_at", since)
        .limit(limit + 1)
        .execute()
    )
    if len(_rows(response)) >= limit:
        raise HTTPException(status_code=429, detail="Too many Slack install attempts")


def enforce_ip_rate_limit(*, ip: str | None, limit: int = 20, window_seconds: int = 3600) -> None:
    client_ip = ip or "unknown"
    ip_hash = _client_ip_hash(client_ip)
    since = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat()
    response = (
        get_supabase_service_client()
        .table("slack_install_audit_logs")
        .select("id")
        .eq("action", "install_start")
        .eq("ip_hash", ip_hash)
        .gte("created_at", since)
        .limit(limit + 1)
        .execute()
    )
    if len(_rows(response)) >= limit:
        raise HTTPException(status_code=429, detail="Too many Slack install attempts")


def enforce_team_rate_limit(*, team_id: str, limit: int = 6, window_seconds: int = 3600) -> None:
    since = (datetime.now(timezone.utc) - timedelta(seconds=window_seconds)).isoformat()
    response = (
        get_supabase_service_client()
        .table("slack_install_audit_logs")
        .select("id")
        .eq("action", "install_callback")
        .eq("team_id", team_id)
        .gte("created_at", since)
        .limit(limit + 1)
        .execute()
    )
    if len(_rows(response)) >= limit:
        raise HTTPException(status_code=429, detail="Too many Slack installs for this team")


def blocked_team_ids() -> set[str]:
    raw = os.environ.get("SLACK_BLOCKED_TEAM_IDS", "")
    return {part.strip() for part in re.split(r"[,\s]+", raw) if part.strip()}


def install_enabled() -> bool:
    raw = os.environ.get("SLACK_INSTALLS_ENABLED", "true").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def get_installation(team_id: str) -> dict[str, Any] | None:
    response = (
        get_supabase_service_client()
        .table("slack_installations")
        .select(
            "team_id,installation_id,team_name,enterprise_id,enterprise_name,app_id,"
            "bot_user_id,bot_token_encrypted,scopes_json,installer_slack_user_id,"
            "workspace_id,status,installed_at,claimed_at,revoked_at,uninstalled_at,"
            "last_token_check_at,last_token_check_status,last_token_check_error,"
            "created_at,updated_at"
        )
        .eq("team_id", team_id)
        .limit(1)
        .execute()
    )
    return _row(response)


def list_installed_team_ids() -> set[str]:
    response = (
        get_supabase_service_client()
        .table("slack_installations")
        .select("team_id")
        .in_("status", ["installed", "unclaimed", "claimed", "claim_pending"])
        .execute()
    )
    return {str(row.get("team_id")) for row in _rows(response) if row.get("team_id")}


def bot_token_for_team(team_id: str | None) -> str:
    if not team_id:
        return os.environ.get("SLACK_BOT_TOKEN", "").strip()
    try:
        install = get_installation(team_id)
    except Exception:
        # Installation lookup failed unexpectedly — the bot silently loses its
        # token and stops responding for this team. Surface it (team id only).
        log_failure(
            logger, "slack installation lookup failed for team %s; bot token unavailable", team_id
        )
        return ""
    if not install:
        return ""
    vault_id = install.get("bot_token_encrypted")
    if not vault_id:
        mark_token_invalid(team_id=team_id, error="vault_secret_missing")
        return ""
    try:
        token = vault_read_secret(get_supabase_service_client(), UUID(str(vault_id)))
    except Exception:
        # Vault read failed (infra/key issue, not an invalid Slack token). The
        # team is marked token_invalid below, but log the underlying failure —
        # never the token/vault contents — so the root cause is diagnosable.
        log_failure(
            logger, "vault read of slack bot token failed for team %s", team_id
        )
        mark_token_invalid(team_id=team_id, error="vault_read_failed")
        return ""
    if not token:
        mark_token_invalid(team_id=team_id, error="vault_secret_missing")
        return ""
    return str(token).strip()


def mark_token_invalid(*, team_id: str, error: str) -> None:
    get_supabase_service_client().table("slack_installations").update(
        {
            "status": "token_invalid",
            "last_token_check_at": now_iso(),
            "last_token_check_status": "invalid",
            "last_token_check_error": error[:500],
        }
    ).eq("team_id", team_id).execute()


def _store_bot_token(*, team_id: str, token: str, existing_vault_id: str | None) -> str:
    client = get_supabase_service_client()
    name = _secret_name(team_id)
    if existing_vault_id:
        vault_update_secret(client, UUID(str(existing_vault_id)), token, name)
        return str(existing_vault_id)
    vault_id = vault_store_secret(
        client,
        token,
        name,
        description=f"Slack bot token for team {team_id}",
    )
    return str(vault_id)


def create_unclaimed_workspace(*, name: str) -> dict[str, Any]:
    workspace_id = "ws_" + uuid.uuid4().hex[:14]
    get_supabase_service_client().table("workspaces").insert(
        {
            "id": workspace_id,
            "owner_user_id": None,
            "name": sanitize_workspace_name(name),
            "workspace_status": "unclaimed",
            "created_at": now_iso(),
        }
    ).execute()
    workspace = workspace_repo.get(workspace_id=workspace_id)
    if workspace is None:
        raise RuntimeError(f"failed to create unclaimed workspace {workspace_id}")
    return workspace


def upsert_installation(
    *,
    team_id: str,
    team_name: str | None,
    enterprise_id: str | None,
    enterprise_name: str | None,
    app_id: str | None,
    bot_user_id: str | None,
    bot_token: str,
    scopes: list[str],
    installer_slack_user_id: str,
) -> dict[str, Any]:
    if team_id in blocked_team_ids():
        raise HTTPException(status_code=403, detail="Slack team is blocked")
    if not bot_token:
        raise HTTPException(status_code=502, detail="Slack OAuth response did not include a bot token")
    existing = get_installation(team_id)
    vault_id = _store_bot_token(
        team_id=team_id,
        token=bot_token,
        existing_vault_id=str(existing.get("bot_token_encrypted")) if existing and existing.get("bot_token_encrypted") else None,
    )
    response = get_supabase_service_client().rpc(
        "upsert_slack_installation_cloud",
        {
            "p_team_id": team_id,
            "p_team_name": team_name,
            "p_enterprise_id": enterprise_id,
            "p_enterprise_name": enterprise_name,
            "p_app_id": app_id,
            "p_bot_user_id": bot_user_id,
            "p_bot_token_encrypted": vault_id,
            "p_scopes_json": scopes,
            "p_installer_slack_user_id": installer_slack_user_id,
        },
    ).execute()
    row = _row(response) or get_installation(team_id)
    if row is None:
        raise RuntimeError(f"failed to persist Slack installation for {team_id}")
    return get_installation(team_id) or row


def create_install_claim(*, installation: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    raw = "sic_" + secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=CLAIM_TTL_SECONDS)).isoformat()
    payload = {
        "token_hash": token_hash(raw),
        "team_id": str(installation["team_id"]),
        "installation_id": str(installation["installation_id"]),
        "installer_slack_user_id": str(installation["installer_slack_user_id"]),
        "expires_at": expires_at,
    }
    response = get_supabase_service_client().table("slack_install_claims").insert(payload).execute()
    row = _row(response)
    if row is None:
        row = get_claim(raw)
    if row is None:
        raise RuntimeError("failed to create Slack install claim")
    return raw, row


def get_claim(token: str) -> dict[str, Any] | None:
    response = (
        get_supabase_service_client()
        .table("slack_install_claims")
        .select(
            "id,token_hash,team_id,installation_id,installer_slack_user_id,"
            "verification_slack_user_id,verification_code_hash,verification_expires_at,verification_attempts,"
            "expires_at,used_at,created_at"
        )
        .eq("token_hash", token_hash(token))
        .limit(1)
        .execute()
    )
    return _row(response)


def _parse_dt(value: Any) -> datetime:
    if not value:
        return datetime.fromtimestamp(0, tz=timezone.utc)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def validate_claim_token(token: str) -> tuple[dict[str, Any], dict[str, Any]]:
    claim = get_claim(token)
    if not claim:
        raise HTTPException(status_code=404, detail="Slack install claim not found")
    if claim.get("used_at"):
        raise HTTPException(status_code=410, detail="Slack install claim already used")
    if _parse_dt(claim.get("expires_at")) < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Slack install claim expired")
    install = get_installation(str(claim["team_id"]))
    if not install or str(install.get("installation_id")) != str(claim.get("installation_id")):
        raise HTTPException(status_code=404, detail="Slack installation not found")
    if str(install.get("installer_slack_user_id") or "") != str(claim.get("installer_slack_user_id") or ""):
        raise HTTPException(status_code=400, detail="Slack install claim binding mismatch")
    return claim, install


def start_claim_verification(*, token: str, install: dict[str, Any], claimant_slack_user_id: str) -> None:
    if not can_claim_install(team_id=str(install["team_id"]), slack_user_id=claimant_slack_user_id, install=install):
        raise HTTPException(status_code=403, detail="Slack installer or workspace admin identity is required")
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=VERIFICATION_TTL_SECONDS)).isoformat()
    get_supabase_service_client().table("slack_install_claims").update(
        {
            "verification_slack_user_id": claimant_slack_user_id,
            "verification_code_hash": token_hash(code),
            "verification_expires_at": expires_at,
            "verification_attempts": 0,
        }
    ).eq("token_hash", token_hash(token)).execute()
    _send_claim_verification_dm(install=install, slack_user_id=claimant_slack_user_id, code=code)


def verify_claim_code(*, token: str, claim: dict[str, Any], code: str, claimant_slack_user_id: str) -> None:
    verified_slack_user_id = str(claim.get("verification_slack_user_id") or "").strip()
    if not verified_slack_user_id or verified_slack_user_id != claimant_slack_user_id:
        raise HTTPException(status_code=403, detail="Slack verification identity mismatch")
    attempts = int(claim.get("verification_attempts") or 0)
    if attempts >= 5:
        raise HTTPException(status_code=429, detail="Too many Slack verification attempts")
    expires = _parse_dt(claim.get("verification_expires_at"))
    if expires < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Slack verification code expired")
    expected = str(claim.get("verification_code_hash") or "")
    supplied = token_hash((code or "").strip())
    if not expected or not hmac.compare_digest(expected, supplied):
        get_supabase_service_client().table("slack_install_claims").update(
            {"verification_attempts": attempts + 1}
        ).eq("token_hash", token_hash(token)).execute()
        raise HTTPException(status_code=403, detail="Invalid Slack verification code")


def _send_claim_verification_dm(*, install: dict[str, Any], slack_user_id: str, code: str) -> None:
    slack = _slack_module()
    slack._post_slack_dm(
        slack_user_id=slack_user_id,
        team_id=str(install["team_id"]),
        text=(
            "Use this one-time code to claim your Floom workspace: "
            f"{code}\n\nIt expires in 10 minutes."
        ),
        bot_token=bot_token_for_team(str(install["team_id"])),
    )


def _slack_module():
    from apps.api._engine import import_engine_module

    return import_engine_module("channels.slack")


def _slack_user_info(*, team_id: str, slack_user_id: str) -> dict[str, Any]:
    import requests

    token = bot_token_for_team(team_id)
    if not token:
        raise HTTPException(status_code=503, detail="Slack bot token is not available")
    response = requests.get(
        "https://slack.com/api/users.info",
        headers={"Authorization": f"Bearer {token}"},
        params={"user": slack_user_id},
        timeout=10,
    )
    try:
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Slack users.info returned a non-JSON response") from exc
    if not response.ok or not payload.get("ok"):
        raise HTTPException(status_code=502, detail=f"Slack users.info failed: {payload.get('error') or response.status_code}")
    user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    if user.get("deleted") or user.get("is_bot"):
        raise HTTPException(status_code=403, detail="Slack installer is no longer an active team member")
    return user


def can_claim_install(*, team_id: str, slack_user_id: str, install: dict[str, Any] | None = None) -> bool:
    if not team_id or not slack_user_id:
        return False
    install = install or get_installation(team_id)
    if not install:
        return False
    user = _slack_user_info(team_id=team_id, slack_user_id=slack_user_id)
    if slack_user_id == str(install.get("installer_slack_user_id") or ""):
        return True
    return bool(user.get("is_admin") or user.get("is_owner") or user.get("is_primary_owner"))


def claim_workspace(
    *,
    token: str,
    claimant_user_id: str,
    claimant_email: str | None,
    verification_code: str,
    claimant_slack_user_id: str,
) -> dict[str, Any]:
    workspace_repo.ensure_user_row(user_id=claimant_user_id, email=claimant_email)
    claim, install = validate_claim_token(token)
    claimant_slack_user_id = (claimant_slack_user_id or "").strip()
    if not claimant_slack_user_id:
        raise HTTPException(status_code=400, detail="Slack user id is required to claim this workspace")
    if not verification_code:
        start_claim_verification(token=token, install=install, claimant_slack_user_id=claimant_slack_user_id)
        get_supabase_service_client().table("slack_installations").update(
            {"status": "claim_pending"}
        ).eq("team_id", str(install["team_id"])).execute()
        raise HTTPException(status_code=202, detail="Slack verification code sent")
    verify_claim_code(token=token, claim=claim, code=verification_code, claimant_slack_user_id=claimant_slack_user_id)
    slack_user = _slack_user_info(
        team_id=str(install["team_id"]),
        slack_user_id=claimant_slack_user_id,
    )
    if not can_claim_install(team_id=str(install["team_id"]), slack_user_id=claimant_slack_user_id, install=install):
        raise HTTPException(status_code=403, detail="Slack installer or workspace admin identity is required")
    workspace = workspace_repo.get(workspace_id=str(install["workspace_id"]))
    if not workspace:
        raise HTTPException(status_code=404, detail="workspace not found")
    if workspace.get("owner_user_id"):
        raise HTTPException(status_code=409, detail="Slack workspace already claimed")
    timestamp = now_iso()
    client = get_supabase_service_client()
    client.table("workspaces").update(
        {
            "owner_user_id": claimant_user_id,
            "workspace_status": "claimed",
        }
    ).eq("id", str(install["workspace_id"])).is_("owner_user_id", "null").execute()
    updated_workspace = workspace_repo.get(workspace_id=str(install["workspace_id"]))
    if not updated_workspace or str(updated_workspace.get("owner_user_id")) != str(claimant_user_id):
        raise HTTPException(status_code=409, detail="Slack workspace already claimed")
    client.table("slack_installations").update(
        {"status": "claimed", "claimed_at": timestamp}
    ).eq("team_id", str(install["team_id"])).execute()
    client.table("slack_install_claims").update(
        {
            "used_at": timestamp,
            "verification_slack_user_id": None,
            "verification_code_hash": None,
            "verification_expires_at": None,
        }
    ).eq("token_hash", token_hash(token)).execute()
    bind_sender(
        team_id=str(install["team_id"]),
        slack_user_id=claimant_slack_user_id,
        user_id=claimant_user_id,
        workspace_id=str(install["workspace_id"]),
        profile_name=str(slack_user.get("profile", {}).get("real_name") or slack_user.get("name") or ""),
    )
    return {
        "ok": True,
        "team_id": str(install["team_id"]),
        "workspace_id": str(install["workspace_id"]),
        "user_id": claimant_user_id,
    }


def sender_binding_user_id(*, team_id: str, slack_user_id: str) -> str | None:
    if not team_id or not slack_user_id:
        return None
    response = (
        get_supabase_service_client()
        .table("slack_sender_bindings")
        .select("user_id,workspace_id,status")
        .eq("slack_team_id", team_id)
        .eq("slack_user_id", slack_user_id)
        .eq("status", "active")
        .limit(1)
        .execute()
    )
    row = _row(response)
    if not row or not row.get("user_id"):
        return None
    get_supabase_service_client().table("slack_sender_bindings").update(
        {"last_seen_at": now_iso()}
    ).eq("slack_team_id", team_id).eq("slack_user_id", slack_user_id).execute()
    return str(row["user_id"])


def bind_sender(
    *,
    team_id: str,
    slack_user_id: str,
    user_id: str,
    workspace_id: str,
    profile_name: str | None = None,
) -> None:
    get_supabase_service_client().table("slack_sender_bindings").upsert(
        {
            "slack_team_id": team_id,
            "slack_user_id": slack_user_id,
            "user_id": user_id,
            "workspace_id": workspace_id,
            "profile_name": profile_name,
            "status": "active",
            "claim_token_hash": None,
            "claim_expires_at": None,
            "last_seen_at": now_iso(),
        },
        on_conflict="slack_team_id,slack_user_id",
    ).execute()


def create_sender_claim(*, team_id: str, slack_user_id: str, profile_name: str = "") -> dict[str, str]:
    install = get_installation(team_id)
    if not install:
        raise ValueError("Slack installation not found")
    raw = "ssc_" + secrets.token_urlsafe(24)
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
    get_supabase_service_client().table("slack_sender_bindings").upsert(
        {
            "slack_team_id": team_id,
            "slack_user_id": slack_user_id,
            "workspace_id": str(install["workspace_id"]),
            "profile_name": profile_name or None,
            "status": "pending",
            "claim_token_hash": token_hash(raw),
            "claim_expires_at": expires_at,
            "last_seen_at": now_iso(),
        },
        on_conflict="slack_team_id,slack_user_id",
    ).execute()
    return {
        "slack_team_id": team_id,
        "slack_user_id": slack_user_id,
        "claim_token": raw,
        "claim_expires_at": expires_at,
        "status": "pending",
    }
