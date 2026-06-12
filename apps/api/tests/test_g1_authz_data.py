"""g1 security batch — authorization / data-protection fixes.

Covers:
  #952 — secret mutation guard: members can't overwrite/delete secrets they
         didn't create (bites on workspace-scoped repos; no-op per-user).
  #919 — integration catalog endpoints require an auth context.
  #928 — rollback/restore SHAs must belong to the asset's own git history.
  #925/#948 — workspace export is admin-only and rate-limited per hour.
  #954 — POST /runs/clear requires the explicit confirm parameter.
  #934 — standalone share-link tokens are stored as SHA-256 hashes.

Run:
    cd apps/api && python -m pytest tests/test_g1_authz_data.py -v
"""
from __future__ import annotations

import hashlib
import importlib
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

GOOD_PASSWORD = "correct-horse-battery"
SECRET = "g1-authz-shared-secret"


def _load_main(monkeypatch, tmp_path, *, secret: str | None = None):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_INSECURE_COOKIES", "1")
    if secret is None:
        monkeypatch.delenv("FLOOM_SECRET", raising=False)
    else:
        monkeypatch.setenv("FLOOM_SECRET", secret)
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _client(main):
    from fastapi.testclient import TestClient

    return TestClient(main.app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# #952 — secret mutation ownership/role guard
# ---------------------------------------------------------------------------

class TestSecretMutationGuard:
    def _auth(self, main, *, user_id: str, role: str):
        from auth.context import AuthContext

        return AuthContext(user_id=user_id, role=role)

    def test_member_blocked_from_foreign_secret(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        member = self._auth(main, user_id="bob", role="member")
        existing = {"user_id": "alice", "name": "OPENAI_API_KEY"}
        with pytest.raises(HTTPException) as exc_info:
            main._require_secret_mutation_allowed(member, existing, "OPENAI_API_KEY")
        assert exc_info.value.status_code == 403

    def test_admin_can_mutate_any_secret(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        admin = self._auth(main, user_id="bob", role="admin")
        existing = {"user_id": "alice", "name": "OPENAI_API_KEY"}
        main._require_secret_mutation_allowed(admin, existing, "OPENAI_API_KEY")

    def test_creator_can_mutate_own_secret(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        member = self._auth(main, user_id="bob", role="member")
        existing = {"user_id": "bob", "name": "MY_KEY"}
        main._require_secret_mutation_allowed(member, existing, "MY_KEY")

    def test_new_secret_creation_allowed(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        member = self._auth(main, user_id="bob", role="member")
        main._require_secret_mutation_allowed(member, None, "NEW_KEY")

    def test_member_endpoint_set_and_delete_own_secret(self, monkeypatch, tmp_path):
        """Regression: per-user repos keep working for members end-to-end."""
        main = _load_main(monkeypatch, tmp_path)
        with _client(main) as admin:
            admin.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
            admin.post("/users", json={"username": "bob", "password": GOOD_PASSWORD, "role": "member"})
        with _client(main) as bob:
            bob.post("/auth/login", json={"username": "bob", "password": GOOD_PASSWORD})
            set_resp = bob.post("/secrets/G1_TEST_KEY", json={"value": "v-123"})
            assert set_resp.status_code == 200, set_resp.text
            del_resp = bob.delete("/secrets/G1_TEST_KEY")
            assert del_resp.status_code == 200, del_resp.text


# ---------------------------------------------------------------------------
# #919 — integration catalog requires auth
# ---------------------------------------------------------------------------

class TestCatalogAuth:
    def test_catalog_rejects_invalid_bearer(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path, secret=SECRET)
        with _client(main) as client:
            resp = client.get(
                "/integrations/catalog",
                headers={"Authorization": "Bearer wos_not-a-real-token"},
            )
        assert resp.status_code == 401, resp.text

    def test_catalog_tools_rejects_invalid_bearer(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path, secret=SECRET)
        with _client(main) as client:
            resp = client.get(
                "/integrations/catalog/gmail/tools",
                headers={"Authorization": "Bearer wos_not-a-real-token"},
            )
        assert resp.status_code == 401, resp.text

    def test_catalog_rejects_missing_credentials(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path, secret=SECRET)
        with _client(main) as client:
            resp = client.get("/integrations/catalog")
        assert resp.status_code == 401, resp.text


# ---------------------------------------------------------------------------
# #928 — SHA must belong to the asset's history
# ---------------------------------------------------------------------------

class TestShaInPathHistory:
    @pytest.fixture()
    def repo(self, tmp_path):
        repo = tmp_path / "ws"
        repo.mkdir()
        env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}

        def git(*args):
            import os

            return subprocess.run(
                ["git", *args], cwd=repo, capture_output=True, text=True, check=True,
                env={**os.environ, **env},
            )

        git("init", "-q")
        (repo / "a").mkdir()
        (repo / "a" / "f.txt").write_text("one")
        git("add", "a")
        git("commit", "-qm", "asset a")
        sha_a = git("rev-parse", "HEAD").stdout.strip()
        (repo / "b").mkdir()
        (repo / "b" / "g.txt").write_text("two")
        git("add", "b")
        git("commit", "-qm", "asset b")
        sha_b = git("rev-parse", "HEAD").stdout.strip()
        return repo, sha_a, sha_b

    def test_sha_from_own_history_accepted(self, repo):
        import git_ops

        path, sha_a, _ = repo
        assert git_ops.sha_in_path_history(path, sha_a, "a") is True

    def test_short_sha_accepted(self, repo):
        import git_ops

        path, sha_a, _ = repo
        assert git_ops.sha_in_path_history(path, sha_a[:7], "a") is True

    def test_foreign_asset_sha_rejected(self, repo):
        import git_ops

        path, _, sha_b = repo
        # sha_b exists in the repo but never touched asset "a"
        assert git_ops.sha_in_path_history(path, sha_b, "a") is False

    def test_garbage_sha_rejected(self, repo):
        import git_ops

        path, _, _ = repo
        assert git_ops.sha_in_path_history(path, "deadbeef", "a") is False
        assert git_ops.sha_in_path_history(path, "HEAD", "a") is False
        assert git_ops.sha_in_path_history(path, "", "a") is False
        assert git_ops.sha_in_path_history(path, "main -- a", "a") is False


# ---------------------------------------------------------------------------
# #925/#948 — workspace export: admin-only + hourly rate limit
# ---------------------------------------------------------------------------

class TestExportHardening:
    def test_member_export_forbidden(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        with _client(main) as admin:
            admin.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
            admin.post("/users", json={"username": "bob", "password": GOOD_PASSWORD, "role": "member"})
        with _client(main) as bob:
            bob.post("/auth/login", json={"username": "bob", "password": GOOD_PASSWORD})
            resp = bob.get("/workspace/export")
        assert resp.status_code == 403, resp.text

    def test_admin_export_allowed(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        with _client(main) as admin:
            admin.post("/auth/setup", json={"username": "alice", "password": GOOD_PASSWORD})
            resp = admin.get("/workspace/export")
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("application/zip")

    def test_export_rate_limited_per_hour(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path, secret=SECRET)
        with _client(main) as client:
            statuses = [
                client.get("/workspace/export", headers={"x-floom-secret": SECRET}).status_code
                for _ in range(6)
            ]
        assert statuses[:5] == [200] * 5, statuses
        assert statuses[5] == 429, statuses


# ---------------------------------------------------------------------------
# #954 — runs/clear requires explicit confirm
# ---------------------------------------------------------------------------

class TestRunsClearConfirm:
    def test_clear_without_confirm_rejected(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path, secret=SECRET)
        with _client(main) as client:
            resp = client.post("/runs/clear", headers={"x-floom-secret": SECRET}, json={})
        assert resp.status_code == 400, resp.text

    def test_clear_with_confirm_allowed(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path, secret=SECRET)
        monkeypatch.setenv("WORKEROS_PRECLEAR_BACKUP_DIR", str(tmp_path / "backups"))
        with _client(main) as client:
            resp = client.post(
                "/runs/clear?confirm=yes-wipe-all-runs",
                headers={"x-floom-secret": SECRET},
            )
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# #934 — share-link tokens hashed at rest
# ---------------------------------------------------------------------------

class TestShareTokenHashing:
    def test_raw_token_never_stored(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        import db as db_mod

        result = main._create_or_get_standalone_share_link(
            entity_type="worker", entity_id="w1", owner_id="alice"
        )
        token = result["token"]
        assert token.startswith("fls_")
        expected_hash = hashlib.sha256(token.encode()).hexdigest()
        with db_mod.get_db() as conn:
            row = conn.execute("SELECT token_hash FROM standalone_share_links").fetchone()
        assert row["token_hash"] == expected_hash
        assert row["token_hash"] != token

    def test_lookup_by_raw_token_resolves(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        result = main._create_or_get_standalone_share_link(
            entity_type="worker", entity_id="w1", owner_id="alice"
        )
        row = main._load_standalone_share_row(result["token"])
        assert row is not None
        assert row["entity_id"] == "w1"
        assert main._load_standalone_share_row("fls_" + "x" * 24) is None

    def test_reshare_rotates_token(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        first = main._create_or_get_standalone_share_link(
            entity_type="worker", entity_id="w1", owner_id="alice"
        )
        second = main._create_or_get_standalone_share_link(
            entity_type="worker", entity_id="w1", owner_id="alice"
        )
        assert first["token"] != second["token"]
        assert main._load_standalone_share_row(first["token"]) is None
        assert main._load_standalone_share_row(second["token"]) is not None

    def test_legacy_plaintext_rows_migrate_to_hashes(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        import db as db_mod

        legacy_token = "fls_LegacyToken1234567890ab"
        with db_mod.get_db() as conn:
            conn.execute("DROP TABLE IF EXISTS standalone_share_links")
            conn.executescript(
                """
                CREATE TABLE standalone_share_links (
                    token TEXT PRIMARY KEY,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    file_path TEXT NOT NULL DEFAULT '',
                    owner_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(entity_type, entity_id, file_path, owner_id)
                );
                """
            )
            conn.execute(
                "INSERT INTO standalone_share_links (token, entity_type, entity_id, file_path, owner_id, created_at) "
                "VALUES (?, 'worker', 'w-legacy', '', 'alice', '2026-01-01T00:00:00')",
                (legacy_token,),
            )

        row = main._load_standalone_share_row(legacy_token)
        assert row is not None and row["entity_id"] == "w-legacy"

        with db_mod.get_db() as conn:
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(standalone_share_links)")}
            stored = conn.execute("SELECT token_hash FROM standalone_share_links").fetchone()
        assert "token" not in cols
        assert stored["token_hash"] == hashlib.sha256(legacy_token.encode()).hexdigest()
