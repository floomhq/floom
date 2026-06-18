from __future__ import annotations

import ipaddress
import urllib.parse
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from apps.api._engine import import_engine_module
from apps.api.cloud_workspace_agent import upsert_slack_binding
from apps.api.db import slack_installations as slack_db

engine_main = import_engine_module("main")
engine_slack = import_engine_module("channels.slack")

from auth import AuthContext, get_auth_context  # noqa: E402


router = APIRouter(tags=["slack-oauth"])

_ALLOWED_RETURN_PATHS = {
    "/slack/installed",
    "/settings",
    "/assistant",
    "/app/install/slack",
}


class SlackInstallClaimRequest(BaseModel):
    token: str = Field(..., min_length=16, max_length=256)
    slack_user_id: str = Field(..., min_length=1, max_length=32)
    verification_code: str | None = Field(default=None, min_length=6, max_length=32)


def _frontend_base_url() -> str:
    return (
        getattr(engine_slack, "_frontend_base_url", lambda: None)()
        or "https://workers.floom.dev"
    ).rstrip("/")


def _client_ip(request: Request) -> str | None:
    cloudflare_ip = (request.headers.get("cf-connecting-ip") or "").strip()
    if not cloudflare_ip:
        return None
    try:
        ipaddress.ip_address(cloudflare_ip)
    except ValueError:
        return None
    return cloudflare_ip


def _safe_return_path(path: str | None, fallback: str = "/slack/installed") -> str:
    value = (path or fallback).strip() or fallback
    if not value.startswith("/") or value.startswith("//"):
        return fallback
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme or parsed.netloc:
        return fallback
    if parsed.path not in _ALLOWED_RETURN_PATHS:
        return fallback
    return urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, parsed.fragment))


def _append_success_params(return_to: str, *, team_id: str, claim: str) -> str:
    parsed = urllib.parse.urlsplit(return_to)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.extend([
        ("slack_connected", "1"),
        ("team_id", team_id),
        ("claim", claim),
    ])
    return urllib.parse.urlunsplit(("", "", parsed.path, urllib.parse.urlencode(query), parsed.fragment))


@router.get("/slack/install/start")
async def slack_install_start(request: Request) -> RedirectResponse:
    if not slack_db.install_enabled():
        raise HTTPException(status_code=503, detail="Slack installs are disabled")
    client_ip = _client_ip(request)
    slack_db.enforce_global_rate_limit()
    slack_db.enforce_ip_rate_limit(ip=client_ip, limit=5 if client_ip is None else 20)
    state, _expires_at = engine_main._issue_slack_oauth_state(
        user_id="",
        return_to="/slack/installed",
    )
    install_url = engine_main._slack_install_url(state=state)
    slack_db.audit(
        action="install_start",
        ip=client_ip or "unknown",
        user_agent=request.headers.get("user-agent"),
        metadata={"redirect_host": urllib.parse.urlparse(install_url).netloc},
    )
    return RedirectResponse(url=install_url, status_code=302)


@router.get("/slack/oauth/callback")
async def slack_oauth_callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
) -> RedirectResponse:
    frontend = _frontend_base_url()
    if error:
        slack_db.audit(
            action="install_callback_error",
            ip=_client_ip(request),
            user_agent=request.headers.get("user-agent"),
            metadata={"error": error[:100]},
        )
        return RedirectResponse(
            url=f"{frontend}/slack/installed?slack_error={urllib.parse.quote(error)}",
            status_code=302,
        )
    if not code or not state:
        return RedirectResponse(
            url=f"{frontend}/slack/installed?slack_error=missing_code_or_state",
            status_code=302,
        )

    state_payload = engine_main._consume_slack_oauth_state(state)
    return_to = _safe_return_path(str(state_payload.get("return_to") or "/slack/installed"))

    oauth_payload: dict[str, Any] = engine_main._exchange_slack_oauth_code(code)
    bot_token = str(oauth_payload.get("access_token") or "").strip()
    if not bot_token:
        raise HTTPException(status_code=502, detail="Slack OAuth response did not include a bot token")

    team = oauth_payload.get("team") if isinstance(oauth_payload.get("team"), dict) else {}
    enterprise = oauth_payload.get("enterprise") if isinstance(oauth_payload.get("enterprise"), dict) else {}
    authed_user = oauth_payload.get("authed_user") if isinstance(oauth_payload.get("authed_user"), dict) else {}
    auth_test = engine_main._slack_auth_test(bot_token)
    team_id = str(team.get("id") or auth_test.get("team_id") or "").strip()
    if not team_id:
        raise HTTPException(status_code=502, detail="Slack OAuth response did not include a team id")
    if team_id in slack_db.blocked_team_ids():
        raise HTTPException(status_code=403, detail="Slack team is blocked")
    slack_db.enforce_team_rate_limit(team_id=team_id)

    installer_slack_user_id = str(authed_user.get("id") or "").strip()
    if not installer_slack_user_id:
        raise HTTPException(status_code=502, detail="Slack OAuth response did not include installer identity")

    installation = slack_db.upsert_installation(
        team_id=team_id,
        team_name=str(team.get("name") or auth_test.get("team") or ""),
        enterprise_id=str(enterprise.get("id") or "") or None,
        enterprise_name=str(enterprise.get("name") or "") or None,
        app_id=str(oauth_payload.get("app_id") or "") or None,
        bot_user_id=str(oauth_payload.get("bot_user_id") or auth_test.get("user_id") or "") or None,
        bot_token=bot_token,
        scopes=engine_main._extract_slack_oauth_scopes(oauth_payload),
        installer_slack_user_id=installer_slack_user_id,
    )
    workspace_id = str(installation["workspace_id"])
    upsert_slack_binding(
        workspace_id=workspace_id,
        external_channel_id=None,
        external_channel_name="Slack team default",
        external_team_id=team_id,
        enabled=True,
        scope="team",
    )
    claim_token, _claim = slack_db.create_install_claim(installation=installation)
    slack_db.audit(
        action="install_callback",
        team_id=team_id,
        workspace_id=workspace_id,
        installation_id=str(installation["installation_id"]),
        slack_user_id=installer_slack_user_id,
        ip=_client_ip(request) or "unknown",
        user_agent=request.headers.get("user-agent"),
        metadata={"bot_token_fp": slack_db.fingerprint(bot_token), "status": installation.get("status")},
    )
    return RedirectResponse(
        url=f"{frontend}{_append_success_params(return_to, team_id=team_id, claim=claim_token)}",
        status_code=302,
    )


@router.post("/slack/install/claim")
async def slack_install_claim(
    payload: SlackInstallClaimRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> JSONResponse:
    try:
        result = slack_db.claim_workspace(
            token=payload.token,
            claimant_user_id=auth.user_id,
            claimant_email=getattr(auth, "email", None),
            verification_code=(payload.verification_code or "").strip(),
            claimant_slack_user_id=payload.slack_user_id.strip(),
        )
    except HTTPException as exc:
        if exc.status_code == 202:
            return JSONResponse(
                status_code=202,
                content={"ok": False, "verification_required": True, "detail": exc.detail},
            )
        raise
    slack_db.audit(
        action="install_claimed",
        team_id=str(result["team_id"]),
        workspace_id=str(result["workspace_id"]),
        actor_user_id=auth.user_id,
        ip=_client_ip(request) or "unknown",
        user_agent=request.headers.get("user-agent"),
    )
    return JSONResponse(result)
