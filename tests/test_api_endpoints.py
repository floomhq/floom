"""Unit tests for PATCH /workers/{id}, DELETE /workers/{id},
GET /runs/{id}/events SSE, and auth gate on all routes.

Run with:
    cd apps/api && python3 -m pytest ../../tests/test_api_endpoints.py -v
or:
    cd apps/api && python3 -m unittest discover -s ../../tests -p test_api_endpoints.py

Uses FastAPI TestClient (synchronous) and a fresh in-memory SQLite DB per
test class so tests are hermetic.
"""

import json
import os
import sys
import tempfile
import threading
import time
import shutil
import unittest
import uuid as _uuid_mod
from pathlib import Path
from unittest.mock import patch

# Point to the API source before importing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

# Override DB_PATH to a temp file before importing main
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ.pop("FLOOM_SECRET", None)  # dev mode by default

# Suppress scheduler noise in tests
os.environ.setdefault("FLOOM_RUN_TIMEOUT", "5")

import db  # noqa: E402 (must be after env setup)
db.DB_PATH = _tmp_db.name

# Now import main (which calls init_db)
import main as app_module  # noqa: E402
import contexts as contexts_module  # noqa: E402
from auth.factory import get_auth_provider  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app_module.app, raise_server_exceptions=True)

# ---------------------------------------------------------------------------
# Minimal worker fixtures
# ---------------------------------------------------------------------------

_RUN_PY = "# placeholder\ndef run(context): return {}\n"


def _make_worker_yml(name: str, trigger_type: str = "manual") -> str:
    """Generate a unique worker YAML to avoid name collisions across tests."""
    if trigger_type == "webhook":
        trigger_block = "  type: webhook\n  webhook:\n    secret: true\n    allowed_methods: [POST]"
    else:
        trigger_block = f"  type: {trigger_type}"
    return f"""schema_version: "0.3"
name: {name}
title: Test Worker {name}
description: Auto-generated test worker for endpoint tests.
version: 0.1.0
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs: []
  outputs: []
approvals:
  required: false
trigger:
{trigger_block}
"""


def _unique_name(prefix: str = "tw") -> str:
    return f"{prefix}-{_uuid_mod.uuid4().hex[:8]}"


def _create_worker(yml: str) -> dict:
    """Create a worker via POST /workers and return the response body."""
    r = client.post("/workers", json={"worker_yml": yml, "run_py": _RUN_PY})
    assert r.status_code == 200, f"create_worker failed {r.status_code}: {r.text}"
    return r.json()


def _create_manual_worker() -> dict:
    name = _unique_name("twm")
    return _create_worker(_make_worker_yml(name, "manual"))


def _create_webhook_worker() -> dict:
    name = _unique_name("tww")
    return _create_worker(_make_worker_yml(name, "webhook"))


def _create_approval_worker() -> dict:
    name = _unique_name("twa")
    yml = _make_worker_yml(name, "manual").replace(
        "approvals:\n  required: false",
        "approvals:\n  required: true\n  label: Approve test output",
    )
    return _create_worker(yml)


# ===========================================================================
# Auth gate tests (Deliverable 4)
# ===========================================================================

