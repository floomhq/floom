"""Slack Events API channel — routes, OAuth helpers, and message handlers.

All route paths are identical to those previously defined directly on the
``app`` FastAPI instance in main.py.  The router is included in main.py via
``app.include_router(slack_router)``.

Lazy imports are used for anything from main.py to avoid circular imports,
following the existing pattern (e.g. ``from chat_service import stream_chat``
inside function bodies).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets as pysecrets
import sqlite3
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import requests
from fastapi import BackgroundTasks, Body, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.routing import APIRouter
from pydantic import BaseModel

from auth import AuthContext, get_auth_context
from channels.common import _MAX_WEBHOOK_BODY_BYTES, collect_agent_reply

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

slack_router = APIRouter()

# ---------------------------------------------------------------------------
# Constants / Pydantic models
# ---------------------------------------------------------------------------

DEFAULT_SLACK_INSTALL_SCOPES = [
    "app_mentions:read",
    "assistant:write",
    "chat:write",
    "commands",
    "im:history",
    "im:write",
]

SLACK_SETUP_ENV_ALLOWLIST = frozenset({
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "SLACK_EVENTS_ENABLED",
})


class SlackSetupConfigRequest(BaseModel):
    client_id: Optional[str] = None
    client_secret: Optional[str] = None
    signing_secret: Optional[str] = None
    events_enabled: Optional[bool] = None


class SlackSetupStatus(BaseModel):
    configured: bool
    missing: List[str]
    client_id_set: bool
    client_secret_set: bool
    signing_secret_set: bool
    events_enabled: bool
    callback_url: str
    events_url: str
    command_url: str
    interactivity_url: str
    install_url: Optional[str]
    installed_teams: List[Dict[str, Any]]
    allowed_team_ids: List[str]


class SlackInstallUrlResponse(BaseModel):
    install_url: str
    expires_at: str


class SlackSetupConfigResponse(BaseModel):
    status: str
    updated: List[str]
    setup: SlackSetupStatus


# ---------------------------------------------------------------------------
# URL helpers (self-contained — read env vars directly to avoid circular import)
# ---------------------------------------------------------------------------

def _public_api_base_url() -> str:
    raw = (
        os.environ.get("WORKEROS_PUBLIC_API_URL")
        or os.environ.get("WORKEROS_API_URL")
        or os.environ.get("WORKERS_API_URL")
        or "https://workers-api.floom.dev"
    )
    return raw.rstrip("/")


def _slack_oauth_callback_url() -> str:
    return f"{_public_api_base_url()}/slack/oauth/callback"


def _slack_events_url() -> str:
    return f"{_public_api_base_url()}/slack/events"


def _slack_commands_url() -> str:
    return f"{_public_api_base_url()}/slack/commands"


def _slack_interactivity_url() -> str:
    return f"{_public_api_base_url()}/slack/interactivity"


# ---------------------------------------------------------------------------
# Scope helpers
# ---------------------------------------------------------------------------

def _slack_install_scopes() -> List[str]:
    raw = os.environ.get("SLACK_INSTALL_SCOPES", "").strip()
    if not raw:
        return list(DEFAULT_SLACK_INSTALL_SCOPES)
    scopes: List[str] = []
    seen = set()
    for part in re.split(r"[,\s]+", raw):
        scope = part.strip()
        if scope and scope not in seen:
            scopes.append(scope)
            seen.add(scope)
    return scopes or list(DEFAULT_SLACK_INSTALL_SCOPES)


# ---------------------------------------------------------------------------
# OAuth state HMAC helpers
# ---------------------------------------------------------------------------

def _slack_state_secret() -> str:
    secret = (os.environ.get("FLOOM_SECRET") or os.environ.get("SLACK_CLIENT_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="FLOOM_SECRET or SLACK_CLIENT_SECRET is required for Slack OAuth state")
    return secret


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padded = value + ("=" * (-len(value) % 4))
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _issue_slack_oauth_state(*, user_id: str, return_to: Optional[str] = None, ttl_seconds: int = 600) -> tuple[str, datetime]:
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    payload = {
        "user_id": user_id,
        "return_to": return_to or "/connections/slack",
        "nonce": pysecrets.token_urlsafe(18),
        "exp": int(expires_at.timestamp()),
    }
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = hmac.new(_slack_state_secret().encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}", expires_at


def _consume_slack_oauth_state(state: str) -> Dict[str, Any]:
    try:
        encoded, signature = state.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid Slack OAuth state") from exc
    expected = hmac.new(_slack_state_secret().encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=400, detail="Invalid Slack OAuth state")
    try:
        payload = json.loads(_b64url_decode(encoded).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid Slack OAuth state") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid Slack OAuth state")
    if int(payload.get("exp") or 0) < int(time.time()):
        raise HTTPException(status_code=400, detail="Slack OAuth state expired")
    return payload


def _slack_install_url(*, state: str) -> str:
    client_id = os.environ.get("SLACK_CLIENT_ID", "").strip()
    if not client_id:
        raise HTTPException(status_code=503, detail="SLACK_CLIENT_ID is not configured")
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "scope": ",".join(_slack_install_scopes()),
        "redirect_uri": _slack_oauth_callback_url(),
        "state": state,
    })
    return f"https://slack.com/oauth/v2/authorize?{params}"


# ---------------------------------------------------------------------------
# Team / installation helpers
# ---------------------------------------------------------------------------

def _safe_slack_team_env_suffix(team_id: str) -> str:
    suffix = re.sub(r"[^A-Za-z0-9_]", "_", team_id.strip()).upper()
    if not suffix:
        raise HTTPException(status_code=400, detail="Slack team_id is required")
    return suffix


def _slack_team_bot_token_env_key(team_id: str) -> str:
    return f"SLACK_BOT_TOKEN_{_safe_slack_team_env_suffix(team_id)}"


def _append_slack_allowed_team_id(team_id: str) -> None:
    allowed = _slack_allowed_team_ids()
    if team_id in allowed:
        return
    allowed.add(team_id)
    from main import _upsert_env_var
    _upsert_env_var("SLACK_ALLOWED_TEAM_IDS", ",".join(sorted(allowed)))


def _list_slack_installations() -> List[Dict[str, Any]]:
    from db import get_db
    from main import row_to_dict, _parse_json_string_list
    try:
        with get_db() as conn:
            rows = conn.execute(
                """
                SELECT team_id, team_name, enterprise_id, enterprise_name, app_id,
                       bot_user_id, bot_token_env_key, scopes_json, installer_user_id,
                       status, installed_by_user_id, created_at, updated_at,
                       last_checked_at, last_check_status, last_check_error
                FROM slack_installations
                ORDER BY updated_at DESC, team_id
                """
            ).fetchall()
    except sqlite3.OperationalError:
        return []
    items: List[Dict[str, Any]] = []
    for row in rows:
        item = row_to_dict(row)
        item["scopes"] = _parse_json_string_list(item.pop("scopes_json", None))
        item["bot_token_set"] = bool(os.environ.get(item.get("bot_token_env_key") or ""))
        item.pop("bot_token_env_key", None)
        items.append(item)
    return items


def _get_slack_installation(team_id: str) -> Optional[Dict[str, Any]]:
    from db import get_db
    from main import row_to_dict
    try:
        with get_db() as conn:
            row = conn.execute(
                """
                SELECT team_id, team_name, enterprise_id, enterprise_name, app_id,
                       bot_user_id, bot_token_env_key, scopes_json, installer_user_id,
                       status, installed_by_user_id, created_at, updated_at,
                       last_checked_at, last_check_status, last_check_error
                FROM slack_installations
                WHERE team_id = ?
                LIMIT 1
                """,
                (team_id,),
            ).fetchone()
    except sqlite3.OperationalError:
        return None
    return row_to_dict(row) if row else None


def _upsert_slack_installation(
    *,
    team_id: str,
    team_name: Optional[str],
    enterprise_id: Optional[str],
    enterprise_name: Optional[str],
    app_id: Optional[str],
    bot_user_id: Optional[str],
    bot_token_env_key: str,
    scopes: List[str],
    installer_user_id: Optional[str],
    installed_by_user_id: str,
    status: str = "active",
) -> Dict[str, Any]:
    from db import get_db, now_iso
    now = now_iso()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO slack_installations
                (team_id, team_name, enterprise_id, enterprise_name, app_id,
                 bot_user_id, bot_token_env_key, scopes_json, installer_user_id,
                 status, installed_by_user_id, created_at, updated_at,
                 last_checked_at, last_check_status, last_check_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(team_id) DO UPDATE SET
                team_name = excluded.team_name,
                enterprise_id = excluded.enterprise_id,
                enterprise_name = excluded.enterprise_name,
                app_id = excluded.app_id,
                bot_user_id = excluded.bot_user_id,
                bot_token_env_key = excluded.bot_token_env_key,
                scopes_json = excluded.scopes_json,
                installer_user_id = excluded.installer_user_id,
                status = excluded.status,
                installed_by_user_id = excluded.installed_by_user_id,
                updated_at = excluded.updated_at,
                last_checked_at = excluded.last_checked_at,
                last_check_status = excluded.last_check_status,
                last_check_error = excluded.last_check_error
            """,
            (
                team_id,
                team_name,
                enterprise_id,
                enterprise_name,
                app_id,
                bot_user_id,
                bot_token_env_key,
                json.dumps(scopes, separators=(",", ":")),
                installer_user_id,
                status,
                installed_by_user_id,
                now,
                now,
                now,
                "valid",
                None,
            ),
        )
    row = _get_slack_installation(team_id)
    if row is None:
        raise RuntimeError(f"failed to persist Slack installation for {team_id}")
    return row


