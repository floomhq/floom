from __future__ import annotations

import json
import os
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from apps.api._engine import import_engine_module
from apps.api.auth.workspace_context import active_workspace
from apps.api.cloud_workspace_agent import resolve_slack_event_binding
from apps.api.db import slack_installations as slack_db

engine_main = import_engine_module("main")
engine_slack = import_engine_module("channels.slack")
channel_common = import_engine_module("channels.common")

router = APIRouter(prefix="/slack", tags=["slack"])


def _install_principal_user_id(team_id: str) -> str:
    return f"slack-install:{team_id}"


async def _run_bound_slack_agent(
    *,
    event: dict[str, Any],
    prompt: str,
    user_id: str,
    workspace_id: str | None,
    bot_token: str | None = None,
) -> None:
    channel = str(event.get("channel") or "")
    thread_ts = str(event.get("thread_ts") or event.get("ts") or "")
    if not channel or not thread_ts:
        return
    try:
        if workspace_id:
            with active_workspace(workspace_id):
                reply = await channel_common.collect_agent_reply(
                    message=prompt,
                    user_id=user_id,
                    conversation_id=f"slack-dm:{channel}:{thread_ts}",
                    source="slack",
                )
        else:
            reply = await channel_common.collect_agent_reply(
                message=prompt,
                user_id=user_id,
                conversation_id=f"slack-dm:{channel}:{thread_ts}",
                source="slack",
            )
        engine_main._post_slack_thread_reply(
            channel=channel,
            thread_ts=thread_ts,
            text=reply or "(No reply)",
            bot_token=bot_token,
        )
    except Exception:
        engine_main.logger.exception("Cloud Slack DM processing failed")
        try:
            engine_main._post_slack_thread_reply(
                channel=channel,
                thread_ts=thread_ts,
                text="Something went wrong on my end. Try again in a moment.",
                bot_token=bot_token,
            )
        except Exception:
            engine_main.logger.exception("Cloud Slack DM error reply failed")


def _post_install_claim_link(*, team_id: str, slack_user_id: str, channel: str, thread_ts: str, bot_token: str) -> None:
    install = slack_db.get_installation(team_id)
    if not install:
        return
    if not slack_db.can_claim_install(team_id=team_id, slack_user_id=slack_user_id, install=install):
        engine_main._post_slack_thread_reply(
            channel=channel,
            thread_ts=thread_ts,
            text="Ask the original installer or a Slack admin to claim this Floom workspace.",
            bot_token=bot_token,
        )
        return
    claim_token, _claim = slack_db.create_install_claim(installation=install)
    base = (
        os.environ.get("WORKERS_FRONTEND_URL")
        or os.environ.get("WORKEROS_PUBLIC_URL")
        or "https://workers.floom.dev"
    ).rstrip("/")
    url = f"{base}/slack/installed?team_id={team_id}&claim={claim_token}"
    engine_main._post_slack_thread_reply(
        channel=channel,
        thread_ts=thread_ts,
        text=f"Claim this Floom workspace to manage Emily on the web: {url}",
        bot_token=bot_token,
    )


def _post_sender_claim_link(*, team_id: str, slack_user_id: str, channel: str, thread_ts: str, bot_token: str) -> None:
    claim = slack_db.create_sender_claim(team_id=team_id, slack_user_id=slack_user_id)
    short_url = engine_slack._slack_short_claim_url(claim["claim_token"])
    engine_main._post_slack_thread_reply(
        channel=channel,
        thread_ts=thread_ts,
        text=f"Link your account first: {short_url} (valid 24h)",
        bot_token=bot_token,
    )


