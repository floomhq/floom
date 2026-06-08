"""X4: structured reviewer annotations (highlight+comment / screenshot pins).

Covers the contract for the richer approval-review feedback that the standalone
/approvals/review page now sends alongside an approve/reject decision:

  - Reject (and approve) carry a structured `annotations` object that is
    sanitized + persisted on the approval row (alongside the free-text reason).
  - The owner sees the parsed annotations back on the run/approval response.
  - A signed-link (no-auth) external reviewer can upload a screenshot AND attach
    annotations — the link is the credential on every write.
  - Image refs in annotations are pinned to OUR content-addressed upload store
    (`/uploads/<sha256>`); arbitrary http(s) URLs are stripped (no SSRF / beacon
    via a persisted annotation the owner later renders).

Persistence is verified through the REAL sqlite repositories + the live app, so
the migration + repo columns + endpoint wiring are all exercised end to end.
"""

from __future__ import annotations

import io
import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-approval-annotations-test-"))
_DB_PATH = str(_TEST_DIR / "workeros.db")
os.environ["WORKEROS_DB"] = _DB_PATH
os.environ["FLOOM_DB"] = _DB_PATH
os.environ["WORKEROS_DEPLOY"] = "local"
os.environ["WORKEROS_API_ENV_FILE"] = str(_TEST_DIR / "api.env")
# Blobs land next to the test DB so screenshot uploads are isolated + cleaned.
os.environ["FLOOM_BLOBS_DIR"] = str(_TEST_DIR / "blobs")
# Deterministic secret -> stable public-link HMAC token + authed writes. We do
# NOT set WORKEROS_USER_ID (keep the default `federico`) so we don't leak a
# custom owner into other test modules sharing this process.
os.environ["FLOOM_SECRET"] = "test-secret-x4-annotations"

import main  # noqa: E402

_AUTH = {"x-floom-secret": "test-secret-x4-annotations"}
_OWNER = "federico"


@pytest.fixture(autouse=True)
def _pin_db_to_this_module():
    """Re-pin WORKEROS_DB/FLOOM_DB to THIS module's DB before every test.

    `get_db()` re-reads the DB path from env on every call, and sibling test
    modules mutate the same global env at import time. Without re-pinning, a
    sibling's import order can redirect our real-DB writes + the app's reads to
    a different database mid-run. Re-pinning here keeps this module's seeded
    rows and HTTP calls on the same migrated DB regardless of suite ordering.
    """
    os.environ["WORKEROS_DB"] = _DB_PATH
    os.environ["FLOOM_DB"] = _DB_PATH
    os.environ["FLOOM_SECRET"] = "test-secret-x4-annotations"
    main.init_db()
    yield


def _seed_pending_approval(approval_id: str, run_id: str) -> dict:
    """Insert a real worker + PENDING_APPROVAL run + pending approval row."""
    repos = main.get_repositories()
    worker_id = f"worker_{approval_id}"
    repos.workers.create(
        user_id=_OWNER,
        worker_id=worker_id,
        name=f"Annotation Worker {approval_id}",
        manifest_json={
            # Unique name+version per worker so each gets its own skill_versions
            # row (UNIQUE(name, version)) and INSERT OR REPLACE never evicts a
            # row another seeded worker's FK still references.
            "id": worker_id,
            "name": worker_id,
            "version": f"0.1.0-{approval_id}",
            "trigger": {"type": "manual"},
            "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
            "inputs": [],
            "outputs": [],
            "secrets": [],
        },
        bundle_path=f"workers/{worker_id}",
    )
    repos.runs.create(
        user_id=_OWNER,
        run_id=run_id,
        worker_id=worker_id,
        status=main.RunStatus.PENDING_APPROVAL.value,
        trigger_source="manual",
        runner="e2b",
        input_json={},
        output_json={"proposed": "draft text the reviewer is critiquing"},
    )
    approval = repos.approvals.create(
        owner_id=_OWNER,
        id=approval_id,
        run_id=run_id,
        worker_id=worker_id,
        status="pending",
        label="Review the draft",
        preview="draft text the reviewer is critiquing",
        decision_input_json="{}",
        created_at="2026-06-03T10:00:00Z",
    )
    return dict(approval)


def _client() -> TestClient:
    return TestClient(main.app)


# ---------------------------------------------------------------------------
# 1. Sanitizer: structure, caps, and the SSRF / external-URL gate.
# ---------------------------------------------------------------------------


def test_sanitize_keeps_text_and_uploaded_image_refs():
    sha = "a" * 64
    raw = {
        "text": [
            {"quote": "the second paragraph", "comment": "this claim is unsupported"},
            {"quote": "", "comment": ""},  # empty -> dropped
        ],
        "images": [
            {
                "url": f"/uploads/{sha}?download_token=tok",
                "caption": "annotated screenshot",
                "pins": [{"x": 0.5, "y": 0.25, "comment": "fix this button"}],
            }
        ],
    }
    out = main._sanitize_annotations(raw)
    assert out is not None
    assert len(out["text"]) == 1
    assert out["text"][0]["comment"] == "this claim is unsupported"
    assert len(out["images"]) == 1
    assert out["images"][0]["url"].startswith(f"/uploads/{sha}")
    assert out["images"][0]["pins"][0]["x"] == 0.5
    assert out["images"][0]["pins"][0]["comment"] == "fix this button"


