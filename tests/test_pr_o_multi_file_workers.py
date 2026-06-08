"""Tests for PR O: multi-file worker support.

Tests:
  1. GET /workers/csv_enricher returns a files: [...] array with at least
     worker.yml, SKILL.md, and run.py.
  2. PUT /workers/{id}/files blocks path traversal (paths containing '..').
  3. PUT /workers/{id}/files is atomic: failed validation rolls back changes.
  4. PUT /workers/{id}/files succeeds and returns updated files.
  5. PUT /workers/{id}/files rejects missing worker.yml.
  6. PUT /workers/{id}/files rejects absolute paths.

Run with:
    cd apps/api && python3 -m pytest ../../tests/test_pr_o_multi_file_workers.py -v
"""

import io
import json
import os
import sys
import tempfile
import unittest
import uuid as _uuid_mod

# Point to the API source before importing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

# Use a fresh temp DB in dev mode (no auth)
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ["FLOOM_SECRET"] = ""  # dev mode; must be set before import

import db  # noqa: E402
db.DB_PATH = _tmp_db.name

import main as app_module  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app_module.app, raise_server_exceptions=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_RUN_PY = "def run(inputs, context):\n    return {'status': 'success', 'outputs': {}, 'artifacts': []}\n"
_SKILL_MD = "# Test Skill\n\nDo something useful.\n"


def _unique_name(prefix: str = "tpo") -> str:
    return f"{prefix}-{_uuid_mod.uuid4().hex[:8]}"


def _make_worker_yml(name: str) -> str:
    return f"""schema_version: "0.3"
name: {name}
title: "Test Worker {name}"
description: "Multi-file test worker."
version: "0.1.0"
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs: []
  outputs: []
trigger:
  type: manual
"""


def _create_worker(name: str) -> dict:
    r = client.post(
        "/workers",
        json={
            "worker_yml": _make_worker_yml(name),
            "run_py": _RUN_PY,
            "skill_md": _SKILL_MD,
        },
    )
    assert r.status_code == 200, f"create failed {r.status_code}: {r.text}"
    return r.json()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestWorkerFilesField(unittest.TestCase):
    """GET /workers/{id} returns a non-empty files array."""

    def test_csv_enricher_files_array(self):
        """csv_enricher worker must return files: [...] with the 3 core files."""
        r = client.get("/workers/csv_enricher")
        if r.status_code == 404:
            self.skipTest("csv_enricher worker not present in this test environment")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("files", body, "Response must include 'files' field")
        files = body["files"]
        self.assertIsInstance(files, list, "'files' must be a list")
        self.assertGreater(len(files), 0, "files list must not be empty")
        paths = {f["path"] for f in files}
        for required_path in ("worker.yml", "SKILL.md", "run.py"):
            self.assertIn(required_path, paths, f"Expected '{required_path}' in files; got {sorted(paths)}")

    def test_created_worker_files_field(self):
        """A freshly created worker must return files: [...] with worker.yml, SKILL.md, run.py."""
        name = _unique_name("twf")
        worker = _create_worker(name)
        r = client.get(f"/workers/{worker['id']}")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertIn("files", body)
        paths = {f["path"] for f in body["files"]}
        self.assertIn("worker.yml", paths)
        self.assertIn("SKILL.md", paths)
        self.assertIn("run.py", paths)

    def test_files_have_required_fields(self):
        """Each file entry must have path, language, size, binary fields."""
        name = _unique_name("twf2")
        worker = _create_worker(name)
        r = client.get(f"/workers/{worker['id']}")
        self.assertEqual(r.status_code, 200, r.text)
        for f in r.json()["files"]:
            self.assertIn("path", f)
            self.assertIn("language", f)
            self.assertIn("size", f)
            self.assertIn("binary", f)

    def test_worker_yml_language_is_yaml(self):
        """worker.yml must have language='yaml'."""
        name = _unique_name("twf3")
        worker = _create_worker(name)
        r = client.get(f"/workers/{worker['id']}")
        self.assertEqual(r.status_code, 200)
        yml_file = next(f for f in r.json()["files"] if f["path"] == "worker.yml")
        self.assertEqual(yml_file["language"], "yaml")

    def test_skill_md_language_is_markdown(self):
        """SKILL.md must have language='markdown'."""
        name = _unique_name("twf4")
        worker = _create_worker(name)
        r = client.get(f"/workers/{worker['id']}")
        self.assertEqual(r.status_code, 200)
        skill = next((f for f in r.json()["files"] if f["path"] == "SKILL.md"), None)
        self.assertIsNotNone(skill, "SKILL.md not found in files")
        self.assertEqual(skill["language"], "markdown")  # type: ignore[index]

    def test_files_order_worker_yml_first(self):
        """worker.yml must be first in the files list."""
        name = _unique_name("twf5")
        worker = _create_worker(name)
        r = client.get(f"/workers/{worker['id']}")
        self.assertEqual(r.status_code, 200)
        files = r.json()["files"]
        self.assertGreater(len(files), 0)
        self.assertEqual(files[0]["path"], "worker.yml")


