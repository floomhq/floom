"""#507: engine backup files must never become authoritative worker files."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from services.worker_registry_ops import _embed_files_in_skill_version
from services.worker_serialize import (
    _is_secret_bearing_export_path,
    _should_ignore_worker_file,
)


def test_worker_file_ignore_drops_engine_backup_artifacts():
    assert _should_ignore_worker_file("run.py.bak1")
    assert _should_ignore_worker_file("lib/search.py.bak123")
    assert _should_ignore_worker_file("worker.yml.bak999")
    assert _should_ignore_worker_file("lib/__pycache__/mod.pyc")

    assert not _should_ignore_worker_file("run.py")
    assert not _should_ignore_worker_file("lib/search.py")
    assert not _should_ignore_worker_file(".python-version")


def test_worker_file_ignore_drops_credential_files_1681():
    # #1681: credential/secret-bearing files must never surface in the worker
    # Source file tree. The reported leak was vertex-wif-cred.json.
    assert _should_ignore_worker_file("vertex-wif-cred.json")
    assert _should_ignore_worker_file("config/vertex-wif-cred.json")
    assert _should_ignore_worker_file("gcp-service-account.json")
    assert _should_ignore_worker_file("my_service_account.json")
    assert _should_ignore_worker_file("prod-sa.json")
    assert _should_ignore_worker_file("app_creds.json")
    assert _should_ignore_worker_file(".env")
    assert _should_ignore_worker_file(".env.production")
    assert _should_ignore_worker_file("server.pem")
    assert _should_ignore_worker_file("client.key")
    assert _should_ignore_worker_file("credentials.json")

    # Legitimate worker files must still be listed.
    assert not _should_ignore_worker_file("run.py")
    assert not _should_ignore_worker_file("worker.yml")
    assert not _should_ignore_worker_file("data/results.json")
    assert not _should_ignore_worker_file("schema.json")
    assert not _should_ignore_worker_file("package.json")


def test_is_secret_bearing_export_path_credential_patterns_1681():
    assert _is_secret_bearing_export_path("vertex-wif-cred.json")
    assert _is_secret_bearing_export_path("foo/bar/gcp-service-account.json")
    assert _is_secret_bearing_export_path("svc_sa.json")
    assert _is_secret_bearing_export_path(".secrets.enc")
    assert _is_secret_bearing_export_path(".git-credentials")
    assert _is_secret_bearing_export_path("github-actions-cred.json")
    assert _is_secret_bearing_export_path("id_rsa")
    assert _is_secret_bearing_export_path("token.pem")
    # Not a credential file (delimited-token match avoids false positives).
    assert not _is_secret_bearing_export_path("results.json")
    assert not _is_secret_bearing_export_path("github-digest.json")
    assert not _is_secret_bearing_export_path("manifest.json")
    assert not _is_secret_bearing_export_path("my-wifi.json")
    assert not _is_secret_bearing_export_path("usa.json")
    assert not _is_secret_bearing_export_path("visa.json")
    assert not _is_secret_bearing_export_path("package.json")
    assert not _is_secret_bearing_export_path("tsconfig.json")


def test_embed_files_skips_bak_files_and_preserves_canonical_files(monkeypatch, tmp_path):
    worker_dir = tmp_path / "workers" / "partial-worker"
    (worker_dir / "lib").mkdir(parents=True)
    (worker_dir / "worker.yml").write_text("name: partial-worker\n", encoding="utf-8")
    (worker_dir / "run.py").write_text("print('canonical')\n", encoding="utf-8")
    (worker_dir / "run.py.bak1").write_text("print('backup')\n", encoding="utf-8")
    (worker_dir / "lib" / "search.py").write_text("def search(): pass\n", encoding="utf-8")
    (worker_dir / "lib" / "search.py.bak1").write_text("def old(): pass\n", encoding="utf-8")

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE workers (id TEXT PRIMARY KEY, skill_version_id TEXT NOT NULL);
        CREATE TABLE skill_versions (id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL);
        INSERT INTO workers (id, skill_version_id) VALUES ('partial-worker', 'sv1');
        INSERT INTO skill_versions (id, manifest_json) VALUES ('sv1', '{"name":"partial-worker"}');
        """
    )

    @contextmanager
    def fake_get_db():
        yield conn

    import db

    monkeypatch.setattr(db, "get_db", fake_get_db)

    _embed_files_in_skill_version("partial-worker", worker_dir)

    row = conn.execute("SELECT manifest_json FROM skill_versions WHERE id = 'sv1'").fetchone()
    files = json.loads(row["manifest_json"])["_files"]
    assert files == {
        "worker.yml": "name: partial-worker\n",
        "run.py": "print('canonical')\n",
        "lib/search.py": "def search(): pass\n",
    }
    assert not any(".bak" in path for path in files)
