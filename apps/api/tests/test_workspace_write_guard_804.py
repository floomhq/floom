"""#804: server-side member read-only guard on PUT /workspace and PUT /workspace/base.

Members must be blocked by the SERVER (403), not merely hidden in the UI — this is
the security fix Federico flagged to land before any member-facing assistant UI.

Two layers of proof:
  1. Unit — the guard helper `_require_workspace_write` directly: admin/owner allowed,
     run-token (AI worker-authoring) allowed, human member denied.
  2. Integration — the live endpoints reject a member with 403 and accept an admin,
     using FastAPI dependency_overrides to inject each role (no DB/session setup).
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Unit: the guard helper in isolation
# ---------------------------------------------------------------------------

class TestRequireWorkspaceWrite:
    def _guard_and_ctx(self):
        import main
        from auth import AuthContext
        return main._require_workspace_write, AuthContext

    def test_admin_allowed(self):
        guard, AuthContext = self._guard_and_ctx()
        guard(AuthContext(user_id="u", role="admin"))  # no raise

    def test_admin_via_scope_allowed(self):
        guard, AuthContext = self._guard_and_ctx()
        guard(AuthContext(user_id="u", role="member", scopes=("admin",)))  # no raise

    def test_run_token_member_allowed(self):
        """AI worker-authoring uses a run token that carries role='member' by design;
        it must still be able to write (records as source='ai')."""
        guard, AuthContext = self._guard_and_ctx()
        guard(AuthContext(user_id="u", role="member", auth_method="run_token"))  # no raise

    def test_human_member_denied(self):
        guard, AuthContext = self._guard_and_ctx()
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            guard(AuthContext(user_id="u", role="member", auth_method="session"))
        assert exc.value.status_code == 403

    def test_human_member_via_pat_denied(self):
        guard, AuthContext = self._guard_and_ctx()
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc:
            guard(AuthContext(user_id="u", role="member", auth_method="pat"))
        assert exc.value.status_code == 403


# ---------------------------------------------------------------------------
# Integration: the endpoints enforce the guard for each injected role
# ---------------------------------------------------------------------------

@pytest.fixture()
def app_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-804")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts", "chat_service",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    chat_service = importlib.import_module("chat_service")

    monkeypatch.setattr(chat_service, "WORKSPACE_MD_PATH", tmp_path / "workspace.md")
    monkeypatch.setattr(chat_service, "WORKSPACE_BASE_PERSONA_PATH", tmp_path / "workspace.base.md")
    monkeypatch.setattr(main, "WORKSPACE_BASE_PERSONA_PATH", tmp_path / "workspace.base.md", raising=False)

    yield main
    main.app.dependency_overrides.clear()
    db.get_repositories.cache_clear()


def _as_role(main, **ctx_kwargs):
    from auth import AuthContext, get_auth_context
    main.app.dependency_overrides[get_auth_context] = lambda: AuthContext(**ctx_kwargs)


@pytest.fixture()
def client(app_main):
    from fastapi.testclient import TestClient
    with TestClient(app_main.app, headers={"x-floom-secret": "test-secret-804"}) as c:
        yield c


PUT_PATHS = ["/workspace", "/workspace/base"]


@pytest.mark.parametrize("path", PUT_PATHS)
def test_member_put_forbidden(app_main, client, path):
    _as_role(app_main, user_id="bob", role="member", auth_method="session")
    resp = client.put(path, content="# hacked by member",
                      headers={"content-type": "text/markdown"})
    assert resp.status_code == 403, resp.text


@pytest.mark.parametrize("path", PUT_PATHS)
def test_admin_put_allowed(app_main, client, path):
    _as_role(app_main, user_id="alice", role="admin")
    resp = client.put(path, content="# legit admin edit",
                      headers={"content-type": "text/markdown"})
    assert resp.status_code == 204, resp.text


@pytest.mark.parametrize("path", PUT_PATHS)
def test_run_token_put_allowed(app_main, client, path):
    """AI worker-authoring must still pass the guard."""
    # auth_method='run_token' is what the guard checks; no header needed (a real
    # wrt_ header would be validated by middleware before the override applies).
    _as_role(app_main, user_id="federico", role="member", auth_method="run_token",
             run_token_payload={"user_id": "federico"})
    resp = client.put(path, content="# authored by a worker",
                      headers={"content-type": "text/markdown"})
    assert resp.status_code == 204, resp.text
