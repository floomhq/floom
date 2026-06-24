"""#507: engine backup files must never become authoritative worker files."""

from __future__ import annotations

import pytest

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
    assert _is_secret_bearing_export_path("token.pem")
    # Not a credential file (delimited-token match avoids false positives).
    assert not _is_secret_bearing_export_path("results.json")
    assert not _is_secret_bearing_export_path("manifest.json")
    assert not _is_secret_bearing_export_path("my-wifi.json")
    assert not _is_secret_bearing_export_path("usa.json")
    assert not _is_secret_bearing_export_path("visa.json")
    assert not _is_secret_bearing_export_path("package.json")
    assert not _is_secret_bearing_export_path("tsconfig.json")


def test_embed_files_skips_bak_files_and_preserves_canonical_files(tmp_path):
    worker_dir = tmp_path / "workers" / "partial-worker"
    (worker_dir / "lib").mkdir(parents=True)
    (worker_dir / "worker.yml").write_text("name: partial-worker\n", encoding="utf-8")
    (worker_dir / "run.py").write_text("print('canonical')\n", encoding="utf-8")
    (worker_dir / "run.py.bak1").write_text("print('backup')\n", encoding="utf-8")
    (worker_dir / "lib" / "search.py").write_text("def search(): pass\n", encoding="utf-8")
    (worker_dir / "lib" / "search.py.bak1").write_text("def old(): pass\n", encoding="utf-8")

    # The embed now routes through the canonical WorkerRepository so it lands in
    # the deployment's primary store (cloud Postgres, not only SQLite —
    # workeros-cloud#717). Capture the repo write to assert bak-file filtering and
    # the canonical file set.
    captured: dict[str, object] = {}

    class _FakeWorkersRepo:
        def update_manifest_files(self, *, worker_id: str, files: dict[str, str]) -> bool:
            captured["worker_id"] = worker_id
            captured["files"] = files
            return True

    class _FakeRepos:
        workers = _FakeWorkersRepo()

    _embed_files_in_skill_version("partial-worker", worker_dir, repos=_FakeRepos())

    assert captured["worker_id"] == "partial-worker"
    files = captured["files"]
    assert files == {
        "worker.yml": "name: partial-worker\n",
        "run.py": "print('canonical')\n",
        "lib/search.py": "def search(): pass\n",
    }
    assert not any(".bak" in path for path in files)


def test_embed_strict_raises_when_skill_version_missing(tmp_path):
    """#717: a single-worker create/save must fail LOUD when the bundle can't be
    embedded — never silently ship a worker with empty manifest._files."""
    worker_dir = tmp_path / "workers" / "ghost-worker"
    worker_dir.mkdir(parents=True)
    (worker_dir / "worker.yml").write_text("name: ghost-worker\n", encoding="utf-8")
    (worker_dir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    class _MissingWorkersRepo:
        def update_manifest_files(self, *, worker_id: str, files: dict[str, str]) -> bool:
            return False  # no skill_version row for this worker

    class _Repos:
        workers = _MissingWorkersRepo()

    with pytest.raises(RuntimeError):
        _embed_files_in_skill_version(
            "ghost-worker", worker_dir, repos=_Repos(), strict=True
        )


def test_embed_strict_raises_on_empty_bundle(tmp_path):
    """No embeddable files in strict mode is a hard error (broken bundle)."""
    worker_dir = tmp_path / "workers" / "empty-worker"
    worker_dir.mkdir(parents=True)

    class _Repos:
        workers = object()

    with pytest.raises(RuntimeError):
        _embed_files_in_skill_version(
            "empty-worker", worker_dir, repos=_Repos(), strict=True
        )
