from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Any

from apps.api._engine import import_engine_module
from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api.config import get_supabase_service_client
from apps.api.db import workspaces as workspace_repo

logger = logging.getLogger("workeros.cloud.workspace_agent")

chat_service = import_engine_module("chat_service")

_DEFAULT_WORKSPACE_MD = "# Workspace\n\nNo workspace.md configured yet. PUT /workspace to set one."
_WORKSPACE_AGENT_ID = "workspace-agent"
_original_workspace_agent_info = getattr(chat_service, "workspace_agent_info", None)


def _template_workspace_md() -> str:
    template = getattr(chat_service, "WORKSPACE_MD_TEMPLATE", None)
    if template is not None and Path(template).is_file():
        return Path(template).read_text(encoding="utf-8")
    return _DEFAULT_WORKSPACE_MD


def _safe_workspace_id(workspace_id: str) -> str:
    return "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in workspace_id)


def _fallback_path(workspace_id: str) -> Path:
    root = (
        os.environ.get("WORKEROS_CLOUD_WORKSPACE_AGENT_DIR")
        or os.environ.get("WORKEROS_CLOUD_DATA_DIR")
        or str(Path.home() / ".local" / "share" / "workeros-cloud")
    )
    return Path(root) / "workspace-agent" / _safe_workspace_id(workspace_id) / "workspace.md"


def get_workspace_md() -> str:
    workspace_id = get_active_workspace_id()
    if not workspace_id:
        return _template_workspace_md()

    try:
        response = (
            get_supabase_service_client()
            .table("workspace_agent_settings")
            .select("instructions_md")
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
        rows = getattr(response, "data", None) or []
        if rows:
            content = rows[0].get("instructions_md")
            if isinstance(content, str) and content.strip():
                return content
        return _template_workspace_md()
    except Exception as exc:
        logger.warning("workspace_agent_settings read failed; using file fallback: %s", exc)
        path = _fallback_path(workspace_id)
        if path.is_file():
            return path.read_text(encoding="utf-8")
        return _template_workspace_md()


def set_workspace_md(content: str) -> None:
    workspace_id = get_active_workspace_id()
    if not workspace_id:
        raise RuntimeError("active workspace is required to save workspace instructions")

    try:
        get_supabase_service_client().table("workspace_agent_settings").upsert(
            {
                "workspace_id": workspace_id,
                "instructions_md": content,
            },
            on_conflict="workspace_id",
        ).execute()
        return
    except Exception as exc:
        logger.warning("workspace_agent_settings write failed; using file fallback: %s", exc)
        path = _fallback_path(workspace_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def _binding_rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None) or []
    if isinstance(data, list):
        return [dict(row) for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        return [dict(data)]
    return []


def _clean_binding_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "workspace_id": str(row["workspace_id"]),
        "channel_type": str(row["channel_type"]),
        "external_team_id": row.get("external_team_id"),
        "external_channel_id": str(row["external_channel_id"]),
        "external_channel_name": row.get("external_channel_name"),
        "enabled": bool(row.get("enabled")),
        "updated_at": str(row.get("updated_at") or ""),
    }


def get_slack_binding(*, workspace_id: str | None = None) -> dict[str, Any] | None:
    workspace_id = workspace_id or get_active_workspace_id()
    if not workspace_id:
        return None
    response = (
        get_supabase_service_client()
        .table("workspace_agent_channel_bindings")
        .select(
            "id,workspace_id,channel_type,external_team_id,external_channel_id,"
            "external_channel_name,enabled,updated_at"
        )
        .eq("workspace_id", workspace_id)
        .eq("channel_type", "slack")
        .limit(1)
        .execute()
    )
    rows = _binding_rows(response)
    return _clean_binding_row(rows[0]) if rows else None


def upsert_slack_binding(
    *,
    workspace_id: str,
    external_channel_id: str,
    external_channel_name: str | None,
    external_team_id: str | None,
    enabled: bool,
) -> dict[str, Any]:
    payload = {
        "id": f"wacb_{uuid.uuid4().hex[:18]}",
        "workspace_id": workspace_id,
        "channel_type": "slack",
        "external_team_id": (external_team_id or "").strip() or None,
        "external_channel_id": external_channel_id.strip(),
        "external_channel_name": (external_channel_name or "").strip() or None,
        "enabled": bool(enabled),
    }
    response = (
        get_supabase_service_client()
        .table("workspace_agent_channel_bindings")
        .upsert(payload, on_conflict="workspace_id,channel_type")
        .execute()
    )
    rows = _binding_rows(response)
    return _clean_binding_row(rows[0]) if rows else get_slack_binding(workspace_id=workspace_id) or payload


def delete_slack_binding(*, workspace_id: str) -> int:
    response = (
        get_supabase_service_client()
        .table("workspace_agent_channel_bindings")
        .delete()
        .eq("workspace_id", workspace_id)
        .eq("channel_type", "slack")
        .execute()
    )
    return len(_binding_rows(response))


def resolve_slack_event_binding(*, team_id: str, channel_id: str) -> dict[str, Any] | None:
    if not channel_id:
        return None
    query = (
        get_supabase_service_client()
        .table("workspace_agent_channel_bindings")
        .select("id,workspace_id,external_team_id,external_channel_id,enabled")
        .eq("channel_type", "slack")
        .eq("external_channel_id", channel_id)
        .eq("enabled", True)
    )
    rows = _binding_rows(query.limit(10).execute())
    if team_id:
        rows = [
            row
            for row in rows
            if row.get("external_team_id") in {None, "", team_id}
        ]
    if not rows:
        return None
    rows.sort(key=lambda row: 0 if row.get("external_team_id") == team_id else 1)
    row = rows[0]
    workspace = workspace_repo.get(workspace_id=str(row["workspace_id"]))
    if not workspace:
        return None
    return {
        "workspace_id": str(row["workspace_id"]),
        "owner_user_id": str(workspace["owner_user_id"]),
        "binding_id": str(row["id"]),
    }


def workspace_agent_info(user_id: str) -> dict[str, Any]:
    # The engine owns workspace_agent_info + the system-prompt build; cloud only
    # layers the Supabase Slack-binding state on top. get_workspace_md is
    # overridden (above) so the engine's own _build_system_prompt already
    # reflects the Supabase-backed workspace.md — no cloud prompt reimplementation.
    if not callable(_original_workspace_agent_info):
        raise RuntimeError(
            "engine chat_service.workspace_agent_info is missing — cloud requires it"
        )
    info = dict(_original_workspace_agent_info(user_id))

    channels = dict(info.get("channels") or {})
    slack = dict(channels.get("slack") or {})
    try:
        slack["binding"] = get_slack_binding()
    except Exception as exc:
        logger.warning("workspace_agent_channel_bindings read failed: %s", exc)
        slack["binding"] = None
    channels["slack"] = slack
    info["channels"] = channels
    return info


def apply_cloud_workspace_agent_overrides() -> None:
    chat_service.get_workspace_md = get_workspace_md
    chat_service.set_workspace_md = set_workspace_md
    chat_service.workspace_agent_info = workspace_agent_info