def _slack_bot_token_for_team(team_id: Optional[str]) -> str:
    if team_id:
        install = _get_slack_installation(team_id)
        if install:
            token = os.environ.get(str(install.get("bot_token_env_key") or ""), "").strip()
            if token:
                return token
    return os.environ.get("SLACK_BOT_TOKEN", "").strip()


def _slack_setup_status_for_user(user_id: str) -> SlackSetupStatus:
    missing = [
        name
        for name in ("SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET")
        if not os.environ.get(name, "").strip()
    ]
    install_url = None
    if not missing:
        try:
            state, _expires_at = _issue_slack_oauth_state(user_id=user_id)
            install_url = _slack_install_url(state=state)
        except HTTPException:
            install_url = None
    return SlackSetupStatus(
        configured=not missing,
        missing=missing,
        client_id_set=bool(os.environ.get("SLACK_CLIENT_ID", "").strip()),
        client_secret_set=bool(os.environ.get("SLACK_CLIENT_SECRET", "").strip()),
        signing_secret_set=bool(os.environ.get("SLACK_SIGNING_SECRET", "").strip()),
        events_enabled=_slack_events_enabled(),
        callback_url=_slack_oauth_callback_url(),
        events_url=_slack_events_url(),
        command_url=_slack_commands_url(),
        interactivity_url=_slack_interactivity_url(),
        install_url=install_url,
        installed_teams=_list_slack_installations(),
        allowed_team_ids=sorted(_slack_allowed_team_ids()),
    )