def test_sanitize_strips_external_image_urls():
    """Arbitrary http(s) refs are refused — only our /uploads/<sha> store."""
    raw = {
        "images": [
            {"url": "https://evil.example/internal-metadata", "caption": "x"},
            {"url": "/uploads/not-a-sha", "caption": "y"},
            {"url": "file:///etc/passwd", "caption": "z"},
        ]
    }
    out = main._sanitize_annotations(raw)
    # Every image had an unusable ref -> no images survive -> nothing to persist.
    assert out is None


def test_sanitize_returns_none_for_empty():
    assert main._sanitize_annotations({}) is None
    assert main._sanitize_annotations({"text": [], "images": []}) is None
    assert main._sanitize_annotations("not a dict") is None


# ---------------------------------------------------------------------------
# 2. Authed reject with annotations -> persisted + visible to the owner.
# ---------------------------------------------------------------------------


def test_authed_reject_persists_annotations_visible_to_owner():
    _seed_pending_approval("apr_reject", "run_reject")
    client = _client()
    sha = "b" * 64
    annotations = {
        "text": [{"quote": "claims 40% lift", "comment": "no source for this number"}],
        "images": [
            {
                "url": f"/uploads/{sha}?download_token=t",
                "caption": "chart looks wrong",
                "pins": [{"x": 0.1, "y": 0.9, "comment": "axis mislabeled"}],
            }
        ],
    }
    resp = client.post(
        "/runs/run_reject/reject",
        headers=_AUTH,
        json={"reason": "needs sources", "annotations": annotations},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"

    # Owner lists rejected approvals and sees the structured feedback parsed back.
    listed = client.get("/approvals?status=rejected", headers=_AUTH)
    assert listed.status_code == 200, listed.text
    row = next(r for r in listed.json() if r["id"] == "apr_reject")
    assert row["reason"] == "needs sources"
    assert row["annotations"] is not None
    assert row["annotations"]["text"][0]["comment"] == "no source for this number"
    assert row["annotations"]["images"][0]["pins"][0]["comment"] == "axis mislabeled"
    # Raw column name is never leaked in the response.
    assert "annotations_json" not in row


# ---------------------------------------------------------------------------
# 3. Public signed-link reviewer: upload a screenshot + reject with annotations.
# ---------------------------------------------------------------------------


def test_public_reviewer_uploads_screenshot_and_annotates():
    approval = _seed_pending_approval("apr_public", "run_public")
    token = main._approval_public_token(approval)
    client = _client()

    # 3a. Anonymous (no x-floom-secret) screenshot upload via the signed link.
    png_bytes = (
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 64  # minimal PNG-ish payload
    )
    upload = client.post(
        f"/approvals/public/apr_public/uploads?token={token}",
        files={"file": ("review.png", io.BytesIO(png_bytes), "image/png")},
    )
    assert upload.status_code == 200, upload.text
    ref = upload.json()["url"]
    assert ref.startswith("/uploads/")
    assert upload.json()["media_type"] == "image/png"

    # 3b. Anonymous reject carrying the uploaded ref inside the annotations.
    annotations = {
        "text": [{"quote": "headline", "comment": "tone is too aggressive"}],
        "images": [
            {"url": ref, "caption": "see the banner", "pins": [{"x": 0.3, "y": 0.3, "comment": "crop this"}]}
        ],
    }
    reject = client.post(
        f"/approvals/public/apr_public/reject?token={token}",
        json={"reason": "revise tone", "annotations": annotations},
    )
    assert reject.status_code == 200, reject.text

    # 3c. The OWNER sees the external reviewer's structured feedback + image ref.
    listed = client.get("/approvals?status=rejected", headers=_AUTH)
    row = next(r for r in listed.json() if r["id"] == "apr_public")
    assert row["annotations"]["text"][0]["comment"] == "tone is too aggressive"
    assert row["annotations"]["images"][0]["url"].startswith("/uploads/")
    assert row["annotations"]["images"][0]["pins"][0]["comment"] == "crop this"


def test_public_upload_rejects_non_image():
    approval = _seed_pending_approval("apr_noimg", "run_noimg")
    token = main._approval_public_token(approval)
    client = _client()
    resp = client.post(
        f"/approvals/public/apr_noimg/uploads?token={token}",
        files={"file": ("notes.txt", io.BytesIO(b"hello"), "text/plain")},
    )
    # The image-only prefix gate refuses a text upload here.
    assert resp.status_code == 400, resp.text


def test_public_upload_requires_valid_token():
    approval = _seed_pending_approval("apr_badtok", "run_badtok")
    client = _client()
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    resp = client.post(
        "/approvals/public/apr_badtok/uploads?token=" + ("0" * 32),
        files={"file": ("x.png", io.BytesIO(png), "image/png")},
    )
    assert resp.status_code == 401, resp.text
