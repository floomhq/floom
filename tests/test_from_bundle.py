"""Tests for POST /workers/from-bundle endpoint.

Run with:
    cd apps/api && python3 -m pytest ../../tests/test_from_bundle.py -v

Tests:
  1. Valid zip with worker.yml + SKILL.md -> 200, worker created
  2. Zip without worker.yml -> 400
  3. Zip with duplicate worker_id -> 409
  4. Flat directory layout (single top-level dir) -> 200
  5. Pure-Python mode: zip with worker.yml (pure-script mode) + run.py -> 200
"""

import io
import json
import os
import sys
import tempfile
import unittest
import uuid as _uuid_mod
import zipfile

# Point to the API source before importing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

# Use a fresh temp DB; dev mode (no auth).
# Set FLOOM_SECRET="" BEFORE importing main so load_dotenv(override=False)
# won't overwrite it with the value from /etc/floom/api.env.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ["FLOOM_SECRET"] = ""  # empty = dev mode; must be set before import

import db  # noqa: E402

db.DB_PATH = _tmp_db.name

import main as app_module  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app_module.app, raise_server_exceptions=True)


def _unique_name(prefix: str = "fb") -> str:
    return f"{prefix}-{_uuid_mod.uuid4().hex[:8]}"


def _make_worker_yml(name: str, mode: str = "agent") -> str:
    if mode == "pure-script":
        exec_block = (
            "exec:\n"
            "  command: python run.py\n"
            "  runtime: python311\n"
            "  mode: pure-script\n"
            "  runner: e2b\n"
            "  inputs: []\n"
            "  outputs: []"
        )
    else:
        exec_block = (
            "exec:\n"
            "  runtime: skill\n"
            "  mode: agent\n"
            "  runner: e2b\n"
            "  inputs: []\n"
            "  outputs: []"
        )
    return f"""schema_version: "0.3"
name: {name}
title: "Test Worker {name}"
description: "Bundle test worker."
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]
{exec_block}
trigger:
  type: manual
"""


def _make_zip(files: dict[str, str]) -> bytes:
    """Create an in-memory zip with the given files (path -> content)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for path, content in files.items():
            zf.writestr(path, content)
    return buf.getvalue()


SKILL_MD = "# Test Skill\n\nDo something useful.\n"
RUN_PY = "def run(inputs, context):\n    return {'status': 'success', 'outputs': {}, 'artifacts': []}\n"


class TestFromBundleEndpoint(unittest.TestCase):
    """Tests for POST /workers/from-bundle."""

    def _post_bundle(self, zip_bytes: bytes, filename: str = "bundle.zip"):
        return client.post(
            "/workers/from-bundle",
            files={"bundle": (filename, io.BytesIO(zip_bytes), "application/zip")},
        )

    def test_valid_zip_with_worker_yml_and_skill_md_returns_200(self):
        """Standard valid bundle: worker.yml + SKILL.md at root."""
        name = _unique_name()
        files = {
            "worker.yml": _make_worker_yml(name, "agent"),
            "SKILL.md": SKILL_MD,
        }
        r = self._post_bundle(_make_zip(files))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["id"], name)

    def test_valid_zip_with_single_top_dir_returns_200(self):
        """Bundle where all files are inside one top-level directory."""
        name = _unique_name()
        files = {
            f"{name}/worker.yml": _make_worker_yml(name, "agent"),
            f"{name}/SKILL.md": SKILL_MD,
        }
        r = self._post_bundle(_make_zip(files))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["id"], name)

    def test_valid_zip_pure_script_mode_returns_200(self):
        """Pure-Python mode bundle: worker.yml (pure-script) + run.py."""
        name = _unique_name()
        files = {
            "worker.yml": _make_worker_yml(name, "pure-script"),
            "run.py": RUN_PY,
        }
        r = self._post_bundle(_make_zip(files))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["id"], name)

    def test_zip_without_worker_yml_returns_400(self):
        """Zip with no worker.yml must return 400."""
        files = {
            "SKILL.md": SKILL_MD,
            "run.py": RUN_PY,
        }
        r = self._post_bundle(_make_zip(files))
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("worker.yml", r.json()["detail"])

    def test_invalid_worker_yml_returns_400(self):
        """Zip with a malformed worker.yml must return 400."""
        name = _unique_name()
        files = {
            "worker.yml": "not: valid: yaml: {{{}",
            "SKILL.md": SKILL_MD,
        }
        r = self._post_bundle(_make_zip(files))
        self.assertEqual(r.status_code, 400, r.text)

    def test_duplicate_worker_id_returns_409(self):
        """POSTing the same bundle twice must return 409 on the second call."""
        name = _unique_name()
        files = {
            "worker.yml": _make_worker_yml(name, "agent"),
            "SKILL.md": SKILL_MD,
        }
        zip_bytes = _make_zip(files)

        r1 = self._post_bundle(zip_bytes)
        self.assertEqual(r1.status_code, 200, r1.text)

        r2 = self._post_bundle(zip_bytes)
        self.assertEqual(r2.status_code, 409, r2.text)
        self.assertIn("already exists", r2.json()["detail"])

    def test_not_a_zip_returns_400(self):
        """Uploading a non-zip file must return 400."""
        r = self._post_bundle(b"this is not a zip file", filename="bad.zip")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("zip", r.json()["detail"].lower())

    # --- Zip-bomb guards (round-8 P2) ---

    def test_oversized_bundle_uncompressed_rejected(self):
        """A zip-bomb (tiny on disk, >50MB uncompressed) is rejected (413)."""
        name = _unique_name()
        # 60MB of highly-compressible zeros: tiny on disk under DEFLATE, huge
        # uncompressed — the classic zip-bomb shape. Build with compression so
        # the upload itself is small, proving the cap fires on UNCOMPRESSED size.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("worker.yml", _make_worker_yml(name, "agent"))
            zf.writestr("SKILL.md", SKILL_MD)
            zf.writestr("big.txt", "0" * (60 * 1024 * 1024))
        zip_bytes = buf.getvalue()
        self.assertLess(len(zip_bytes), 1 * 1024 * 1024, "compressed zip should be small")
        r = self._post_bundle(zip_bytes)
        self.assertEqual(r.status_code, 413, r.text)
        self.assertIn("too large", r.json()["detail"].lower())

    def test_too_many_entries_rejected(self):
        """A bundle with > 2000 entries is rejected (413)."""
        name = _unique_name()
        files = {
            "worker.yml": _make_worker_yml(name, "agent"),
            "SKILL.md": SKILL_MD,
        }
        for i in range(2100):
            files[f"f{i}.txt"] = "x"
        r = self._post_bundle(_make_zip(files))
        self.assertEqual(r.status_code, 413, r.text)
        self.assertIn("many entries", r.json()["detail"].lower())

    def test_normal_small_bundle_still_imports(self):
        """Regression: a normal bundle well under the caps still imports (200)."""
        name = _unique_name()
        files = {
            "worker.yml": _make_worker_yml(name, "agent"),
            "SKILL.md": SKILL_MD,
            "notes.txt": "x" * 1024,  # 1KB, far under 50MB
        }
        r = self._post_bundle(_make_zip(files))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["id"], name)


if __name__ == "__main__":
    unittest.main()