def _extract_slack_oauth_scopes(payload: Dict[str, Any]) -> List[str]:
    raw = payload.get("scope") or payload.get("scopes") or ""
    if isinstance(raw, list):
        return [str(item) for item in raw if str(item).strip()]
    return [part for part in re.split(r"[,\s]+", str(raw).strip()) if part]


def _exchange_slack_oauth_code(code: str) -> Dict[str, Any]:
    client_id = os.environ.get("SLACK_CLIENT_ID", "").strip()
    client_secret = os.environ.get("SLACK_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="Slack OAuth client is not configured")
    response = requests.post(
        "https://slack.com/api/oauth.v2.access",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": _slack_oauth_callback_url(),
        },
        timeout=15,
    )
    try:
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Slack OAuth returned a non-JSON response") from exc
    if not response.ok or not payload.get("ok"):
        raise HTTPException(status_code=502, detail=f"Slack OAuth failed: {payload.get('error') or response.status_code}")
    return payload


def _slack_auth_test(bot_token: str) -> Dict[str, Any]:
    response = requests.get(
        "https://slack.com/api/auth.test",
        headers={"Authorization": f"Bearer {bot_token}"},
        timeout=10,
    )
    try:
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Slack auth.test returned a non-JSON response") from exc
    if not response.ok or not payload.get("ok"):
        raise HTTPException(status_code=502, detail=f"Slack auth.test failed: {payload.get('error') or response.status_code}")
    return payload


# ---------------------------------------------------------------------------
# Setup / OAuth routes
# ---------------------------------------------------------------------------

@slack_router.get("/slack/setup/status", response_model=SlackSetupStatus)
def slack_setup_status(auth: AuthContext = Depends(get_auth_context)) -> SlackSetupStatus:
    return _slack_setup_status_for_user(auth.user_id)