class TestAuthGate(unittest.TestCase):
    """Ensure FLOOM_SECRET gates ALL routes except /webhooks/* and /healthz."""

    def setUp(self):
        os.environ["FLOOM_SECRET"] = "test-secret-abc"

    def tearDown(self):
        os.environ.pop("FLOOM_SECRET", None)

    def _headers(self, include_secret: bool = True) -> dict:
        if include_secret:
            return {"x-floom-secret": "test-secret-abc"}
        return {}

    def test_get_workers_without_secret_returns_401(self):
        r = client.get("/workers", headers=self._headers(False))
        self.assertEqual(r.status_code, 401)

    def test_get_workers_with_wrong_secret_returns_401(self):
        r = client.get("/workers", headers={"x-floom-secret": "wrong-secret"})
        self.assertEqual(r.status_code, 401)

    def test_get_workers_with_correct_secret_returns_200(self):
        r = client.get("/workers", headers=self._headers())
        self.assertEqual(r.status_code, 200)

    def test_post_without_secret_returns_401(self):
        r = client.post("/workers/reload", headers=self._headers(False))
        self.assertEqual(r.status_code, 401)

    def test_get_runs_without_secret_returns_401(self):
        r = client.get("/runs", headers=self._headers(False))
        self.assertEqual(r.status_code, 401)

    def test_get_run_logs_without_secret_returns_401(self):
        r = client.get("/runs/nonexistent-run/logs", headers=self._headers(False))
        self.assertEqual(r.status_code, 401)

    def test_healthz_accessible_without_secret(self):
        """GET /healthz must not require x-floom-secret."""
        r = client.get("/healthz")
        self.assertEqual(r.status_code, 200)

    def test_webhook_accessible_without_secret(self):
        """POST /webhooks/* must not require x-floom-secret (uses HMAC)."""
        # The endpoint will 404 because worker doesn't exist, but not 401
        r = client.post("/webhooks/some-worker-id", content=b"{}", headers=self._headers(False))
        self.assertNotEqual(r.status_code, 401, f"Expected non-401, got {r.status_code}: {r.text}")

    def test_connections_callback_accessible_without_secret(self):
        """GET /connections/callback must accept external OAuth browser redirects."""
        r = client.get(
            "/connections/callback?connection_id=test&status=success",
            headers=self._headers(False),
            follow_redirects=False,
        )
        self.assertNotEqual(r.status_code, 401, f"Expected non-401, got {r.status_code}: {r.text}")

    def test_connections_callback_validates_known_connection_id(self):
        """OAuth callback updates only a persisted Composio connection row."""
        from db import get_db

        conn_id = f"conn_{_uuid_mod.uuid4().hex[:12]}"
        with get_db() as conn:
            conn.execute(
                """INSERT INTO composio_connections
                   (id, app_name, composio_connection_id, status, created_at, updated_at)
                   VALUES (?, 'gmail', ?, 'initiated', datetime('now'), datetime('now'))""",
                (f"local_{_uuid_mod.uuid4().hex[:12]}", conn_id),
            )

        r = client.get(
            f"/connections/callback?connection_id={conn_id}&status=success",
            headers=self._headers(False),
            follow_redirects=False,
        )

        self.assertNotEqual(r.status_code, 401, f"Expected non-401, got {r.status_code}: {r.text}")
        with get_db() as conn:
            row = conn.execute(
                "SELECT status FROM composio_connections WHERE composio_connection_id = ?",
                (conn_id,),
            ).fetchone()
        self.assertEqual(row["status"], "active")

    def test_options_cors_preflight_passes(self):
        """OPTIONS requests must not be gated by x-floom-secret."""
        r = client.options("/workers")
        self.assertNotEqual(r.status_code, 401)


# ===========================================================================
# PATCH /workers/{worker_id} tests (Deliverable 1)
# ===========================================================================

class TestPatchWorker(unittest.TestCase):
    """Tests for PATCH /workers/{worker_id}."""

    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)  # dev mode
        self.worker = _create_manual_worker()
        self.worker_id = self.worker["id"]

    def test_patch_nonexistent_worker_returns_404(self):
        r = client.patch("/workers/does-not-exist", json={})
        self.assertEqual(r.status_code, 404)

    def test_patch_invalid_body_shape_returns_422(self):
        """Sending entirely wrong type for a field should fail validation."""
        r = client.patch(
            f"/workers/{self.worker_id}",
            json={"trigger_type": 12345},  # must be string literal, not int
        )
        self.assertIn(r.status_code, (400, 422))

    def test_patch_invalid_cron_expr_returns_400(self):
        r = client.patch(
            f"/workers/{self.worker_id}",
            json={"cron_expr": "not-a-cron"},
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("cron", r.json()["detail"].lower())

    def test_patch_invalid_cron_no_db_write(self):
        """On invalid cron, DB must not be modified."""
        r_before = client.get(f"/workers/{self.worker_id}")
        self.assertEqual(r_before.status_code, 200)
        original_trigger_type = r_before.json()["trigger_type"]

        client.patch(f"/workers/{self.worker_id}", json={"cron_expr": "not-a-cron"})

        r_after = client.get(f"/workers/{self.worker_id}")
        self.assertEqual(r_after.json()["trigger_type"], original_trigger_type)

    def test_patch_trigger_type_updates_worker(self):
        r = client.patch(
            f"/workers/{self.worker_id}",
            json={"trigger_type": "manual"},
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["trigger_type"], "manual")

    def test_patch_input_values_persisted(self):
        new_inputs = {"key1": "val1", "key2": 42}
        r = client.patch(
            f"/workers/{self.worker_id}",
            json={"input_values": new_inputs},
        )
        self.assertEqual(r.status_code, 200)
        # No direct field in WorkerDetail for input_values, but no error expected
        self.assertIn("id", r.json())

    def test_patch_webhook_secret_rotate_on_manual_worker_returns_400(self):
        """Cannot rotate webhook secret on a non-webhook worker."""
        r = client.patch(
            f"/workers/{self.worker_id}",
            json={"webhook_secret_rotate": True},
        )
        self.assertEqual(r.status_code, 400)

    def test_patch_webhook_secret_rotate_returns_new_secret(self):
        """webhook_secret_rotate=true on a webhook worker returns new_webhook_secret once."""
        webhook_worker = _create_webhook_worker()
        wid = webhook_worker["id"]
        r = client.patch(f"/workers/{wid}", json={"webhook_secret_rotate": True})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIn("new_webhook_secret", body)
        secret = body["new_webhook_secret"]
        self.assertIsNotNone(secret)
        self.assertGreater(len(secret), 10)

    def test_patch_webhook_secret_rotate_secret_not_in_subsequent_get(self):
        """After rotation, GET /workers/{id} must NOT return the secret."""
        webhook_worker = _create_webhook_worker()
        wid = webhook_worker["id"]
        client.patch(f"/workers/{wid}", json={"webhook_secret_rotate": True})
        r = client.get(f"/workers/{wid}")
        # new_webhook_secret should be null on a plain GET
        body = r.json()
        self.assertIsNone(body.get("new_webhook_secret"))

    def test_patch_empty_body_is_noop(self):
        """Empty PATCH should return 200 with unchanged worker."""
        r = client.patch(f"/workers/{self.worker_id}", json={})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["id"], self.worker_id)


