"""Regression tests for #1169: cloud context Storage hydration recurses into nested paths.

upload_context uses rglob("*") which includes nested files like reports/q1.md.
download_context and delete_context_from_storage previously used a flat list() call
that only returned top-level objects; nested files were silently dropped.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any
import unittest.mock as mock

from apps.api.cloud_contexts import download_context, delete_context_from_storage, upload_context


# ---------------------------------------------------------------------------
# Fake Supabase Storage backend
# ---------------------------------------------------------------------------

class _FakeStorageBucket:
    """Minimal Supabase Storage mock that supports list/upload/download/remove
    with a realistic folder-placeholder structure for nested paths.

    Layout in self._objects: {full_path: bytes}
    list(prefix) returns immediate children (files + folder placeholders),
    mirroring the real Supabase Storage API behaviour.
    """
    def __init__(self):
        self._objects: dict[str, bytes] = {}

    def upload(self, *, path: str, file: bytes, file_options: dict | None = None):
        self._objects[path] = file

    def download(self, path: str) -> bytes:
        if path not in self._objects:
            raise KeyError(f"Not found: {path}")
        return self._objects[path]

    def remove(self, paths: list[str]) -> None:
        for p in paths:
            self._objects.pop(p, None)

    def list(self, prefix: str) -> list[dict[str, Any]]:
        """Return immediate children of prefix.

        Files: obj with non-None id and metadata.
        Folders: obj with id=None, metadata=None (real Supabase behaviour).
        """
        prefix = prefix.rstrip("/") + "/"
        seen: dict[str, bool] = {}  # name -> is_file
        for path in self._objects:
            if not path.startswith(prefix):
                continue
            rest = path[len(prefix):]
            if not rest:
                continue
            parts = rest.split("/", 1)
            name = parts[0]
            is_file = len(parts) == 1  # direct child
            if name in seen:
                if is_file:
                    seen[name] = True
            else:
                seen[name] = is_file

        result = []
        for name, is_file in seen.items():
            if is_file:
                result.append({"name": name, "id": f"uuid-{name}", "metadata": {"size": 10}})
            else:
                result.append({"name": name, "id": None, "metadata": None})
        return result


class _FakeStorage:
    def __init__(self):
        self._bucket = _FakeStorageBucket()

    def from_(self, _bucket_name: str) -> _FakeStorageBucket:
        return self._bucket

    def create_bucket(self, *_args, **_kwargs):
        pass


class _FakeSvc:
    def __init__(self):
        self.storage = _FakeStorage()


def _patch_svc(svc):
    """Context manager that injects svc as the Supabase client inside cloud_contexts."""
    return mock.patch("apps.api.config.get_supabase_service_client", return_value=svc)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_download_context_restores_nested_files(tmp_path):
    """Nested files (e.g. reports/q1.md) must be restored after a fresh hydration (#1169)."""
    svc = _FakeSvc()
    bucket = svc.storage._bucket

    bucket.upload(path="ws1/ctx1/README.md", file=b"# readme", file_options={})
    bucket.upload(path="ws1/ctx1/reports/q1.md", file=b"# Q1", file_options={})
    bucket.upload(path="ws1/ctx1/reports/q2.md", file=b"# Q2", file_options={})

    dest = tmp_path / "ctx1"
    with _patch_svc(svc):
        count = download_context("ws1", "ctx1", dest)

    assert count == 3, f"Expected 3 files, got {count}"
    assert (dest / "README.md").read_bytes() == b"# readme"
    assert (dest / "reports" / "q1.md").read_bytes() == b"# Q1"
    assert (dest / "reports" / "q2.md").read_bytes() == b"# Q2"


def test_delete_context_removes_nested_storage_objects(tmp_path):
    """delete_context_from_storage must remove nested objects, not just top-level (#1169)."""
    svc = _FakeSvc()
    bucket = svc.storage._bucket

    bucket.upload(path="ws1/ctx1/README.md", file=b"readme", file_options={})
    bucket.upload(path="ws1/ctx1/reports/q1.md", file=b"q1", file_options={})

    with _patch_svc(svc):
        delete_context_from_storage("ws1", "ctx1")

    remaining = [k for k in bucket._objects if k.startswith("ws1/ctx1/")]
    assert remaining == [], f"Stale objects remain: {remaining}"


def test_download_context_flat_files_still_work(tmp_path):
    """Flat (non-nested) contexts must still be restored correctly (#1169 no regression)."""
    svc = _FakeSvc()
    bucket = svc.storage._bucket

    bucket.upload(path="ws1/ctx1/worker.yml", file=b"id: foo", file_options={})
    bucket.upload(path="ws1/ctx1/run.py", file=b"print('hi')", file_options={})

    dest = tmp_path / "ctx1"
    with _patch_svc(svc):
        count = download_context("ws1", "ctx1", dest)

    assert count == 2
    assert (dest / "worker.yml").read_bytes() == b"id: foo"
    assert (dest / "run.py").read_bytes() == b"print('hi')"


def test_upload_and_download_roundtrip_nested(tmp_path):
    """Full upload→clear→download roundtrip with nested files (#1169)."""
    svc = _FakeSvc()

    # Write nested files to source_dir.
    source = tmp_path / "source"
    source.mkdir()
    (source / "README.md").write_bytes(b"readme")
    (source / "data").mkdir()
    (source / "data" / "records.json").write_bytes(b'[1,2,3]')
    (source / "data" / "sub").mkdir()
    (source / "data" / "sub" / "deep.txt").write_bytes(b"deep")

    with _patch_svc(svc):
        upload_context("ws-round", "ctx-round", source)

    # Simulate fresh container — download to a clean dest.
    dest = tmp_path / "dest"
    with _patch_svc(svc):
        count = download_context("ws-round", "ctx-round", dest)

    assert count == 3, f"Expected 3, got {count}"
    assert (dest / "README.md").read_bytes() == b"readme"
    assert (dest / "data" / "records.json").read_bytes() == b'[1,2,3]'
    assert (dest / "data" / "sub" / "deep.txt").read_bytes() == b"deep"


def test_delete_does_not_affect_other_contexts(tmp_path):
    """Deleting one context must not remove objects belonging to a sibling context (#1169)."""
    svc = _FakeSvc()
    bucket = svc.storage._bucket

    bucket.upload(path="ws1/ctx-keep/README.md", file=b"keep", file_options={})
    bucket.upload(path="ws1/ctx-delete/file.md", file=b"delete", file_options={})

    with _patch_svc(svc):
        delete_context_from_storage("ws1", "ctx-delete")

    assert bucket._objects.get("ws1/ctx-keep/README.md") == b"keep", "sibling context was removed"
    assert "ws1/ctx-delete/file.md" not in bucket._objects