@slack_router.post("/slack/setup/config", response_model=SlackSetupConfigResponse)
def slack_setup_config(
    payload: SlackSetupConfigRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> SlackSetupConfigResponse:
    # Locked: Slack app credentials (client id/secret/signing secret) are now
    # provided by the platform as environment variables, not entered by users.
    # The "Add to Slack" one-app OAuth flow (/slack/oauth/install ->
    # /slack/oauth/callback) is the only supported install path. This endpoint
    # is disabled to prevent per-user credential entry from the UI.
    raise HTTPException(
        status_code=403,
        detail=(
            "Slack credentials are managed by the platform. Use 'Add to Slack' on "
            "the Assistant to connect a workspace."
        ),
    )


@slack_router.post("/slack/oauth/install", response_model=SlackInstallUrlResponse)
def slack_oauth_install(
    return_to: Optional[str] = Body(default="/assistant", embed=True),
    auth: AuthContext = Depends(get_auth_context),
) -> SlackInstallUrlResponse:
    state, expires_at = _issue_slack_oauth_state(user_id=auth.user_id, return_to=return_to)
    return SlackInstallUrlResponse(
        install_url=_slack_install_url(state=state),
        expires_at=expires_at.isoformat(),
    )


@slack_router.get("/slack/oauth/callback")
def slack_oauth_callback(code: str = "", state: str = "", error: str = ""):
    from fastapi.responses import RedirectResponse
    from main import _bootstrap_user_id, _upsert_env_var

    frontend_url = _frontend_base_url()
    if error:
        return RedirectResponse(url=f"{frontend_url}/assistant?slack_error={urllib.parse.quote(error)}")
    if not code or not state:
        return RedirectResponse(url=f"{frontend_url}/assistant?slack_error=missing_code_or_state")

    state_payload = _consume_slack_oauth_state(state)
    installed_by_user_id = str(state_payload.get("user_id") or _bootstrap_user_id())
    oauth_payload = _exchange_slack_oauth_code(code)
    bot_token = str(oauth_payload.get("access_token") or "").strip()
    if not bot_token:
        raise HTTPException(status_code=502, detail="Slack OAuth response did not include a bot token")

    team = oauth_payload.get("team") if isinstance(oauth_payload.get("team"), dict) else {}
    enterprise = oauth_payload.get("enterprise") if isinstance(oauth_payload.get("enterprise"), dict) else {}
    authed_user = oauth_payload.get("authed_user") if isinstance(oauth_payload.get("authed_user"), dict) else {}
    auth_test = _slack_auth_test(bot_token)
    team_id = str(team.get("id") or auth_test.get("team_id") or "").strip()
    if not team_id:
        raise HTTPException(status_code=502, detail="Slack OAuth response did not include a team id")

    bot_token_env_key = _slack_team_bot_token_env_key(team_id)
    _upsert_env_var(bot_token_env_key, bot_token)
    _upsert_env_var("SLACK_BOT_TOKEN", bot_token)
    _append_slack_allowed_team_id(team_id)

    _upsert_slack_installation(
        team_id=team_id,
        team_name=str(team.get("name") or auth_test.get("team") or ""),
        enterprise_id=str(enterprise.get("id") or "") or None,
        enterprise_name=str(enterprise.get("name") or "") or None,
        app_id=str(oauth_payload.get("app_id") or "") or None,
        bot_user_id=str(oauth_payload.get("bot_user_id") or auth_test.get("user_id") or "") or None,
        bot_token_env_key=bot_token_env_key,
        scopes=_extract_slack_oauth_scopes(oauth_payload),
        installer_user_id=str(authed_user.get("id") or "") or None,
        installed_by_user_id=installed_by_user_id,
    )

    return_to_val = str(state_payload.get("return_to") or "/assistant")
    safe_return_to = return_to_val if return_to_val.startswith("/") and not return_to_val.startswith("//") else "/assistant"
    return RedirectResponse(url=f"{frontend_url}{safe_return_to}?slack_connected=1&team_id={urllib.parse.quote(team_id)}")


# ---------------------------------------------------------------------------
# Feature flags / signature verification
# ---------------------------------------------------------------------------

def _slack_events_enabled() -> bool:
    value = os.environ.get("SLACK_EVENTS_ENABLED", "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def _slack_signature_tolerance_seconds() -> int:
    try:
        return max(0, int(os.environ.get("SLACK_SIGNATURE_TOLERANCE_SECONDS", "300")))
    except ValueError:
        return 300


def _verify_slack_signature(body: bytes, request: Request, signing_secret: str) -> bool:
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    signature = request.headers.get("X-Slack-Signature", "")
    if not timestamp or not signature or not signing_secret:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    tolerance = _slack_signature_tolerance_seconds()
    if tolerance > 0 and abs(time.time() - ts) > tolerance:
        return False
    base = b"v0:" + timestamp.encode("utf-8") + b":" + body
    expected = "v0=" + hmac.new(signing_secret.encode("utf-8"), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def _slack_allowed_team_ids() -> set[str]:
    raw = os.environ.get("SLACK_ALLOWED_TEAM_IDS", "")
    return {part.strip() for part in raw.split(",") if part.strip()}


def _clean_slack_agent_prompt(text: str, bot_user_id: Optional[str]) -> str:
    cleaned = text.replace("@floom", "").replace("@Floom", "").replace("<!here>", "")
    if bot_user_id:
        cleaned = cleaned.replace(f"<@{bot_user_id}>", "")
    cleaned = re.sub(r"<@[A-Z0-9]+>", "", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


# ---------------------------------------------------------------------------
# Outbound Slack API helpers
# ---------------------------------------------------------------------------

def _slack_reaction(action: str, *, channel: str, ts: str, emoji: str, bot_token: Optional[str] = None) -> None:
    """Add or remove a reaction emoji on a Slack message. Best-effort — never raises."""
    token = (bot_token or os.environ.get("SLACK_BOT_TOKEN", "")).strip()
    if not token:
        return
    try:
        requests.post(
            f"https://slack.com/api/reactions.{action}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
            json={"channel": channel, "timestamp": ts, "name": emoji},
            timeout=5,
        )
    except Exception:
        pass


def _post_slack_thread_reply(*, channel: str, thread_ts: str, text: str, bot_token: Optional[str] = None) -> None:
    bot_token = (bot_token or os.environ.get("SLACK_BOT_TOKEN", "")).strip()
    if not bot_token:
        raise RuntimeError("SLACK_BOT_TOKEN is not configured")
    response = requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={
            "Authorization": f"Bearer {bot_token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        json={
            "channel": channel,
            "thread_ts": thread_ts,
            "text": text or "(No reply)",
            "unfurl_links": False,
            "unfurl_media": False,
        },
        timeout=15,
    )
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f"Slack post failed with HTTP {response.status_code}") from exc
    if not response.ok or not payload.get("ok"):
        error = str(payload.get("error") or f"HTTP {response.status_code}")
        raise RuntimeError(f"Slack post failed: {error}")


def _set_slack_assistant_status(*, channel: str, thread_ts: str, status: str, bot_token: Optional[str] = None) -> None:
    bot_token = (bot_token or os.environ.get("SLACK_BOT_TOKEN", "")).strip()
    if not bot_token:
        raise RuntimeError("SLACK_BOT_TOKEN is not configured")
    response = requests.post(
        "https://slack.com/api/assistant.threads.setStatus",
        headers={
            "Authorization": f"Bearer {bot_token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        json={
            "channel_id": channel,
            "thread_ts": thread_ts,
            "status": status,
        },
        timeout=15,
    )
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f"Slack assistant status failed with HTTP {response.status_code}") from exc
    if not response.ok or not payload.get("ok"):
        error = str(payload.get("error") or f"HTTP {response.status_code}")
        raise RuntimeError(f"Slack assistant status failed: {error}")


def _post_slack_response_url(*, response_url: str, text: str, response_type: str = "ephemeral") -> None:
    if not response_url:
        raise RuntimeError("Slack response_url is required")
    response = requests.post(
        response_url,
        json={
            "response_type": response_type,
            "text": text or "(No reply)",
        },
        timeout=15,
    )
    if not response.ok:
        raise RuntimeError(f"Slack response_url post failed with HTTP {response.status_code}")


# ---------------------------------------------------------------------------
# URL helpers that need _frontend_base_url
# ---------------------------------------------------------------------------

def _frontend_base_url() -> str:
    return (os.environ.get("WORKERS_FRONTEND_URL") or "https://workers.floom.dev").rstrip("/")


# ---------------------------------------------------------------------------
# Workspace user / approval helpers
# ---------------------------------------------------------------------------

def _slack_workspace_user_id() -> str:
    from main import _bootstrap_user_id
    return (os.environ.get("SLACK_WORKEROS_USER_ID") or _bootstrap_user_id()).strip() or _bootstrap_user_id()


def _parse_slack_form_body(body: bytes) -> Dict[str, str]:
    parsed = urllib.parse.parse_qs(body.decode("utf-8", errors="replace"), keep_blank_values=True)
    return {key: values[-1] if values else "" for key, values in parsed.items()}


def _approval_action_value(run_id: str) -> str:
    return json.dumps({"run_id": run_id}, separators=(",", ":"))


def _approval_action_run_id(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    try:
        parsed = json.loads(raw)
    except Exception:
        return raw
    if isinstance(parsed, dict):
        return str(parsed.get("run_id") or "")
    return raw


def _approve_pending_run_for_slack(*, run_id: str, user_id: str, repos) -> Any:
    from main import approve_run, ApproveRequest
    from auth import AuthContext
    return approve_run(
        run_id,
        ApproveRequest(),
        AuthContext(user_id=user_id, email=None, scopes=("slack",)),
        repos,
    )


def _reject_pending_run_for_slack(
    *,
    run_id: str,
    user_id: str,
    repos,
    reason: str,
) -> Any:
    from main import reject_run, RejectRequest
    from auth import AuthContext
    return reject_run(
        run_id,
        RejectRequest(reason=reason),
        AuthContext(user_id=user_id, email=None, scopes=("slack",)),
        repos,
    )


def _slack_pending_approvals_response(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not rows:
        return {
            "response_type": "ephemeral",
            "text": "No pending approvals.",
        }

    blocks: List[Dict[str, Any]] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": "Pending approvals", "emoji": True},
        },
        {
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": "Approve or reject directly from Slack."}
            ],
        },
    ]
    for row in rows[:5]:
        run_id = str(row.get("run_id") or "")
        worker_name = str(row.get("worker_name") or row.get("worker_id") or "Worker")
        label = str(row.get("label") or "Approval requested")
        preview = str(row.get("preview") or "").strip()
        preview_text = f"\n>{preview[:500]}" if preview else ""
        blocks.extend([
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f"*{worker_name}* — {label}{preview_text}\n`{run_id}`",
                },
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Approve", "emoji": True},
                        "style": "primary",
                        "action_id": "workeros_approval_approve",
                        "value": _approval_action_value(run_id),
                    },
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Reject", "emoji": True},
                        "style": "danger",
                        "action_id": "workeros_approval_reject",
                        "value": _approval_action_value(run_id),
                    },
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Dismiss", "emoji": True},
                        "action_id": "workeros_approval_dismiss",
                        "value": _approval_action_value(run_id),
                    },
                ],
            },
        ])

    if len(rows) > 5:
        blocks.append({
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": f"Showing 5 of {len(rows)} pending approvals."}
            ],
        })
    return {
        "response_type": "ephemeral",
        "text": f"{len(rows)} pending approval(s).",
        "blocks": blocks,
    }