@router.post("/events")
async def slack_events(request: Request, background_tasks: BackgroundTasks) -> Response:
    if not engine_main._slack_events_enabled():
        raise HTTPException(status_code=503, detail="Slack Events API is disabled")
    signing_secret = os.environ.get("SLACK_SIGNING_SECRET", "").strip()
    if not signing_secret:
        raise HTTPException(status_code=503, detail="SLACK_SIGNING_SECRET is not configured")

    body = await request.body()
    if len(body) > channel_common._MAX_WEBHOOK_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Slack events payload too large")
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
    is_direct_message = event_type == "message" and str(event.get("channel_type") or "") == "im"
    supported = {"app_mention", "assistant_thread_started", "assistant_thread_context_changed"}
    if event_type not in supported and not is_direct_message:
        return JSONResponse({"ok": True, "ignored": event_type or "unknown"})

    bot_token = slack_db.bot_token_for_team(team_id)
    if not bot_token:
        raise HTTPException(status_code=503, detail="Slack bot token is not configured")

    event_id = str(payload.get("event_id") or request.headers.get("X-Slack-Retry-Num") or "")
    if event_id and not engine_main._claim_webhook_delivery("slack:events", event_id):
        return JSONResponse({"ok": True, "duplicate": True})

    if event_type == "assistant_thread_started":
        background_tasks.add_task(engine_main._handle_slack_assistant_thread_started, event=event, bot_token=bot_token)
        return JSONResponse({"ok": True, "status": "queued", "routed": "assistant_thread"})

    if event_type == "assistant_thread_context_changed":
        return JSONResponse({"ok": True, "status": "context_updated"})

    if event_type == "app_mention":
        slack_sender_id = str(event.get("user") or "").strip()
        background_tasks.add_task(
            engine_main._handle_slack_app_mention,
            event=event,
            team_id=team_id,
            slack_sender_id=slack_sender_id,
            bot_token=bot_token,
        )
        return JSONResponse({"ok": True, "status": "queued", "routed": "app_mention"})

    subtype = str(event.get("subtype") or "")
    if subtype or event.get("bot_id"):
        return JSONResponse({"ok": True, "ignored": subtype or "bot_message"})
    prompt = engine_main._clean_slack_agent_prompt(str(event.get("text") or ""), None)
    if not prompt:
        return JSONResponse({"ok": True, "ignored": "empty_prompt"})

    channel_id = str(event.get("channel") or "")
    thread_ts = str(event.get("thread_ts") or event.get("ts") or "")
    slack_sender_id = str(event.get("user") or "").strip()
    binding = resolve_slack_event_binding(team_id=team_id, channel_id=channel_id)
    if not binding:
        return JSONResponse({"ok": True, "ignored": "no_workspace_binding"})

    workspace_id = str(binding["workspace_id"])
    owner_user_id = binding.get("owner_user_id")
    install = slack_db.get_installation(team_id)
    installer_slack_user_id = str((install or {}).get("installer_slack_user_id") or "")
    if owner_user_id:
        bound_user_id = slack_db.sender_binding_user_id(team_id=team_id, slack_user_id=slack_sender_id)
        if not bound_user_id:
            _post_sender_claim_link(
                team_id=team_id,
                slack_user_id=slack_sender_id,
                channel=channel_id,
                thread_ts=thread_ts,
                bot_token=bot_token,
            )
            return JSONResponse({"ok": True, "status": "claim_required", "routed": "unbound_sender"})
        user_id = bound_user_id
        routed = "workspace_sender_binding"
    else:
        if slack_sender_id and installer_slack_user_id:
            _post_install_claim_link(
                team_id=team_id,
                slack_user_id=slack_sender_id,
                channel=channel_id,
                thread_ts=thread_ts,
                bot_token=bot_token,
            )
            return JSONResponse({"ok": True, "status": "claim_required", "routed": "unclaimed_workspace"})
        user_id = _install_principal_user_id(team_id)
        routed = "unclaimed_workspace"

    background_tasks.add_task(
        _run_bound_slack_agent,
        event=event,
        prompt=prompt,
        user_id=user_id,
        workspace_id=workspace_id,
        bot_token=bot_token,
    )
    return JSONResponse({"ok": True, "status": "queued", "routed": routed})
