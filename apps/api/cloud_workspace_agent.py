from __future__ import annotations

import logging
import os
from pathlib import Path

from apps.api._engine import import_engine_module
from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api.config import get_supabase_service_client

logger = logging.getLogger("workeros.cloud.workspace_agent")

chat_service = import_engine_module("chat_service")
worker_registry = import_engine_module("worker_registry")

_DEFAULT_WORKSPACE_MD = "# Workspace\n\nNo workspace.md configured yet. PUT /workspace to set one."
_WORKSPACE_AGENT_ID = "workspace-agent"


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


def _engine_workspace_agent_skill_path() -> Path:
    engine_root = Path(chat_service.__file__).resolve().parents[2]
    return engine_root / "workers" / _WORKSPACE_AGENT_ID / "SKILL.md"


def _workspace_agent_skill_md() -> str:
    candidates = [
        Path(worker_registry.WORKERS_DIR) / _WORKSPACE_AGENT_ID / "SKILL.md",
        _engine_workspace_agent_skill_path(),
    ]
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    logger.warning("workspace-agent SKILL.md not found in %s", candidates)
    return ""


def build_system_prompt(user_id: str) -> str:
    workspace_content = get_workspace_md()
    preamble_fn = getattr(chat_service, "_build_workspace_preamble", None)
    preamble = preamble_fn(user_id) if callable(preamble_fn) else ""
    skill_md = _workspace_agent_skill_md().replace("{{WORKSPACE_PREAMBLE}}", preamble)
    return "\n\n".join(part for part in [workspace_content, skill_md] if part)


def apply_cloud_workspace_agent_overrides() -> None:
    chat_service.get_workspace_md = get_workspace_md
    chat_service.set_workspace_md = set_workspace_md
    chat_service._build_system_prompt = build_system_prompt
