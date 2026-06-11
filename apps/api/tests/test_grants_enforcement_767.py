"""#767/#768 — grant ENFORCEMENT: a specific-people grantee gains VIEW access to
a private worker (list + detail), and NOTHING more (no edit/delete/run/share).

Companion to test_share_grants_767.py (which covers add/list/revoke of the grant
rows). This test covers the resolver hook that turns a stored grant into actual
visibility, and pins the security boundary: the grant must never let a non-owner
mutate the asset.
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

_SECRET = "grants-enforce-767"
_OWNER = "federico"
_OWNER_EMAIL = "federico@example.com"
_GRANTEE = "alice"
_GRANTEE_EMAIL = "alice@example.com"


def _yml(name: str) -> str:
    return f"""\
schema_version: "0.3"
name: "{name}"
title: "Alpha"
description: "A worker."
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "local"
  command: "python run.py"
inputs: []
outputs:
  - name: "summary"
    type: "markdown"
    required: true
connections: []
"""


@pytest.fixture
def ctx(monkeypatch, tmp_path):
    """Boot an isolated API and yield (client, as_user) where as_user(...) swaps
    the request identity. The override mirrors the real dependency by setting the
    auth contextvar, which the enforcement path reads to resolve the viewer email.
    """
    workers_dir = tmp_path / "workers"
    d = workers_dir / "alpha"
    d.mkdir(parents=True)
    (d / "worker.yml").write_text(_yml("alpha"), encoding="utf-8")
    (d / "run.py").write_text("print('x')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in ["db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
                 "db.interface", "models", "worker_registry", "run_service", "scheduler", "main"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=_OWNER)

    from fastapi.testclient import TestClient
    from auth.context import AuthContext, set_current_auth_context
    from auth.dependency import get_auth_context

    def as_user(user_id: str, email: str, role: str):
        async def _override() -> AuthContext:
            c = AuthContext(
                user_id=user_id, email=email, role=role,
                scopes=(role,), auth_method="session", username=None,
            )
            set_current_auth_context(c)
            return c
        main.app.dependency_overrides[get_auth_context] = _override

    # The global auth middleware gates on FLOOM_SECRET; send it so requests reach
    # the handler. The dependency override below sets the actual request identity.
    client = TestClient(main.app, headers={"x-floom-secret": _SECRET})
    try:
        yield client, as_user, (workers_dir / "alpha")
    finally:
        main.app.dependency_overrides.pop(get_auth_context, None)
        db.get_repositories.cache_clear()


def _grant_alpha_to_grantee(client, as_user) -> str:
    as_user(_OWNER, _OWNER_EMAIL, "admin")
    resp = client.post(
        "/share/grants",
        json={"asset_type": "worker", "asset_id": "alpha", "email": _GRANTEE_EMAIL},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def test_grantee_sees_worker_only_after_grant(ctx):
    client, as_user, _ = ctx

    # Before any grant the member does not see the owner's private worker.
    as_user(_GRANTEE, _GRANTEE_EMAIL, "member")
    listed = client.get("/workers")
    assert listed.status_code == 200, listed.text
    assert "alpha" not in {w["id"] for w in listed.json()}
    assert client.get("/workers/alpha").status_code == 404

    _grant_alpha_to_grantee(client, as_user)

    # After the grant the same member sees it in the list AND can open its detail.
    as_user(_GRANTEE, _GRANTEE_EMAIL, "member")
    listed = client.get("/workers")
    assert "alpha" in {w["id"] for w in listed.json()}

    detail = client.get("/workers/alpha")
    assert detail.status_code == 200, detail.text
    perms = detail.json()["permissions"]
    assert perms["can_view"] is True
    # The grant is VIEW only — never edit / delete / run / share.
    assert perms["is_owner"] is False
    assert perms["can_edit"] is False
    assert perms["can_delete"] is False
    assert perms["can_run"] is False
    assert perms["can_share"] is False


def test_grant_is_email_scoped(ctx):
    """A grant to alice must not leak the worker to a different member (bob)."""
    client, as_user, _ = ctx
    _grant_alpha_to_grantee(client, as_user)

    as_user("bob", "bob@example.com", "member")
    assert "alpha" not in {w["id"] for w in client.get("/workers").json()}
    assert client.get("/workers/alpha").status_code == 404


def test_grantee_cannot_mutate_or_destroy_worker(ctx):
    """Security boundary: a grantee gains VIEW only. Edit/delete must 404 and the
    worker (DB row + on-disk bundle) must survive a grantee's delete attempt."""
    client, as_user, bundle_dir = ctx
    _grant_alpha_to_grantee(client, as_user)

    as_user(_GRANTEE, _GRANTEE_EMAIL, "member")
    # Mutation endpoints gate on owner/workspace visibility (NOT grants), so the
    # grantee is 404 there — they can never reach an owner-scoped write or the
    # delete orphan-reap that would rmtree the bundle.
    assert client.delete("/workers/alpha").status_code == 404
    assert client.put(
        "/workers/alpha/visibility", json={"visibility": "workspace"}
    ).status_code == 404

    # The bundle dir is untouched and the owner still has the worker.
    assert bundle_dir.is_dir()
    as_user(_OWNER, _OWNER_EMAIL, "admin")
    assert client.get("/workers/alpha").status_code == 200


def test_revoking_grant_removes_access(ctx):
    client, as_user, _ = ctx
    gid = _grant_alpha_to_grantee(client, as_user)

    as_user(_GRANTEE, _GRANTEE_EMAIL, "member")
    assert client.get("/workers/alpha").status_code == 200

    as_user(_OWNER, _OWNER_EMAIL, "admin")
    assert client.delete(f"/share/grants/{gid}").status_code == 204

    as_user(_GRANTEE, _GRANTEE_EMAIL, "member")
    assert client.get("/workers/alpha").status_code == 404
    assert "alpha" not in {w["id"] for w in client.get("/workers").json()}