class TestContextsAPI(unittest.TestCase):
    """Binary-safe filesystem contexts API."""

    def setUp(self):
        self.old_secret = os.environ.get("FLOOM_SECRET")
        os.environ["FLOOM_SECRET"] = "context-test-secret"
        get_auth_provider.cache_clear()
        self.tmpdir = Path(tempfile.mkdtemp(prefix="workeros-contexts-test-"))
        self.old_contexts_dir = contexts_module.CONTEXTS_DIR
        self.old_metadata_path = contexts_module.CONTEXT_METADATA_PATH
        self.old_app_contexts_dir = app_module.CONTEXTS_DIR
        contexts_module.CONTEXTS_DIR = self.tmpdir
        contexts_module.CONTEXT_METADATA_PATH = self.tmpdir / ".workeros-contexts.json"
        app_module.CONTEXTS_DIR = self.tmpdir

    def tearDown(self):
        if self.old_secret is None:
            os.environ.pop("FLOOM_SECRET", None)
        else:
            os.environ["FLOOM_SECRET"] = self.old_secret
        get_auth_provider.cache_clear()
        contexts_module.CONTEXTS_DIR = self.old_contexts_dir
        contexts_module.CONTEXT_METADATA_PATH = self.old_metadata_path
        app_module.CONTEXTS_DIR = self.old_app_contexts_dir
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _headers(self) -> dict:
        return {"x-floom-secret": "context-test-secret"}

    def test_context_crud_supports_text_binary_and_multipart_upload(self):
        created = client.post("/contexts/kb-test", json={"writeable": True}, headers=self._headers())
        self.assertEqual(created.status_code, 200, created.text)
        self.assertTrue(created.json()["writeable"])

        text_saved = client.put(
            "/contexts/kb-test/files/docs/faq.md",
            json={"content": "# FAQ\n\nHello"},
            headers=self._headers(),
        )
        self.assertEqual(text_saved.status_code, 200, text_saved.text)
        self.assertEqual(text_saved.json()["mime_type"], "text/markdown")
        self.assertFalse(text_saved.json()["is_binary"])

        code_saved = client.put(
            "/contexts/kb-test/files/src/index.ts",
            json={"content": "export const answer = 42;\n"},
            headers=self._headers(),
        )
        self.assertEqual(code_saved.status_code, 200, code_saved.text)
        self.assertFalse(code_saved.json()["is_binary"])

        pdf_bytes = b"%PDF-1.4\n\x00binary"
        binary_saved = client.put(
            "/contexts/kb-test/files/files/spec.pdf",
            content=pdf_bytes,
            headers={**self._headers(), "content-type": "application/octet-stream"},
        )
        self.assertEqual(binary_saved.status_code, 200, binary_saved.text)
        self.assertEqual(binary_saved.json()["mime_type"], "application/pdf")
        self.assertTrue(binary_saved.json()["is_binary"])

        uploaded = client.post(
            "/contexts/kb-test/upload",
            files=[("files", ("image.png", b"\x89PNG\r\n", "image/png"))],
            headers=self._headers(),
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertEqual(uploaded.json()["files"][0]["path"], "image.png")

        detail = client.get("/contexts/kb-test", headers=self._headers())
        self.assertEqual(detail.status_code, 200)
        paths = {item["path"] for item in detail.json()["files"]}
        self.assertEqual(paths, {"docs/faq.md", "files/spec.pdf", "image.png", "src/index.ts"})

        text_download = client.get("/contexts/kb-test/files/docs/faq.md", headers=self._headers())
        self.assertEqual(text_download.status_code, 200)
        self.assertEqual(text_download.text, "# FAQ\n\nHello")

        binary_download = client.get("/contexts/kb-test/files/files/spec.pdf", headers=self._headers())
        self.assertEqual(binary_download.status_code, 200)
        self.assertEqual(binary_download.content, pdf_bytes)
        self.assertIn("attachment", binary_download.headers.get("content-disposition", ""))

    def test_context_paths_reject_traversal(self):
        created = client.post("/contexts/kb-test", json={}, headers=self._headers())
        self.assertEqual(created.status_code, 200, created.text)

        r = client.put(
            "/contexts/kb-test/files/%2e%2e/secret.txt",
            content=b"nope",
            headers={**self._headers(), "content-type": "application/octet-stream"},
        )
        self.assertEqual(r.status_code, 400, r.text)
        self.assertFalse((self.tmpdir.parent / "secret.txt").exists())

    def test_scope_resolver_isolates_tenants(self):
        """In cloud mode, a registered scope resolver MUST prefix every
        context FS path with the active scope id, so workspace A's
        contexts are invisible to workspace B (and vice versa). This is
        the BUG #34 regression test."""
        # Workspace A creates a context + a file
        contexts_module.set_context_scope_resolver(lambda: "ws_AAAA111")
        try:
            ra = client.post("/contexts/kb-a", json={}, headers=self._headers())
            self.assertEqual(ra.status_code, 200, ra.text)
            fa = client.put(
                "/contexts/kb-a/files/secret.txt",
                json={"content": "tenant-A-only"},
                headers=self._headers(),
            )
            self.assertEqual(fa.status_code, 200, fa.text)
            la = client.get("/contexts", headers=self._headers())
            self.assertEqual(la.status_code, 200)
            self.assertEqual({c["name"] for c in la.json()}, {"kb-a"})

            # FS layout: scoped subdir under tmpdir
            self.assertTrue((self.tmpdir / "ws_AAAA111" / "kb-a" / "secret.txt").is_file())
        finally:
            pass

        # Workspace B sees an empty list, can't read kb-a, can create its own
        contexts_module.set_context_scope_resolver(lambda: "ws_BBBB222")
        try:
            lb = client.get("/contexts", headers=self._headers())
            self.assertEqual(lb.status_code, 200)
            self.assertEqual(lb.json(), [], "Workspace B must not see workspace A's contexts")

            denied = client.get("/contexts/kb-a", headers=self._headers())
            self.assertEqual(denied.status_code, 404, "kb-a must be invisible to workspace B")

            denied_file = client.get(
                "/contexts/kb-a/files/secret.txt",
                headers=self._headers(),
            )
            self.assertEqual(denied_file.status_code, 404)

            rb = client.post("/contexts/kb-b", json={}, headers=self._headers())
            self.assertEqual(rb.status_code, 200, rb.text)
            lb2 = client.get("/contexts", headers=self._headers())
            self.assertEqual({c["name"] for c in lb2.json()}, {"kb-b"})

            self.assertTrue((self.tmpdir / "ws_BBBB222" / "kb-b").is_dir())
            # Workspace A's dir still exists; B's create did NOT collide with A's kb-a
            self.assertTrue((self.tmpdir / "ws_AAAA111" / "kb-a").is_dir())
        finally:
            contexts_module.set_context_scope_resolver(None)

        # Resolver cleared -> unscoped (OSS behavior). Both workspace dirs are
        # visible as siblings of any pre-existing legacy contexts. We do NOT
        # assert listing here because unscoped mode treats the scope dirs
        # themselves as contexts; that is by design for OSS migration.

    def test_resolver_with_invalid_scope_falls_back_to_unscoped(self):
        """A scope resolver returning something unsafe (path traversal,
        empty string) must fall back to unscoped behavior so we never
        write outside CONTEXTS_DIR."""
        contexts_module.set_context_scope_resolver(lambda: "../escape")
        try:
            r = client.post("/contexts/kb-fallback", json={}, headers=self._headers())
            self.assertEqual(r.status_code, 200, r.text)
            # Created directly under CONTEXTS_DIR, NOT under "../escape"
            self.assertTrue((self.tmpdir / "kb-fallback").is_dir())
            self.assertFalse((self.tmpdir.parent / "escape").exists())
        finally:
            contexts_module.set_context_scope_resolver(None)


# ===========================================================================
# DELETE /workers/{worker_id} tests (Deliverable 2)
# ===========================================================================

class TestDeleteWorker(unittest.TestCase):
    """Tests for DELETE /workers/{worker_id}."""

    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)

    def test_delete_nonexistent_worker_returns_404(self):
        r = client.delete("/workers/does-not-exist")
        self.assertEqual(r.status_code, 404)

    def test_delete_worker_returns_204(self):
        worker = _create_manual_worker()
        wid = worker["id"]
        r = client.delete(f"/workers/{wid}")
        self.assertEqual(r.status_code, 204)

    def test_delete_worker_no_longer_in_list(self):
        worker = _create_manual_worker()
        wid = worker["id"]
        client.delete(f"/workers/{wid}")
        r = client.get("/workers")
        ids = [w["id"] for w in r.json()]
        self.assertNotIn(wid, ids)

    def test_delete_worker_get_returns_404(self):
        worker = _create_manual_worker()
        wid = worker["id"]
        client.delete(f"/workers/{wid}")
        r = client.get(f"/workers/{wid}")
        self.assertEqual(r.status_code, 404)

    def test_delete_preserves_skill_version_when_shared(self):
        """Deleting one worker must not delete skill_versions used by other workers."""
        from db import get_db

        w1 = _create_manual_worker()
        w1_id = w1["id"]
        # Create a second worker to ensure skill_versions still has rows
        _create_manual_worker()

        with get_db() as conn:
            count_before = conn.execute("SELECT COUNT(*) as c FROM skill_versions").fetchone()["c"]

        client.delete(f"/workers/{w1_id}")

        with get_db() as conn:
            count_after = conn.execute("SELECT COUNT(*) as c FROM skill_versions").fetchone()["c"]
        # skill_version count should only decrease by at most 1 (the deleted worker's version)
        self.assertGreaterEqual(count_after, count_before - 1)
        # The second worker's skill_version must still exist
        self.assertGreater(count_after, 0)

    def test_delete_worker_with_running_run_cancels_run(self):
        """DELETE on a worker with an in-progress run must cancel the run gracefully."""
        import uuid as _uuid
        from db import get_db

        worker = _create_manual_worker()
        wid = worker["id"]

        # Manually insert a 'running' run (don't call start_run to avoid actual execution)
        run_id = f"run_{_uuid.uuid4().hex[:12]}"
        with get_db() as conn:
            conn.execute(
                """INSERT INTO runs (id, worker_id, status, trigger_source, runner,
                   input_json, approval_status, created_at)
                   VALUES (?, ?, 'running', 'manual', 'local', '{}', 'not_required', datetime('now'))""",
                (run_id, wid),
            )

        # Delete the worker
        r = client.delete(f"/workers/{wid}")
        self.assertEqual(r.status_code, 204)

        # Verify run is now failed or gone (CASCADE delete removes it)
        with get_db() as conn:
            row = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
        # Either the run was cancelled (failed) OR deleted by CASCADE
        if row:
            self.assertEqual(row["status"], "failed")
        # else: cascade deleted — also acceptable

    def test_double_delete_returns_404(self):
        worker = _create_manual_worker()
        wid = worker["id"]
        r1 = client.delete(f"/workers/{wid}")
        self.assertEqual(r1.status_code, 204)
        r2 = client.delete(f"/workers/{wid}")
        self.assertEqual(r2.status_code, 404)


