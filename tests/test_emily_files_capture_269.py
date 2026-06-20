"""Regression tests for #269 — Emily-created workers never run.

The engine chat tools write worker code to the handling instance's ephemeral
disk but never populate manifest_json._files (only the REST path did), so a
different instance / post-redeploy materializes nothing → "Worker directory
not found". The cloud worker-repo write paths now capture the on-disk files
into _files via _sync_disk_files_to_manifest.

These cover the capture logic. End-to-end (a live Emily /chat create + run)
must be confirmed against a deployed stack.
"""

from __future__ import annotations

from types import SimpleNamespace

import apps.api.db.supabase_repos as sr
from apps.api.db.supabase_repos import SupabaseWorkerRepository, _read_worker_files_from_disk


def _seed(tmp_path, worker_id, files):
    wd = tmp_path / worker_id
    wd.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        p = wd / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    return wd


# ---- _read_worker_files_from_disk ----

def test_read_files_from_disk(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path))
    _seed(tmp_path, "w1", {"run.py": "print('hi')", "worker.yml": "name: w1", "sub/SKILL.md": "# s"})
    files = _read_worker_files_from_disk("w1")
    assert files == {"run.py": "print('hi')", "worker.yml": "name: w1", "sub/SKILL.md": "# s"}


def test_read_skips_binary_and_missing_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path))
    assert _read_worker_files_from_disk("does-not-exist") == {}
    wd = _seed(tmp_path, "w2", {"run.py": "x = 1"})
    (wd / "blob.bin").write_bytes(b"\xff\xfe\x00\x01\x80")  # invalid utf-8
    files = _read_worker_files_from_disk("w2")
    assert files == {"run.py": "x = 1"}  # binary skipped


def test_read_files_from_disk_skips_engine_backup_files(monkeypatch, tmp_path):
    workers = tmp_path / "workers"
    w = workers / "w-bak"
    (w / "lib").mkdir(parents=True)
    (w / "worker.yml").write_text("name: w\n", encoding="utf-8")
    (w / "run.py.bak1").write_text("old run\n", encoding="utf-8")
    (w / "lib" / "search.py.bak1").write_text("old lib\n", encoding="utf-8")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers))

    assert _read_worker_files_from_disk("w-bak") == {"worker.yml": "name: w\n"}


# ---- _sync_disk_files_to_manifest ----

class _Chain:
    def __init__(self, manifest, *, row_exists=True):
        self._manifest = manifest
        self._row_exists = row_exists
        self.updated_payload = None

    def table(self, _n):
        return self

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def update(self, payload):
        self.updated_payload = payload
        return self

    def execute(self):
        data = [{"manifest_json": self._manifest}] if self._row_exists else []
        return SimpleNamespace(data=data)


def _repo(client):
    return SupabaseWorkerRepository(client=client)


def test_sync_writes_files_when_absent(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path))
    _seed(tmp_path, "wA", {"run.py": "print('HI')", "worker.yml": "name: wA"})
    chain = _Chain({"name": "wA", "version": "0.1.0"})  # no _files
    _repo(chain)._sync_disk_files_to_manifest("wA", "sv-A")
    assert chain.updated_payload is not None
    assert chain.updated_payload["manifest_json"]["_files"] == {
        "run.py": "print('HI')", "worker.yml": "name: wA",
    }
    # existing manifest fields preserved
    assert chain.updated_payload["manifest_json"]["name"] == "wA"


def test_sync_noop_when_disk_empty_does_not_clobber(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path))  # no dir seeded for wB
    chain = _Chain({"name": "wB", "_files": {"run.py": "good"}})
    _repo(chain)._sync_disk_files_to_manifest("wB", "sv-B")
    # Disk empty -> must NOT write (would otherwise clobber a good _files).
    assert chain.updated_payload is None


def test_sync_skips_when_unchanged(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path))
    _seed(tmp_path, "wC", {"run.py": "same"})
    chain = _Chain({"name": "wC", "_files": {"run.py": "same"}})
    _repo(chain)._sync_disk_files_to_manifest("wC", "sv-C")
    assert chain.updated_payload is None  # already matches disk -> no redundant write


def test_sync_noop_when_skill_row_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path))
    _seed(tmp_path, "wD", {"run.py": "x"})
    chain = _Chain(None, row_exists=False)
    _repo(chain)._sync_disk_files_to_manifest("wD", "sv-missing")
    assert chain.updated_payload is None