# ---------------------------------------------------------------------------
# Message handlers (background tasks)
# ---------------------------------------------------------------------------

async def _handle_slack_app_mention(
    *,
    event: Dict[str, Any],
    prompt: str,
    user_id: str,
    bot_token: Optional[str] = None,
) -> None:
    channel = str(event.get("channel") or "")
    thread_ts = str(event.get("thread_ts") or event.get("ts") or "")
    if not channel or not thread_ts:
        logger.warning("Slack app_mention missing channel/thread timestamp")
        return
    conversation_id = f"slack:{channel}:{thread_ts}"
    msg_ts = str(event.get("ts") or thread_ts)
    _slack_reaction("add", channel=channel, ts=msg_ts, emoji="eyes", bot_token=bot_token)
    try:
        reply = await collect_agent_reply(
            message=prompt,
            user_id=user_id,
            conversation_id=conversation_id,
        )
        _slack_reaction("remove", channel=channel, ts=msg_ts, emoji="eyes", bot_token=bot_token)
        _slack_reaction("add", channel=channel, ts=msg_ts, emoji="white_check_mark", bot_token=bot_token)
        _post_slack_thread_reply(channel=channel, thread_ts=thread_ts, text=reply, bot_token=bot_token)
    except Exception:
        logger.exception("Slack app_mention processing failed")
        _slack_reaction("remove", channel=channel, ts=msg_ts, emoji="eyes", bot_token=bot_token)
        _slack_reaction("add", channel=channel, ts=msg_ts, emoji="x", bot_token=bot_token)
        if os.environ.get("SLACK_POST_ERRORS_TO_THREAD", "1").strip().lower() not in {"0", "false", "no", "off"}:
            try:
                _post_slack_thread_reply(
                    channel=channel,
                    thread_ts=thread_ts,
                    text="I could not complete that request. The failure was logged for the workspace operator.",
                    bot_token=bot_token,
                )
            except Exception:
                logger.exception("Slack error reply failed")


async def _handle_slack_assistant_thread_started(*, event: Dict[str, Any], bot_token: Optional[str] = None) -> None:
    assistant_thread = event.get("assistant_thread") if isinstance(event.get("assistant_thread"), dict) else {}
    channel = str(assistant_thread.get("channel_id") or "")
    thread_ts = str(assistant_thread.get("thread_ts") or "")
    if not channel or not thread_ts:
        logger.warning("Slack assistant_thread_started missing channel/thread timestamp")
        return
    try:
        _post_slack_thread_reply(
            channel=channel,
            thread_ts=thread_ts,
            text=(
                "I'm Emily, your personal Chief-of-Staff. I route tasks to a "
                "swarm of always-on agents and workers. DM me or @mention me."
            ),
            bot_token=bot_token,
        )
    except Exception:
        logger.exception("Slack assistant thread greeting failed")