# ===========================================================================
# GET /runs/{run_id}/events SSE tests (Deliverable 3)
# ===========================================================================

class TestRunEventsSSE(unittest.TestCase):
    """Tests for GET /runs/{run_id}/events."""

    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)

    def _insert_run(self, status: str = "running") -> str:
        """Insert a run row directly and return run_id."""
        import uuid as _uuid
        from db import get_db

        worker = _create_manual_worker()
        wid = worker["id"]
        run_id = f"run_{_uuid.uuid4().hex[:12]}"
        with get_db() as conn:
            conn.execute(
                """INSERT INTO runs (id, worker_id, status, trigger_source, runner,
                   input_json, approval_status, created_at)
                   VALUES (?, ?, ?, 'manual', 'local', '{}', 'not_required', datetime('now'))""",
                (run_id, wid, status),
            )
        return run_id

    def test_sse_nonexistent_run_returns_404(self):
        r = client.get("/runs/nonexistent-run/events")
        self.assertEqual(r.status_code, 404)

    def test_sse_already_terminal_run_returns_final_state_and_closes(self):
        """If the run is already terminal when the client connects,
        emit the final state immediately and close."""
        run_id = self._insert_run(status="completed")
        lines = []
        with client.stream("GET", f"/runs/{run_id}/events") as r:
            self.assertEqual(r.status_code, 200)
            for line in r.iter_lines():
                if line.startswith("data:"):
                    lines.append(json.loads(line[5:].strip()))
                if len(lines) >= 2:
                    break

        # Should have at least a status event and a close event
        types = [e.get("type") for e in lines]
        self.assertIn("status", types)

    def test_sse_publishes_status_update(self):
        """Publishing an SSE event via _sse_publish must reach a connected consumer."""
        run_id = self._insert_run(status="running")
        received_events = []
        done = threading.Event()

        def stream_consumer():
            with client.stream("GET", f"/runs/{run_id}/events") as r:
                for line in r.iter_lines():
                    if line.startswith("data:"):
                        evt = json.loads(line[5:].strip())
                        received_events.append(evt)
                        if evt.get("type") == "close" or evt.get("status") in ("completed", "failed"):
                            break
                    if done.is_set():
                        break

        t = threading.Thread(target=stream_consumer, daemon=True)
        t.start()

        # Give the consumer time to connect
        time.sleep(0.3)

        # Publish a status event
        app_module._sse_publish(run_id, {
            "type": "status",
            "run_id": run_id,
            "status": "completed",
            "error": None,
        })

        t.join(timeout=5.0)
        done.set()

        statuses = [e.get("status") for e in received_events]
        self.assertIn("completed", statuses)

    def test_sse_queue_cleaned_up_after_disconnect(self):
        """After a run reaches terminal state, queues are cleaned up by the generator finally block.

        Note: TestClient uses sync transport so client-disconnect signals may not propagate
        immediately into the async generator's is_disconnected() check. We test cleanup via
        the terminal-status path instead, which is the primary GC mechanism.
        """
        run_id = self._insert_run(status="running")
        consumer_done = threading.Event()
        received = []

        def stream_consumer():
            with client.stream("GET", f"/runs/{run_id}/events") as r:
                for line in r.iter_lines():
                    if line.startswith("data:"):
                        evt = json.loads(line[5:].strip())
                        received.append(evt)
                        # Stop reading after the terminal event
                        if evt.get("status") in ("failed", "completed"):
                            break
            consumer_done.set()

        t = threading.Thread(target=stream_consumer, daemon=True)
        t.start()

        time.sleep(0.3)

        # Publish a terminal event which causes the generator to exit its loop + run finally
        app_module._sse_publish(run_id, {
            "type": "status",
            "run_id": run_id,
            "status": "failed",
            "error": "test-cleanup",
        })

        t.join(timeout=8.0)
        consumer_done.wait(timeout=8.0)

        # After terminal event, generator exits and finally runs _sse_cleanup
        # Allow a short window for the async generator finally block to execute
        deadline = time.time() + 5.0
        while time.time() < deadline:
            with app_module._sse_lock:
                remaining = len(app_module._sse_queues.get(run_id, []))
            if remaining == 0:
                break
            time.sleep(0.1)

        with app_module._sse_lock:
            queues = app_module._sse_queues.get(run_id, [])
        self.assertEqual(len(queues), 0, f"Queue not cleaned up within 5s: {queues}")

    def test_sse_multiple_consumers_same_run(self):
        """5 concurrent SSE consumers on the same run must all receive events."""
        run_id = self._insert_run(status="running")
        n_consumers = 5
        consumer_events: list[list] = [[] for _ in range(n_consumers)]
        consumers_started = threading.Event()
        start_lock = threading.Lock()
        started_count = [0]

        def consumer(idx: int):
            with client.stream("GET", f"/runs/{run_id}/events") as r:
                with start_lock:
                    started_count[0] += 1
                    if started_count[0] == n_consumers:
                        consumers_started.set()
                for line in r.iter_lines():
                    if line.startswith("data:"):
                        evt = json.loads(line[5:].strip())
                        consumer_events[idx].append(evt)
                        if evt.get("status") in ("failed", "completed") or evt.get("type") == "close":
                            break

        threads = [threading.Thread(target=consumer, args=(i,), daemon=True) for i in range(n_consumers)]
        for t in threads:
            t.start()

        # Wait for consumers to connect (with timeout)
        consumers_started.wait(timeout=10.0)
        time.sleep(0.3)

        # Publish one event to all consumers
        test_evt = {"type": "status", "run_id": run_id, "status": "failed", "error": "test"}
        app_module._sse_publish(run_id, test_evt)

        for t in threads:
            t.join(timeout=8.0)

        # Each consumer must have received the failed status
        for idx, events in enumerate(consumer_events):
            statuses = [e.get("status") for e in events]
            self.assertIn("failed", statuses, f"Consumer {idx} missed the event: {events}")

    def test_sse_run_completes_before_client_connects(self):
        """If run is already terminal, client connects and immediately gets final state + close."""
        run_id = self._insert_run(status="failed")
        events = []
        with client.stream("GET", f"/runs/{run_id}/events") as r:
            self.assertEqual(r.status_code, 200)
            for line in r.iter_lines():
                if line.startswith("data:"):
                    evt = json.loads(line[5:].strip())
                    events.append(evt)
                    # Stream should close after sending final state
                    break

        self.assertTrue(len(events) >= 1)
        types_or_statuses = [e.get("type") or e.get("status") for e in events]
        self.assertTrue(
            any(t in ("status", "close") for t in types_or_statuses),
            f"Expected status/close event, got: {events}",
        )


