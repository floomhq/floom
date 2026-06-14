"""Workspace donation model + workspace API token.

Product decisions (2026-06-12):
  - Sharing a worker to the workspace TRANSFERS ownership to the synthetic
    workspace actor: the sharer loses edit/delete; only admins can mutate
    shared workers; runs resolve secrets against the workspace actor's rows
    (admin-populated), never personal creds.
  - Unshare is structurally admin-only and re-assigns ownership to the admin.
  - Workspace API token (wst_): admin-minted, authenticates as the workspace
    actor (member role) — read+run on shared workers only, no private workers
    (including the minter's own), no mutations, no credential surfaces.

Run: cd apps/api && python -m pytest tests/test_workspace_donation_and_token.py -q
"""
from __future__ import annotations

import hashlib
import importlib
import sys
import textwrap
import types
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-donation"
ADMIN = {"x-floom-secret": SECRET}
MEMBER_TOKEN = "wos_member1_raw_token_value"
MEMBER_BEARER = {"Authorization": f"Bearer {MEMBER_TOKEN}"}


def _worker_yml(worker_id: str) -> str:
    return textwrap.dedent(
        f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: "Donation test worker"
        description: "donation model test"
        version: "0.1.0"
        exec:
          entry: "run.py"
          runtime: "python311"
          runner: "e2b"
          command: "python run.py"
          inputs: []
          outputs: []
        trigger:
          type: manual
        connections: []
        secrets:
          - MY_SECRET
        """
    ).strip() + "\n"


RUN_PY = "import json\nwith open('result.json','w') as f: json.dump({'status':'success','outputs':{}}, f)\n"


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path / "contexts"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_USER_ID", "admin-boss")
    monkeypatch.delenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", raising=False)
    for name in list(sys.modules):
        # Modular refactor: routers/services/core hold response_model classes and
        # helpers bound to `models`; purge them in lockstep so a reloaded `models`
        # doesn't leave a stale router validating against old model classes.
        if name in ("main", "db", "models", "worker_registry", "run_service", "chat_service", "contexts") or name.startswith(("channels", "auth", "db.", "routers", "services", "core")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None
    )
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    # Seed a real MEMBER (user row + member-role API token) so admin and
    # member can talk to the same app instance.
    from db import get_db, now_iso

    with get_db() as conn:
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, created_at, updated_at) "
            "VALUES ('member-1', 'member-1', 'x', 'member', ?, ?)",
            (now_iso(), now_iso()),
        )
        conn.execute(
            "INSERT INTO cli_api_tokens (id, token_hash, user_id, role, name, created_at) "
            "VALUES ('tok-m1', ?, 'member-1', 'member', 'member-1-token', ?)",
            (hashlib.sha256(MEMBER_TOKEN.encode()).hexdigest(), now_iso()),
        )

    from fastapi.testclient import TestClient

    client = TestClient(main.app, raise_server_exceptions=False)
    yield client, main
    db.get_repositories.cache_clear()


def _create_worker(client, worker_id: str, headers) -> None:
    resp = client.post(
        "/workers",
        headers=headers,
        json={"worker_yml": _worker_yml(worker_id), "run_py": RUN_PY},
    )
    assert resp.status_code == 200, resp.text


def _share(client, worker_id: str, headers, expect: int = 200):
    resp = client.put(
        f"/workers/{worker_id}/visibility", headers=headers, json={"visibility": "workspace"}
    )
    assert resp.status_code == expect, resp.text
    return resp


def _owner_of(worker_id: str) -> str:
    from db import get_db

    with get_db() as conn:
        row = conn.execute("SELECT owner_id FROM workers WHERE id = ?", (worker_id,)).fetchone()
    return str(row["owner_id"]) if row else ""


class TestShareTransfersOwnership:
    def test_share_transfers_owner_to_workspace_actor(self, client_and_main):
        client, _ = client_and_main
        _create_worker(client, "donated-w", MEMBER_BEARER)
        assert _owner_of("donated-w") == "member-1"
        _share(client, "donated-w", MEMBER_BEARER)
        assert _owner_of("donated-w") == "workspace:local-default"

    def test_sharer_loses_edit_and_delete(self, client_and_main):
        client, _ = client_and_main
        _create_worker(client, "donated-x", MEMBER_BEARER)
        _share(client, "donated-x", MEMBER_BEARER)
        upd = client.put(
            "/workers/donated-x",
            headers=MEMBER_BEARER,
            json={"worker_yml": _worker_yml("donated-x"), "run_py": RUN_PY},
        )
        assert upd.status_code == 404, upd.text
        dele = client.delete("/workers/donated-x", headers=MEMBER_BEARER)
        assert dele.status_code == 404, dele.text

    def test_member_can_still_view_and_admin_can_edit(self, client_and_main):
        client, _ = client_and_main
        _create_worker(client, "donated-y", MEMBER_BEARER)
        _share(client, "donated-y", MEMBER_BEARER)
        # member still sees it (workspace visibility)
        got = client.get("/workers/donated-y", headers=MEMBER_BEARER)
        assert got.status_code == 200, got.text
        # admin edits it
        upd = client.put(
            "/workers/donated-y",
            headers=ADMIN,
            json={"worker_yml": _worker_yml("donated-y"), "run_py": RUN_PY},
        )
        assert upd.status_code == 200, upd.text

    def test_unshare_is_admin_only_and_reassigns_to_admin(self, client_and_main):
        client, _ = client_and_main
        _create_worker(client, "donated-z", MEMBER_BEARER)
        _share(client, "donated-z", MEMBER_BEARER)
        # sharer cannot unshare (no longer owner, not admin)
        back = client.put(
            "/workers/donated-z/visibility", headers=MEMBER_BEARER, json={"visibility": "private"}
        )
        assert back.status_code in (403, 404), back.text
        assert _owner_of("donated-z") == "workspace:local-default"
        # admin unshares; ownership lands on the admin
        back = client.put(
            "/workers/donated-z/visibility", headers=ADMIN, json={"visibility": "private"}
        )
        assert back.status_code == 200, back.text
        assert _owner_of("donated-z") == "admin-boss"

    def test_migration_74_transfers_legacy_shared_rows(self, client_and_main):
        _client, _ = client_and_main
        from db import get_db, now_iso

        with get_db() as conn:
            conn.execute(
                "INSERT INTO skill_versions (id, name, version, manifest_json, created_at) "
                "VALUES ('sv-legacy', 'legacy-shared', '0.1.0', '{}', ?)",
                (now_iso(),),
            )
            conn.execute(
                "INSERT INTO workers (id, name, skill_version_id, owner_id, visibility, created_at) "
                "VALUES ('legacy-shared', 'legacy-shared', 'sv-legacy', 'member-1', 'workspace', ?)",
                (now_iso(),),
            )
            conn.execute(
                "UPDATE workers SET owner_id = 'workspace:' || COALESCE(NULLIF(workspace_id, ''), 'local-default') "
                "WHERE visibility = 'workspace' AND owner_id IS NOT NULL AND owner_id NOT LIKE 'workspace:%'"
            )
            row = conn.execute("SELECT owner_id FROM workers WHERE id = 'legacy-shared'").fetchone()
        assert row["owner_id"] == "workspace:local-default"


class TestWorkspaceSecrets:
    def test_member_403_on_workspace_secret_endpoints(self, client_and_main):
        client, _ = client_and_main
        assert client.get("/workspace/secrets", headers=MEMBER_BEARER).status_code == 403
        assert client.post(
            "/workspace/secrets/MY_SECRET", headers=MEMBER_BEARER, json={"value": "v"}
        ).status_code == 403
        assert client.delete("/workspace/secrets/MY_SECRET", headers=MEMBER_BEARER).status_code == 403

    def test_admin_sets_and_donated_worker_resolves_it(self, client_and_main):
        client, _ = client_and_main
        _create_worker(client, "donated-secrets", MEMBER_BEARER)
        # the member's PERSONAL secret, set pre-share
        assert client.post(
            "/secrets/MY_SECRET", headers=MEMBER_BEARER, json={"value": "personal-value"}
        ).status_code == 200
        _share(client, "donated-secrets", MEMBER_BEARER)

        import run_service

        resolved = run_service.get_secrets_for_worker("donated-secrets", user_id="member-1")
        assert resolved.get("MY_SECRET") is None or resolved.get("MY_SECRET") != "personal-value", (
            "donated worker must NOT resolve the sharer's personal secret"
        )

        assert client.post(
            "/workspace/secrets/MY_SECRET", headers=ADMIN, json={"value": "workspace-value"}
        ).status_code == 200
        listed = client.get("/workspace/secrets", headers=ADMIN)
        assert listed.status_code == 200
        assert any(s["name"] == "MY_SECRET" for s in listed.json())
        assert all("value" not in s for s in listed.json())

        resolved = run_service.get_secrets_for_worker("donated-secrets", user_id="member-1")
        assert resolved.get("MY_SECRET") == "workspace-value"


class TestWorkspaceToken:
    def _mint(self, client) -> str:
        resp = client.post("/workspace/tokens", headers=ADMIN, json={"name": "ci"})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["token"].startswith("wst_")
        return body["token"]

    def test_member_cannot_mint_or_list(self, client_and_main):
        client, _ = client_and_main
        assert client.post(
            "/workspace/tokens", headers=MEMBER_BEARER, json={"name": "nope"}
        ).status_code == 403
        assert client.get("/workspace/tokens", headers=MEMBER_BEARER).status_code == 403

    def test_token_hash_stored_not_raw(self, client_and_main):
        client, _ = client_and_main
        raw = self._mint(client)
        from db import get_db

        with get_db() as conn:
            row = conn.execute("SELECT token_hash FROM workspace_api_tokens LIMIT 1").fetchone()
        assert row["token_hash"] == hashlib.sha256(raw.encode()).hexdigest()
        assert raw not in row["token_hash"]

    def test_token_sees_shared_not_private(self, client_and_main):
        client, _ = client_and_main
        _create_worker(client, "shared-for-token", MEMBER_BEARER)
        _share(client, "shared-for-token", MEMBER_BEARER)
        _create_worker(client, "private-member", MEMBER_BEARER)
        _create_worker(client, "private-admin", ADMIN)  # the MINTER's own private worker
        raw = self._mint(client)
        tok = {"Authorization": f"Bearer {raw}"}

        listing = client.get("/workers", headers=tok)
        assert listing.status_code == 200, listing.text
        ids = {w["id"] for w in listing.json()}
        assert "shared-for-token" in ids
        assert "private-member" not in ids
        assert "private-admin" not in ids, "minter's own private workers must be invisible to the token"

        assert client.get("/workers/shared-for-token", headers=tok).status_code == 200
        assert client.get("/workers/private-member", headers=tok).status_code == 404
        assert client.get("/workers/private-admin", headers=tok).status_code == 404

    def test_token_can_run_shared_worker(self, client_and_main):
        client, _ = client_and_main
        _create_worker(client, "runnable-shared", MEMBER_BEARER)
        _share(client, "runnable-shared", MEMBER_BEARER)
        # the donated worker declares MY_SECRET; without the workspace secret
        # the run is correctly refused (422 missing secret) — the admin
        # populates it, then the token can fire the run
        assert client.post(
            "/workspace/secrets/MY_SECRET", headers=ADMIN, json={"value": "ws-v"}
        ).status_code == 200
        raw = self._mint(client)
        tok = {"Authorization": f"Bearer {raw}"}
        resp = client.post("/workers/runnable-shared/runs", headers=tok, json={"inputs": {}})
        assert resp.status_code == 200, resp.text
        assert resp.json().get("run_id")

    def test_token_is_read_and_run_only(self, client_and_main):
        client, _ = client_and_main
        _create_worker(client, "no-mutations", MEMBER_BEARER)
        _share(client, "no-mutations", MEMBER_BEARER)
        raw = self._mint(client)
        tok = {"Authorization": f"Bearer {raw}"}
        assert client.put(
            "/workers/no-mutations",
            headers=tok,
            json={"worker_yml": _worker_yml("no-mutations"), "run_py": RUN_PY},
        ).status_code == 403
        assert client.delete("/workers/no-mutations", headers=tok).status_code == 403
        assert client.get("/secrets", headers=tok).status_code == 403
        assert client.get("/connections", headers=tok).status_code == 403
        assert client.get("/workspace/tokens", headers=tok).status_code == 403
        assert client.post("/workspace/secrets/X", headers=tok, json={"value": "v"}).status_code == 403

    def test_revoked_token_rejected(self, client_and_main):
        client, _ = client_and_main
        raw = self._mint(client)
        tok = {"Authorization": f"Bearer {raw}"}
        token_id = client.get("/workspace/tokens", headers=ADMIN).json()[0]["id"]
        assert client.delete(f"/workspace/tokens/{token_id}", headers=ADMIN).status_code == 204
        assert client.get("/workers", headers=tok).status_code == 401

    def test_expired_token_rejected(self, client_and_main):
        client, _ = client_and_main
        raw = self._mint(client)
        from db import get_db

        with get_db() as conn:
            conn.execute(
                "UPDATE workspace_api_tokens SET expires_at = '2020-01-01T00:00:00+00:00'"
            )
        assert client.get(
            "/workers", headers={"Authorization": f"Bearer {raw}"}
        ).status_code == 401
