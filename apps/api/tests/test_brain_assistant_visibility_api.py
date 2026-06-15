"""Members STEP 4-5: brain pack + assistant visibility ENDPOINTS.

Verifies the engine API surface that the web Share control consumes:
  - /contexts list + detail carry owner_id / visibility / permissions
  - PUT /contexts/{name}/visibility flips Private <-> Shared
  - GET /system/workspace-agent carries owner_id / visibility / permissions
    (default 'workspace') and PUT /system/workspace-agent/visibility flips it.
On the OSS single-owner engine the local user owns everything, so the toggle
always succeeds for them and existing packs default to private.
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


@pytest.fixture()
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    # An existing operator pack owned by the local user (federico).
    pack = contexts_dir / "company"
    pack.mkdir()
    (pack / "README.md").write_text("# Company\nicp.\n", encoding="utf-8")
    (contexts_dir / ".workeros-contexts.json").write_text(
        '{"company": {"owner_id": "federico", "writeable": true}}\n',
        encoding="utf-8",
    )

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-vis")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "0")

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts", "chat_service",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-vis"}) as client:
        yield client, main
    db.get_repositories.cache_clear()


# ---------------------------------------------------------------------------
# Brain pack
# ---------------------------------------------------------------------------

def test_existing_pack_defaults_private_with_permissions(client_and_main):
    client, _main = client_and_main
    items = {c["name"]: c for c in client.get("/contexts").json()}
    assert "company" in items
    pack = items["company"]
    assert pack["visibility"] == "private"
    assert pack["owner_id"] == "federico"
    # Owner can share/edit on the single-owner engine.
    assert pack["permissions"]["can_share"] is True
    assert pack["permissions"]["is_owner"] is True


def test_pack_detail_carries_visibility(client_and_main):
    client, _main = client_and_main
    detail = client.get("/contexts/company").json()
    assert detail["visibility"] == "private"
    assert detail["owner_id"] == "federico"
    assert detail["permissions"]["can_share"] is True


def test_put_visibility_shares_pack(client_and_main):
    client, _main = client_and_main
    resp = client.put("/contexts/company/visibility", json={"visibility": "workspace"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["visibility"] == "workspace"
    # Persisted on subsequent reads.
    assert client.get("/contexts/company").json()["visibility"] == "workspace"
    # And back to private.
    back = client.put("/contexts/company/visibility", json={"visibility": "private"})
    assert back.json()["visibility"] == "private"


def test_put_visibility_rejects_invalid(client_and_main):
    client, _main = client_and_main
    resp = client.put("/contexts/company/visibility", json={"visibility": "public"})
    assert resp.status_code == 422  # pydantic enum rejection


def test_new_pack_defaults_private(client_and_main):
    client, _main = client_and_main
    created = client.post("/contexts/fresh")
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["visibility"] == "private"
    assert body["owner_id"] == "federico"


def test_new_pack_uses_active_workspace_for_brain_pack_row(client_and_main):
    client, main = client_and_main
    import git_ops

    class _Workers:
        def list(self, *, user_id: str):
            return []

    class _AssetAccess:
        def __init__(self):
            self.ensure_calls = []
            self.permission_calls = []

        def ensure_brain_pack(self, **kwargs):
            self.ensure_calls.append(kwargs)
            return {
                "id": kwargs["pack_id"],
                "owner_id": kwargs["owner_id"],
                "workspace_id": kwargs["workspace_id"],
                "visibility": "private",
            }

        def get_permissions(self, **kwargs):
            self.permission_calls.append(kwargs)
            return {
                "is_owner": True,
                "can_view": True,
                "can_edit": True,
                "can_run": True,
                "can_delete": True,
                "can_share": True,
                "visibility": "private",
            }

    class _Repos:
        def __init__(self, asset_access):
            self.asset_access = asset_access
            self.workers = _Workers()

    asset_access = _AssetAccess()
    repos = _Repos(asset_access)
    main.app.dependency_overrides[main.get_repos] = lambda: repos
    git_ops.set_workspace_id_resolver(lambda: "cloud-workspace-1")
    try:
        created = client.post("/contexts/cloudpack")
    finally:
        main.app.dependency_overrides.pop(main.get_repos, None)
        git_ops.set_workspace_id_resolver(None)

    assert created.status_code == 200, created.text
    assert asset_access.ensure_calls
    assert {call["workspace_id"] for call in asset_access.ensure_calls} == {"cloud-workspace-1"}
    assert asset_access.permission_calls
    assert {call["workspace_id"] for call in asset_access.permission_calls} == {"cloud-workspace-1"}


def test_visibility_on_unknown_pack_404(client_and_main):
    client, _main = client_and_main
    resp = client.put("/contexts/nope/visibility", json={"visibility": "workspace"})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Assistant
# ---------------------------------------------------------------------------

def test_assistant_defaults_workspace_with_permissions(client_and_main):
    client, _main = client_and_main
    info = client.get("/system/workspace-agent").json()
    assert info["visibility"] == "workspace"
    assert info["owner_id"] == "federico"
    assert info["permissions"]["can_share"] is True
    assert info["permissions"]["is_owner"] is True


def test_put_assistant_visibility_to_private_and_back(client_and_main):
    client, _main = client_and_main
    resp = client.put(
        "/system/workspace-agent/visibility", json={"visibility": "private"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["visibility"] == "private"
    assert client.get("/system/workspace-agent").json()["visibility"] == "private"
    back = client.put(
        "/system/workspace-agent/visibility", json={"visibility": "workspace"}
    )
    assert back.json()["visibility"] == "workspace"


def test_put_assistant_visibility_rejects_invalid(client_and_main):
    client, _main = client_and_main
    resp = client.put(
        "/system/workspace-agent/visibility", json={"visibility": "everyone"}
    )
    assert resp.status_code == 422