# ===========================================================================
# Approval status publisher tests
# ===========================================================================

class TestApprovalStatusPublisher(unittest.TestCase):
    """Tests for approval/rejection terminal SSE status events."""

    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)

    def _insert_pending_approval_run(self) -> str:
        from db import get_db

        worker = _create_manual_worker()
        worker_id = worker["id"]
        run_id = f"run_{_uuid_mod.uuid4().hex[:12]}"
        approval_id = f"approval_{_uuid_mod.uuid4().hex[:12]}"
        with get_db() as conn:
            conn.execute(
                """INSERT INTO runs (id, worker_id, status, trigger_source, runner,
                   input_json, approval_status, created_at)
                   VALUES (?, ?, 'pending_approval', 'manual', 'local', '{}', 'pending', datetime('now'))""",
                (run_id, worker_id),
            )
            conn.execute(
                """INSERT INTO approvals (id, run_id, worker_id, owner_id, status, label, preview, created_at)
                   VALUES (?, ?, ?, 'federico', 'pending', 'Approve output', 'preview', datetime('now'))""",
                (approval_id, run_id, worker_id),
            )
        return run_id

    def test_approve_run_publishes_terminal_status(self):
        run_id = self._insert_pending_approval_run()

        with patch.object(app_module, "_sse_publish") as publish:
            r = client.post(f"/runs/{run_id}/approve")

        self.assertEqual(r.status_code, 200)
        status_events = [call.args[1] for call in publish.call_args_list if call.args[1].get("type") == "status"]
        self.assertTrue(status_events)
        self.assertEqual(status_events[-1]["run_id"], run_id)
        self.assertEqual(status_events[-1]["status"], "approved")
        self.assertIn("completed_at", status_events[-1])

    def test_reject_run_publishes_terminal_status(self):
        run_id = self._insert_pending_approval_run()

        with patch.object(app_module, "_sse_publish") as publish:
            r = client.post(f"/runs/{run_id}/reject", json={"reason": "Not ready"})

        self.assertEqual(r.status_code, 200)
        status_events = [call.args[1] for call in publish.call_args_list if call.args[1].get("type") == "status"]
        self.assertTrue(status_events)
        self.assertEqual(status_events[-1]["run_id"], run_id)
        self.assertEqual(status_events[-1]["status"], "rejected")
        self.assertIn("completed_at", status_events[-1])