async def _handle_slack_direct_message(
    *,
    event: Dict[str, Any],
    prompt: str,
    user_id: str,
    bot_token: Optional[str] = None,
) -> None:
    channel = str(event.get("channel") or "")
    thread_ts = str(event.get("thread_ts") or event.get("ts") or "")
    if not channel or not thread_ts:
        logger.warning("Slack direct message missing channel/thread timestamp")
        return
    conversation_id = f"slack-assistant:{channel}:{thread_ts}"
    # Generate a short-lived sign-in URL and surface it in the system prompt so
    # Emily can share it when the user asks about signing in or getting started.
    try:
        from main import _issue_magic_link
        _magic_token = _issue_magic_link(user_id=user_id, ttl_seconds=900)
        _frontend = _frontend_base_url()
        _signin_url = f"{_frontend}/auth/magic/{_magic_token}"
        _slack_system_suffix = (
            f"## Sign-in link for this conversation\n"
            f"If the user asks how to sign in, access the dashboard, or get started on the web, "
            f"share this personal sign-in link (valid 15 minutes): {_signin_url}\n"
            f"Do not share this URL unprompted."
        )
    except Exception:
        _slack_system_suffix = ""
    try:
        try:
            _set_slack_assistant_status(
                channel=channel,
                thread_ts=thread_ts,
                status="is working on your request...",
                bot_token=bot_token,
            )
        except Exception:
            logger.exception("Slack assistant status update failed")
        reply = await collect_agent_reply(
            message=prompt,
            user_id=user_id,
            conversation_id=conversation_id,
            system_suffix=_slack_system_suffix,
        )
        _post_slack_thread_reply(channel=channel, thread_ts=thread_ts, text=reply, bot_token=bot_token)
    except Exception:
        logger.exception("Slack direct message processing failed")
        if os.environ.get("SLACK_POST_ERRORS_TO_THREAD", "1").strip().lower() not in {"0", "false", "no", "off"}:
            try:
                _post_slack_thread_reply(
                    channel=channel,
                    thread_ts=thread_ts,
                    text="I could not complete that request. The failure was logged for the workspace operator.",
                    bot_token=bot_token,
                )
            except Exception:
                logger.exception("Slack direct message error reply failed")


async def _handle_slack_command_message(
    *,
    prompt: str,
    response_url: str,
    user_id: str,
    channel_id: str,
) -> None:
    conversation_id = f"slack-command:{channel_id}" if channel_id else "slack-command"
    try:
        reply = await collect_agent_reply(
            message=prompt,
            user_id=user_id,
            conversation_id=conversation_id,
        )
        _post_slack_response_url(response_url=response_url, text=reply or "(No reply)")
    except Exception:
        logger.exception("Slack command processing failed")
        try:
            _post_slack_response_url(
                response_url=response_url,
                text="I could not complete that request. The failure was logged for the workspace operator.",
            )
        except Exception:
            logger.exception("Slack command error reply failed")


async def _slack_command_response_from_form(
    form: Dict[str, str],
    background_tasks: BackgroundTasks,
) -> Response:
    from db import get_repositories
    team_id = str(form.get("team_id") or "")
    allowed_team_ids = _slack_allowed_team_ids()
    if allowed_team_ids and team_id not in allowed_team_ids:
        raise HTTPException(status_code=403, detail="Slack team is not allowed")

    text = str(form.get("text") or "").strip()
    response_url = str(form.get("response_url") or "")
    channel_id = str(form.get("channel_id") or "")
    user_id = _slack_workspace_user_id()
    command = text.lower()

    if command in {"", "help"}:
        return JSONResponse({
            "response_type": "ephemeral",
            "text": "Try `/floom approvals` or `/floom <question for your workspace agent>`.",
        })

    if command in {"approvals", "approval", "pending approvals"}:
        repos = get_repositories()
        rows = repos.approvals.list_pending(owner_id=user_id)
        return JSONResponse(_slack_pending_approvals_response(rows))

    if not response_url:
        raise HTTPException(status_code=400, detail="Slack response_url is required")

    background_tasks.add_task(
        _handle_slack_command_message,
        prompt=text,
        response_url=response_url,
        user_id=user_id,
        channel_id=channel_id,
    )
    return JSONResponse({
        "response_type": "ephemeral",
        "text": "Working on it...",
    })


