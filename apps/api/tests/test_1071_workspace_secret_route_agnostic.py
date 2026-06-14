"""#1071 — the POST /workspace/secrets/{name} route must NOT hard-import the
SQLite-specific db.sqlite.workspace_actor_id and pass a synthetic actor across
the Repositories boundary. It now calls repos.secrets.set_workspace_secret with
the REAL authenticated actor + workspace_id, so a non-SQLite repo (Supabase)
receives a usable owner id instead of an invalid synthetic one (the 500).
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from routers import workspace as ws_router


def test_route_passes_real_actor_and_workspace_not_synthetic(monkeypatch):
    captured: dict = {}

    class FakeSecrets:
        # A non-SQLite repo: only the repo-agnostic method, no actor encoding.
        def set_workspace_secret(self, *, workspace_id, actor_id, name, value, status="set"):
            captured.update(
                workspace_id=workspace_id, actor_id=actor_id, name=name, value=value
            )
            return {"name": name, "status": status}

    monkeypatch.setattr(ws_router, "_active_workspace_id", lambda request: "ws-123")
    auth = SimpleNamespace(is_admin=True, user_id="real-user-uuid", role="owner")
    repos = SimpleNamespace(secrets=FakeSecrets())
    payload = ws_router._WorkspaceSecretWrite(value="topsecret")

    out = ws_router.set_workspace_secret("FOO", payload, request=None, auth=auth, repos=repos)

    assert out == {"ok": True, "name": "FOO"}
    assert captured["actor_id"] == "real-user-uuid"
    assert captured["workspace_id"] == "ws-123"
    assert not captured["actor_id"].startswith("workspace:")  # no synthetic SQLite actor
    assert captured["value"] == "topsecret"