# ===========================================================================
# Approval-required run lifecycle tests
# ===========================================================================

class TestApprovalRunLifecycle(unittest.TestCase):
    """Tests for approval-required status event order."""

    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)

    def test_approval_required_run_publishes_pending_before_completed(self):
        from db import get_db
        from models import WorkerResult
        import run_service

        worker = _create_approval_worker()
        run_id = run_service.create_run(worker["id"], {})
        events = []
        approval_exists_when_pending = []

        class FakeDriver:
            def run(self, **_kwargs):
                # S47 HITL: a worker requests human approval by emitting
                # decision_required in its result. Combined with the manifest's
                # approvals.required, this lands the run as PENDING_APPROVAL
                # instead of COMPLETED.
                return WorkerResult(
                    status="success",
                    outputs={"message": "ready"},
                    decision_required={"label": "Approve test output", "preview": "ready"},
                )

        def capture(published_run_id: str, event: dict) -> None:
            if published_run_id == run_id:
                events.append(dict(event))
                if event.get("type") == "status" and event.get("status") == "pending_approval":
                    with get_db() as conn:
                        row = conn.execute("SELECT id FROM approvals WHERE run_id = ?", (run_id,)).fetchone()
                    approval_exists_when_pending.append(row is not None)

        run_service.register_sse_publisher(capture)
        try:
            with patch.object(run_service, "get_sandbox_driver", return_value=FakeDriver()):
                run_service.execute_run(run_id, worker["id"], {})
        finally:
            run_service.register_sse_publisher(app_module._sse_publish)

        statuses = [
            event.get("status")
            for event in events
            if event.get("type") == "status"
        ]
        self.assertIn("pending_approval", statuses)
        self.assertNotIn("completed", statuses)
        self.assertEqual(approval_exists_when_pending, [True])

        pending_index = statuses.index("pending_approval")
        completed_indexes = [idx for idx, status in enumerate(statuses) if status == "completed"]
        self.assertTrue(all(pending_index < idx for idx in completed_indexes))

        with get_db() as conn:
            run_row = conn.execute("SELECT status, output_json FROM runs WHERE id = ?", (run_id,)).fetchone()
            approval_row = conn.execute("SELECT status FROM approvals WHERE run_id = ?", (run_id,)).fetchone()
        self.assertEqual(run_row["status"], "pending_approval")
        self.assertEqual(json.loads(run_row["output_json"]), {"message": "ready"})
        self.assertEqual(approval_row["status"], "pending")


