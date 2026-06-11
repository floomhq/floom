"""#866 — workspace.md / workspace.base.md must be per-workspace, not
process-global, so one workspace's instructions never leak into another's
assembled prompt.

Root cause: WORKSPACE_MD_PATH / WORKSPACE_BASE_PERSONA_PATH were module-level
constants resolved once, so every local workspace shared the same file. Fix:
get/set_workspace_md and the base-persona helpers resolve the path for the
ACTIVE workspace (cloud resolver or the OSS scoped __ws_<hex> user id),
falling back to the legacy global path only for the default workspace.

Run: cd apps/api && python -m pytest tests/test_workspace_prompt_isolation.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

# two valid non-default workspace ids (ws_<14 hex>)
WS_A = "ws_aaaaaaaaaaaaaa"
WS_B = "ws_bbbbbbbbbbbbbb"


@pytest.fixture
def cs(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in list(sys.modules):
        if name in ("chat_service", "db") or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    import chat_service
    from auth.context import AuthContext, set_current_auth_context
    return chat_service, AuthContext, set_current_auth_context


def _activate(set_ctx, AuthContext, workspace_id):
    # OSS scoped user id embeds the workspace as base__ws_<hex>
    uid = f"federico__{workspace_id}" if workspace_id else "federico"
    set_ctx(AuthContext(user_id=uid, email=None, role="admin"))


def test_workspace_md_does_not_leak_across_workspaces(cs):
    chat_service, AuthContext, set_ctx = cs

    _activate(set_ctx, AuthContext, WS_A)
    chat_service.set_workspace_md("SECRET-A: workspace A private instructions")

    _activate(set_ctx, AuthContext, WS_B)
    chat_service.set_workspace_md("SECRET-B: workspace B private instructions")

    # each workspace reads ONLY its own instructions
    _activate(set_ctx, AuthContext, WS_A)
    a = chat_service.get_workspace_md()
    assert "SECRET-A" in a
    assert "SECRET-B" not in a

    _activate(set_ctx, AuthContext, WS_B)
    b = chat_service.get_workspace_md()
    assert "SECRET-B" in b
    assert "SECRET-A" not in b


def test_base_persona_isolated_across_workspaces(cs):
    chat_service, AuthContext, set_ctx = cs

    _activate(set_ctx, AuthContext, WS_A)
    chat_service.set_workspace_base_persona("PERSONA-A")
    assert chat_service.base_persona_is_custom() is True

    # workspace B has no override -> falls back to engine default, NOT A's
    _activate(set_ctx, AuthContext, WS_B)
    assert chat_service.base_persona_is_custom() is False
    assert "PERSONA-A" not in chat_service.get_workspace_base_persona()


def test_default_workspace_uses_legacy_global_path(cs):
    chat_service, AuthContext, set_ctx = cs
    # no active non-default workspace -> legacy global WORKSPACE_MD_PATH
    _activate(set_ctx, AuthContext, None)
    assert chat_service._active_non_default_workspace_id() is None
    assert chat_service._workspace_md_path() == chat_service.WORKSPACE_MD_PATH
    chat_service.set_workspace_md("DEFAULT-WS instructions")
    assert chat_service.WORKSPACE_MD_PATH.read_text() == "DEFAULT-WS instructions"


def test_traversal_or_bad_workspace_id_rejected(cs):
    chat_service, AuthContext, set_ctx = cs
    # a malformed/forged workspace suffix must NOT produce a per-workspace path
    set_ctx(AuthContext(user_id="federico__ws_../../etc", email=None, role="admin"))
    assert chat_service._active_non_default_workspace_id() is None
    assert chat_service._workspace_md_path() == chat_service.WORKSPACE_MD_PATH