class TestBulkFilesUpdate(unittest.TestCase):
    """PUT /workers/{id}/files endpoint tests."""

    def setUp(self):
        self.name = _unique_name("twb")
        self.worker = _create_worker(self.name)
        self.worker_id = self.worker["id"]

    def _files_for_worker(self, extra_files=None):
        """Return a valid file list for the worker."""
        files = [
            {"path": "worker.yml", "content": _make_worker_yml(self.name)},
            {"path": "run.py", "content": _RUN_PY},
            {"path": "SKILL.md", "content": _SKILL_MD},
        ]
        if extra_files:
            files.extend(extra_files)
        return files

    def test_happy_path_returns_updated_worker(self):
        """PUT /workers/{id}/files with valid files returns 200 and updated worker."""
        r = client.put(
            f"/workers/{self.worker_id}/files",
            json={"files": self._files_for_worker([
                {"path": "lib/helpers.py", "content": "# helper\n"},
            ])},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["id"], self.worker_id)
        paths = {f["path"] for f in body["files"]}
        self.assertIn("lib/helpers.py", paths)

    def test_path_traversal_blocked_dotdot(self):
        """PUT /workers/{id}/files must reject paths containing '..'."""
        bad_files = self._files_for_worker([
            {"path": "../etc/passwd", "content": "evil"},
        ])
        r = client.put(
            f"/workers/{self.worker_id}/files",
            json={"files": bad_files},
        )
        self.assertEqual(r.status_code, 400, f"Expected 400, got {r.status_code}: {r.text}")
        self.assertIn("..", r.json().get("detail", ""), f"Expected detail mentioning '..' segment: {r.text}")

    def test_path_traversal_blocked_nested_dotdot(self):
        """PUT /workers/{id}/files must reject nested path traversal."""
        bad_files = self._files_for_worker([
            {"path": "lib/../../etc/passwd", "content": "evil"},
        ])
        r = client.put(
            f"/workers/{self.worker_id}/files",
            json={"files": bad_files},
        )
        self.assertEqual(r.status_code, 400, f"Expected 400, got {r.status_code}: {r.text}")

    def test_absolute_path_blocked(self):
        """PUT /workers/{id}/files must reject absolute paths."""
        bad_files = self._files_for_worker([
            {"path": "/etc/passwd", "content": "evil"},
        ])
        r = client.put(
            f"/workers/{self.worker_id}/files",
            json={"files": bad_files},
        )
        self.assertEqual(r.status_code, 400, f"Expected 400, got {r.status_code}: {r.text}")

    def test_missing_worker_yml_rejected(self):
        """PUT /workers/{id}/files without worker.yml returns 400."""
        r = client.put(
            f"/workers/{self.worker_id}/files",
            json={"files": [{"path": "run.py", "content": _RUN_PY}]},
        )
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("worker.yml", r.json().get("detail", ""))

    def test_empty_files_list_rejected(self):
        """PUT /workers/{id}/files with empty list returns 400."""
        r = client.put(f"/workers/{self.worker_id}/files", json={"files": []})
        self.assertEqual(r.status_code, 400, r.text)

    def test_invalid_worker_yml_rollback(self):
        """PUT /workers/{id}/files with invalid worker.yml rolls back and worker is unchanged.

        This tests the atomicity guarantee: a bad worker.yml is caught before
        the directory swap, leaving the worker directory intact.
        """
        # Get current files to verify they are unchanged after a failed PUT
        before = client.get(f"/workers/{self.worker_id}").json()
        before_paths = sorted(f["path"] for f in before["files"])

        broken_yml = "this: is: not: valid: yaml: worker: {broken"
        r = client.put(
            f"/workers/{self.worker_id}/files",
            json={"files": [
                {"path": "worker.yml", "content": broken_yml},
                {"path": "run.py", "content": _RUN_PY},
            ]},
        )
        # Must reject with 400 (YAML parse error)
        self.assertEqual(r.status_code, 400, f"Expected 400, got {r.status_code}: {r.text}")

        # Worker directory must still be intact
        after = client.get(f"/workers/{self.worker_id}")
        self.assertEqual(after.status_code, 200, "Worker must still exist after failed PUT")
        after_paths = sorted(f["path"] for f in after.json()["files"])
        self.assertEqual(before_paths, after_paths, "Worker files must be unchanged after failed PUT")

    def test_worker_id_mismatch_rejected(self):
        """PUT /workers/{id}/files with worker.yml that declares a different name is rejected."""
        other_name = _unique_name("twb-other")
        r = client.put(
            f"/workers/{self.worker_id}/files",
            json={"files": [
                {"path": "worker.yml", "content": _make_worker_yml(other_name)},
                {"path": "run.py", "content": _RUN_PY},
            ]},
        )
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("does not match", r.json().get("detail", ""))

    def test_nonexistent_worker_returns_404(self):
        """PUT /workers/nonexistent-worker/files returns 404."""
        r = client.put(
            "/workers/nonexistent-worker-xyz/files",
            json={"files": [{"path": "worker.yml", "content": _make_worker_yml("nonexistent-worker-xyz")}]},
        )
        self.assertEqual(r.status_code, 404, r.text)

    def test_duplicate_path_rejected(self):
        """PUT /workers/{id}/files with duplicate paths in the list is rejected."""
        r = client.put(
            f"/workers/{self.worker_id}/files",
            json={"files": [
                {"path": "worker.yml", "content": _make_worker_yml(self.name)},
                {"path": "run.py", "content": _RUN_PY},
                {"path": "run.py", "content": "# duplicate\n"},
            ]},
        )
        self.assertEqual(r.status_code, 400, r.text)


if __name__ == "__main__":
    unittest.main()