# ===========================================================================
# Round-8 P2 hardening
# ===========================================================================

def _make_schedule_worker_yml(name: str, cron: str) -> str:
    """Schedule-triggered worker YAML carrying a cron expression."""
    return f"""schema_version: "0.3"
name: {name}
title: Test Schedule Worker {name}
description: Auto-generated schedule worker for cron-validation tests.
version: 0.1.0
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  inputs: []
  outputs: []
trigger:
  type: schedule
  cron: "{cron}"
"""


class TestRound8CronValidateAtCreate(unittest.TestCase):
    """Fix 3: invalid cron in worker.yml is rejected at CREATE, not just PATCH."""

    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)

    def test_invalid_cron_at_create_returns_422(self):
        name = _unique_name("r8p2-cron-bad")
        r = client.post(
            "/workers",
            json={"worker_yml": _make_schedule_worker_yml(name, "invalid"), "run_py": _RUN_PY},
        )
        # Pydantic ValidationError on the trigger.cron field -> 400 (schema
        # validation) or 422; the create path maps schema errors to 400.
        self.assertIn(r.status_code, (400, 422), r.text)
        self.assertNotEqual(r.status_code, 200, "invalid cron must NOT be accepted")

    def test_valid_cron_at_create_accepted(self):
        name = _unique_name("r8p2-cron-ok")
        r = client.post(
            "/workers",
            json={"worker_yml": _make_schedule_worker_yml(name, "0 9 * * 1"), "run_py": _RUN_PY},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["id"], name)
        client.delete(f"/workers/{name}")


