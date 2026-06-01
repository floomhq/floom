from __future__ import annotations

import json
import os
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from apps.api._engine import import_engine_module
from apps.api.auth.workspace_context import active_workspace
from apps.api.cloud_workspace_agent import resolve_slack_event_binding

engine_main = import_engine_module("main")

router = APIRouter(prefix="/slack", tags=["slack"])


async def _run_bound_slack_agent(
    *,
    event: dict[str, Any],
    prompt: str,
    user_id: str,
    workspace_id: str | None,
) -> None:
    if workspace_id:
        with active_workspace(workspace_id):
            await engine_main._handle_slack_app_mention(
                event=event,
                prompt=prompt,
                user_id=user_id,
            )
        return
    await engine_main._handle_slack_app_mention(
        event=event,
        prompt=prompt,
        user_id=user_id,
    )


@router.post("/events")
async def slack_events(request: Request, background_tasks: BackgroundTasks) -> Response:
    if not engine_main._slack_events_enabled():
        raise HTTPException(status_code=503, detail="Slack Events API is disabled")
    signing_secret = os.environ.get("SLACK_SIGNING_SECRET", "").strip()
    if not signing_secret:
        raise HTTPException(status_code=503, detail="SLACK_SIGNING_SECRET is not configured")

    body = await request.body()
    if not engine_main._verify_slack_signature(body, request, signing_secret):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    try:
        payload: dict[str, Any] = json.loads(body.decode("utf-8") or "{}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid Slack JSON payload") from exc

    payload_type = str(payload.get("type") or "")
    if payload_type == "url_verification":
        challenge = str(payload.get("challenge") or "")
        return PlainTextResponse(challenge, media_type="text/plain")
    if payload_type != "event_callback":
        return JSONResponse({"ok": True, "ignored": payload_type or "unknown"})

    team_id = str(payload.get("team_id") or "")
    allowed_team_ids = engine_main._slack_allowed_team_ids()
    if allowed_team_ids and team_id not in allowed_team_ids:
        raise HTTPException(status_code=403, detail="Slack team is not allowed")

    event = payload.get("event") if isinstance(payload.get("event"), dict) else {}
    event_type = str(event.get("type") or "")
    if event_type != "app_mention":
        return JSONResponse({"ok": True, "ignored": event_type or "unknown"})

    if not os.environ.get("SLACK_BOT_TOKEN", "").strip():
        raise HTTPException(status_code=503, detail="SLACK_BOT_TOKEN is not configured")

    event_id = str(payload.get("event_id") or request.headers.get("X-Slack-Retry-Num") or "")
    if event_id and not engine_main._claim_webhook_delivery("slack:events", event_id):
        return JSONResponse({"ok": True, "duplicate": True})

    authorizations = payload.get("authorizations")
    bot_user_id = None
    if isinstance(authorizations, list) and authorizations:
        first_authorization = authorizations[0]
        if isinstance(first_authorization, dict):
            bot_user_id = str(first_authorization.get("user_id") or "") or None
    prompt = engine_main._clean_slack_agent_prompt(str(event.get("text") or ""), bot_user_id)
    if not prompt:
        return JSONResponse({"ok": True, "ignored": "empty_prompt"})

    channel_id = str(event.get("channel") or "")
    binding = resolve_slack_event_binding(team_id=team_id, channel_id=channel_id)
    if binding:
        user_id = str(binding["owner_user_id"])
        workspace_id = str(binding["workspace_id"])
        routed = "workspace_binding"
    else:
        user_id = (
            os.environ.get("SLACK_WORKEROS_USER_ID") or engine_main._bootstrap_user_id()
        ).strip() or engine_main._bootstrap_user_id()
        workspace_id = None
        routed = "legacy_env_user"

    background_tasks.add_task(
        _run_bound_slack_agent,
        event=event,
        prompt=prompt,
        user_id=user_id,
        workspace_id=workspace_id,
    )
    return JSONResponse({"ok": True, "status": "queued", "routed": routed})