def _slack_interactivity_response_from_form(form: Dict[str, str]) -> Response:
    from db import get_repositories
    raw_payload = form.get("payload") or ""
    try:
        payload = json.loads(raw_payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid Slack interaction payload") from exc

    team = payload.get("team") if isinstance(payload.get("team"), dict) else {}
    team_id = str(team.get("id") or payload.get("team_id") or "")
    allowed_team_ids = _slack_allowed_team_ids()
    if allowed_team_ids and team_id not in allowed_team_ids:
        raise HTTPException(status_code=403, detail="Slack team is not allowed")

    actions = payload.get("actions")
    action = actions[0] if isinstance(actions, list) and actions else {}
    if not isinstance(action, dict):
        return JSONResponse({"replace_original": False, "text": "No Slack action found."})

    action_id = str(action.get("action_id") or "")
    run_id = _approval_action_run_id(str(action.get("value") or ""))
    slack_user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    slack_user_id = str(slack_user.get("id") or "unknown")
    user_id = _slack_workspace_user_id()

    if action_id == "workeros_approval_dismiss":
        return JSONResponse({
            "replace_original": True,
            "text": f"Dismissed approval `{run_id}`.",
        })

    if action_id not in {"workeros_approval_approve", "workeros_approval_reject"}:
        return JSONResponse({
            "replace_original": False,
            "text": f"Unsupported Slack action: {action_id or 'unknown'}",
        })
    if not run_id:
        return JSONResponse({
            "replace_original": False,
            "text": "Missing run_id for Slack approval action.",
        })

    repos = get_repositories()
    try:
        if action_id == "workeros_approval_approve":
            result = _approve_pending_run_for_slack(run_id=run_id, user_id=user_id, repos=repos)
            return JSONResponse({
                "replace_original": True,
                "text": f"Approved `{run_id}` from Slack. Follow-up run: `{result.run_id}`.",
            })
        _reject_pending_run_for_slack(
            run_id=run_id,
            user_id=user_id,
            repos=repos,
            reason=f"Rejected from Slack by {slack_user_id}",
        )
        return JSONResponse({
            "replace_original": True,
            "text": f"Rejected `{run_id}` from Slack.",
        })
    except HTTPException as exc:
        return JSONResponse({
            "replace_original": False,
            "text": f"Could not apply Slack approval action: {exc.detail}",
        })


# ---------------------------------------------------------------------------
# Event / command / interactivity routes
# ---------------------------------------------------------------------------

@slack_router.post("/slack/events")
async def slack_events(request: Request, background_tasks: BackgroundTasks) -> Response:
    """Receive native Slack Events API callbacks.

    The route verifies Slack's HMAC signature, handles Slack URL verification,
    deduplicates event callbacks by event_id, and forwards app mentions to the
    workspace agent in the background so Slack receives a fast acknowledgement.
    """
    if not _slack_events_enabled():
        raise HTTPException(status_code=503, detail="Slack Events API is disabled")
    signing_secret = os.environ.get("SLACK_SIGNING_SECRET", "").strip()
    if not signing_secret:
        raise HTTPException(status_code=503, detail="SLACK_SIGNING_SECRET is not configured")

    body = await request.body()
    # Payload size cap: reject oversized bodies before any HMAC work.
    if len(body) > _MAX_WEBHOOK_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Slack events payload too large")
    if not _verify_slack_signature(body, request, signing_secret):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    content_type = request.headers.get("content-type", "").lower()
    if "application/x-www-form-urlencoded" in content_type:
        form = _parse_slack_form_body(body)
        if "payload" in form:
            return _slack_interactivity_response_from_form(form)
        return await _slack_command_response_from_form(form, background_tasks)

    try:
        payload: Dict[str, Any] = json.loads(body.decode("utf-8") or "{}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid Slack JSON payload") from exc

    payload_type = str(payload.get("type") or "")
    if payload_type == "url_verification":
        challenge = str(payload.get("challenge") or "")
        return PlainTextResponse(challenge, media_type="text/plain")
    if payload_type != "event_callback":
        return JSONResponse({"ok": True, "ignored": payload_type or "unknown"})

    team_id = str(payload.get("team_id") or "")
    allowed_team_ids = _slack_allowed_team_ids()
    if allowed_team_ids and team_id not in allowed_team_ids:
        raise HTTPException(status_code=403, detail="Slack team is not allowed")

    event = payload.get("event") if isinstance(payload.get("event"), dict) else {}
    event_type = str(event.get("type") or "")
    is_direct_message = event_type == "message" and str(event.get("channel_type") or "") == "im"
    supported_event_types = {"app_mention", "assistant_thread_started", "assistant_thread_context_changed"}
    if event_type not in supported_event_types and not is_direct_message:
        return JSONResponse({"ok": True, "ignored": event_type or "unknown"})

    bot_token = _slack_bot_token_for_team(team_id)
    if not bot_token:
        raise HTTPException(status_code=503, detail="SLACK_BOT_TOKEN is not configured")

    from main import _claim_webhook_delivery, _bootstrap_user_id
    event_id = str(payload.get("event_id") or request.headers.get("X-Slack-Retry-Num") or "")
    if event_id and not _claim_webhook_delivery("slack:events", event_id):
        return JSONResponse({"ok": True, "duplicate": True})

    if event_type == "assistant_thread_started":
        background_tasks.add_task(_handle_slack_assistant_thread_started, event=event, bot_token=bot_token)
        return JSONResponse({"ok": True, "status": "queued"})

    if event_type == "assistant_thread_context_changed":
        return JSONResponse({"ok": True, "status": "context_updated"})

    if is_direct_message:
        subtype = str(event.get("subtype") or "")
        if subtype or event.get("bot_id"):
            return JSONResponse({"ok": True, "ignored": subtype or "bot_message"})
        prompt = _clean_slack_agent_prompt(str(event.get("text") or ""), None)
        if not prompt:
            return JSONResponse({"ok": True, "ignored": "empty_prompt"})
        user_id = (os.environ.get("SLACK_WORKEROS_USER_ID") or _bootstrap_user_id()).strip() or _bootstrap_user_id()
        background_tasks.add_task(
            _handle_slack_direct_message,
            event=event,
            prompt=prompt,
            user_id=user_id,
            bot_token=bot_token,
        )
        return JSONResponse({"ok": True, "status": "queued"})

    authorizations = payload.get("authorizations")
    bot_user_id = None
    if isinstance(authorizations, list) and authorizations:
        first_authorization = authorizations[0]
        if isinstance(first_authorization, dict):
            bot_user_id = str(first_authorization.get("user_id") or "") or None
    prompt = _clean_slack_agent_prompt(str(event.get("text") or ""), bot_user_id)
    if not prompt:
        return JSONResponse({"ok": True, "ignored": "empty_prompt"})

    user_id = (os.environ.get("SLACK_WORKEROS_USER_ID") or _bootstrap_user_id()).strip() or _bootstrap_user_id()
    background_tasks.add_task(
        _handle_slack_app_mention,
        event=event,
        prompt=prompt,
        user_id=user_id,
        bot_token=bot_token,
    )
    return JSONResponse({"ok": True, "status": "queued"})


@slack_router.post("/slack/commands")
async def slack_commands(request: Request, background_tasks: BackgroundTasks) -> Response:
    """Receive Slack slash-command requests for the workspace agent."""
    if not _slack_events_enabled():
        raise HTTPException(status_code=503, detail="Slack integration is disabled")
    signing_secret = os.environ.get("SLACK_SIGNING_SECRET", "").strip()
    if not signing_secret:
        raise HTTPException(status_code=503, detail="SLACK_SIGNING_SECRET is not configured")

    body = await request.body()
    # Payload size cap: reject oversized bodies before any HMAC work.
    if len(body) > _MAX_WEBHOOK_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Slack commands payload too large")
    if not _verify_slack_signature(body, request, signing_secret):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    form = _parse_slack_form_body(body)
    team_id = str(form.get("team_id") or "")
    allowed_team_ids = _slack_allowed_team_ids()
    if allowed_team_ids and team_id not in allowed_team_ids:
        raise HTTPException(status_code=403, detail="Slack team is not allowed")

    text = str(form.get("text") or "").strip()
    response_url = str(form.get("response_url") or "")
    channel_id = str(form.get("channel_id") or "")
    user_id = _slack_workspace_user_id()
    command = text.lower()

    if command in {"", "help"}:
        return JSONResponse({
            "response_type": "ephemeral",
            "text": "Try `/floom approvals` or `/floom <question for your workspace agent>`.",
        })

    if command in {"approvals", "approval", "pending approvals"}:
        from db import get_repositories
        repos = get_repositories()
        rows = repos.approvals.list_pending(owner_id=user_id)
        return JSONResponse(_slack_pending_approvals_response(rows))

    if not response_url:
        raise HTTPException(status_code=400, detail="Slack response_url is required")

    background_tasks.add_task(
        _handle_slack_command_message,
        prompt=text,
        response_url=response_url,
        user_id=user_id,
        channel_id=channel_id,
    )
    return JSONResponse({
        "response_type": "ephemeral",
        "text": "Working on it...",
    })


@slack_router.post("/slack/interactivity")
async def slack_interactivity(request: Request) -> Response:
    """Receive Slack Block Kit action payloads."""
    if not _slack_events_enabled():
        raise HTTPException(status_code=503, detail="Slack integration is disabled")
    signing_secret = os.environ.get("SLACK_SIGNING_SECRET", "").strip()
    if not signing_secret:
        raise HTTPException(status_code=503, detail="SLACK_SIGNING_SECRET is not configured")

    body = await request.body()
    # Payload size cap: reject oversized bodies before any HMAC work.
    if len(body) > _MAX_WEBHOOK_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Slack interactivity payload too large")
    if not _verify_slack_signature(body, request, signing_secret):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    form = _parse_slack_form_body(body)
    raw_payload = form.get("payload") or ""
    try:
        payload = json.loads(raw_payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid Slack interaction payload") from exc

    team = payload.get("team") if isinstance(payload.get("team"), dict) else {}
    team_id = str(team.get("id") or payload.get("team_id") or "")
    allowed_team_ids = _slack_allowed_team_ids()
    if allowed_team_ids and team_id not in allowed_team_ids:
        raise HTTPException(status_code=403, detail="Slack team is not allowed")

    actions = payload.get("actions")
    action = actions[0] if isinstance(actions, list) and actions else {}
    if not isinstance(action, dict):
        return JSONResponse({"replace_original": False, "text": "No Slack action found."})

    action_id = str(action.get("action_id") or "")
    run_id = _approval_action_run_id(str(action.get("value") or ""))
    slack_user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    slack_user_id = str(slack_user.get("id") or "unknown")
    user_id = _slack_workspace_user_id()

    if action_id == "workeros_approval_dismiss":
        return JSONResponse({
            "replace_original": True,
            "text": f"Dismissed approval `{run_id}`.",
        })

    if action_id not in {"workeros_approval_approve", "workeros_approval_reject"}:
        return JSONResponse({
            "replace_original": False,
            "text": f"Unsupported Slack action: {action_id or 'unknown'}",
        })
    if not run_id:
        return JSONResponse({
            "replace_original": False,
            "text": "Missing run_id for Slack approval action.",
        })

    from db import get_repositories
    repos = get_repositories()
    try:
        if action_id == "workeros_approval_approve":
            result = _approve_pending_run_for_slack(run_id=run_id, user_id=user_id, repos=repos)
            return JSONResponse({
                "replace_original": True,
                "text": f"Approved `{run_id}` from Slack. Follow-up run: `{result.run_id}`.",
            })
        _reject_pending_run_for_slack(
            run_id=run_id,
            user_id=user_id,
            repos=repos,
            reason=f"Rejected from Slack by {slack_user_id}",
        )
        return JSONResponse({
            "replace_original": True,
            "text": f"Rejected `{run_id}` from Slack.",
        })
    except HTTPException as exc:
        return JSONResponse({
            "replace_original": False,
            "text": f"Could not apply Slack approval action: {exc.detail}",
        })