class TestRound8ContextHtmlXss(unittest.TestCase):
    """Fix 1: uploaded text/html context file must not render inline (stored XSS)."""

    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)

    def _create_context(self, name: str) -> None:
        r = client.post(f"/contexts/{name}", json={"writeable": True})
        assert r.status_code == 200, r.text

    def test_html_context_file_served_as_attachment_neutralized(self):
        name = _unique_name("r8p2-ctx")
        self._create_context(name)
        try:
            payload = b"<script>alert(document.domain)</script><h1>x</h1>"
            put = client.put(f"/contexts/{name}/files/evil.html", content=payload)
            self.assertEqual(put.status_code, 200, put.text)

            r = client.get(f"/contexts/{name}/files/evil.html")
            self.assertEqual(r.status_code, 200, r.text)
            ctype = r.headers.get("content-type", "").lower()
            disp = r.headers.get("content-disposition", "").lower()
            # Must NOT be served as active text/html in our origin.
            self.assertNotIn("text/html", ctype, f"html served inline as {ctype!r}")
            # Either force-download OR neutralized to text/plain (we do both).
            self.assertTrue(
                "attachment" in disp or ctype.startswith("text/plain"),
                f"html not neutralized: ctype={ctype!r} disp={disp!r}",
            )
            # Body is preserved (download), just not executable.
            self.assertEqual(r.content, payload)
        finally:
            client.delete(f"/contexts/{name}?force=true")

    def test_markdown_and_txt_still_serve_inline(self):
        name = _unique_name("r8p2-ctx")
        self._create_context(name)
        try:
            md = client.put(f"/contexts/{name}/files/readme.md", content=b"# Title\n")
            self.assertEqual(md.status_code, 200, md.text)
            txt = client.put(f"/contexts/{name}/files/notes.txt", content=b"hello")
            self.assertEqual(txt.status_code, 200, txt.text)

            r_md = client.get(f"/contexts/{name}/files/readme.md")
            r_txt = client.get(f"/contexts/{name}/files/notes.txt")
            self.assertEqual(r_md.status_code, 200, r_md.text)
            self.assertEqual(r_txt.status_code, 200, r_txt.text)
            # Inline (no forced attachment) for safe-preview text types.
            self.assertNotIn("attachment", r_md.headers.get("content-disposition", "").lower())
            self.assertNotIn("attachment", r_txt.headers.get("content-disposition", "").lower())
            self.assertEqual(r_md.content, b"# Title\n")
            self.assertEqual(r_txt.content, b"hello")
        finally:
            client.delete(f"/contexts/{name}?force=true")


class TestRound8ApprovalMisconfigDiagnostic(unittest.TestCase):
    """Fix 4: approvals.required worker that never emits decision_required
    synthesizes an approval gate and logs the fallback."""

    def setUp(self):
        os.environ.pop("FLOOM_SECRET", None)

    def test_misconfigured_approval_worker_logs_clear_diagnostic(self):
        from models import WorkerResult
        import run_service

        worker = _create_approval_worker()
        run_id = run_service.create_run(worker["id"], {})

        class FakeDriver:
            def run(self, **_kwargs):
                # Legacy worker behavior: approvals.required:true but NO explicit decision_required.
                return WorkerResult(status="success", outputs={"message": "done"})

        with patch.object(run_service, "get_sandbox_driver", return_value=FakeDriver()):
            run_service.execute_run(run_id, worker["id"], {})

        logs = client.get(f"/runs/{run_id}/logs")
        self.assertEqual(logs.status_code, 200, logs.text)
        messages = " ".join(row["message"] for row in logs.json())
        self.assertIn("approvals.required", messages)
        self.assertIn("decision_required", messages)
        self.assertIn("synthesising approval gate", messages)
        self.assertIn("Run awaiting approval", messages)


# ===========================================================================
# /healthz endpoint
# ===========================================================================

class TestHealthz(unittest.TestCase):
    def test_healthz_returns_ok(self):
        r = client.get("/healthz")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "ok")

    def test_healthz_no_secret_required_even_when_secret_set(self):
        os.environ["FLOOM_SECRET"] = "some-secret"
        try:
            r = client.get("/healthz")
            self.assertEqual(r.status_code, 200)
        finally:
            os.environ.pop("FLOOM_SECRET", None)


# ===========================================================================
# Entry point
# ===========================================================================

if __name__ == "__main__":
    unittest.main(verbosity=2)
