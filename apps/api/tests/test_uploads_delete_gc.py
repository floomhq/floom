"""F4: owner-scoped DELETE /uploads/{sha} + orphan-blob GC.

Uploaded blobs (approval screenshots, worker file inputs) are content-addressed
and stored on disk with a `ref_count` that tracks how many runs bind them.
Before this change there was NO way to delete an upload, so a blob with
`ref_count = 0` and no remaining owner lingered on disk forever.

Covers:
  - DELETE /uploads/{sha} by the owner removes the blob from disk + DB when it
    is unreferenced (ref_count == 0, no other owner).
  - A blob still bound to a run (ref_count > 0) is NOT physically deleted on the
    owner's DELETE — only the caller's ownership is dropped.
  - DELETE is owner-scoped: a non-owner gets 404 (same as a missing file — no
    existence oracle).
  - DELETE of a non-existent / non-sha id returns 404.
  - `_gc_orphan_blobs` sweeps ref_count == 0 + ownerless blobs and reclaims them.

Persistence is verified through the REAL sqlite repositories + the live app.

Run from repo root:
    cd apps/api && python3 -m pytest tests/test_uploads_delete_gc.py -x -q
"""

from __future__ import annotations

import io
import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-uploads-delete-test-"))
_DB_PATH = str(_TEST_DIR / "workeros.db")
os.environ["WORKEROS_DB"] = _DB_PATH
os.environ["FLOOM_DB"] = _DB_PATH
os.environ["WORKEROS_DEPLOY"] = "local"
os.environ["WORKEROS_API_ENV_FILE"] = str(_TEST_DIR / "api.env")
os.environ["FLOOM_BLOBS_DIR"] = str(_TEST_DIR / "blobs")
os.environ["FLOOM_SECRET"] = "test-secret-f4-uploads"

import main  # noqa: E402
from auth.context import AuthContext  # noqa: E402
from auth.dependency import get_auth_context  # noqa: E402

_SECRET = "test-secret-f4-uploads"
_AUTH = {"x-floom-secret": _SECRET}
_OWNER = "local-user"


def _auth_as(user_id: str):
    def _override() -> AuthContext:
        return AuthContext(user_id=user_id, email=None, scopes=("admin",))

    return _override


@pytest.fixture(autouse=True)
def _pin_db_and_auth():
    """Re-pin this module's DB/blobs/secret before every test and override auth.

    Sibling test modules mutate the same process-global env (DB path, secret,
    WORKEROS_USER_ID) at import time. Two independent guards keep this module
    deterministic regardless of suite ordering:

      1. The global ``auth_middleware`` reads ``FLOOM_SECRET`` from env per
         request, so we re-pin it and send the matching ``x-floom-secret``
         header.
      2. The per-request OWNER could otherwise vary with a leaked
         ``WORKEROS_USER_ID``, so we override the ``get_auth_context`` dependency
         to a fixed owner (``_OWNER``) — the handler body sees a stable identity.

    DB/blob paths are re-pinned because ``get_db()`` re-reads them on every call.
    """
    os.environ["WORKEROS_DB"] = _DB_PATH
    os.environ["FLOOM_DB"] = _DB_PATH
    os.environ["FLOOM_BLOBS_DIR"] = str(_TEST_DIR / "blobs")
    os.environ["FLOOM_SECRET"] = _SECRET
    os.environ["WORKEROS_DEPLOY"] = "local"
    # files.BLOBS_DIR is resolved once at module import, and sibling tests pop +
    # re-import `files` under their own tmp dirs. The upload pipeline (now in
    # services.uploads) resolves `files` at call time, so re-pin the LIVE
    # instance's BLOBS_DIR to this module's dir — env alone is not enough.
    import sys as _sys
    _files_mod = _sys.modules.get("files")
    if _files_mod is not None:
        _files_mod.BLOBS_DIR = (_TEST_DIR / "blobs").resolve()
    main.init_db()
    main.app.dependency_overrides[get_auth_context] = _auth_as(_OWNER)
    try:
        yield
    finally:
        main.app.dependency_overrides.pop(get_auth_context, None)


def _client() -> TestClient:
    return TestClient(main.app)


def _upload(client: TestClient, content: bytes) -> str:
    resp = client.post(
        "/uploads",
        files={"file": ("note.txt", io.BytesIO(content), "text/plain")},
        headers=_AUTH,
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["sha256"]


def test_upload_accepts_mp4_and_mov_media_by_default():
    client = _client()
    for filename, media_type in [
        ("clip.mp4", "video/mp4"),
        ("iphone.mov", "video/quicktime"),
    ]:
        resp = client.post(
            "/uploads",
            files={"file": (filename, io.BytesIO(b"video-bytes"), media_type)},
            headers=_AUTH,
        )
        assert resp.status_code in (200, 201), resp.text
        body = resp.json()
        assert body["sha256"]
        assert body["media_type"] == media_type


def test_upload_default_limit_supports_large_media():
    from services.uploads import _upload_max_bytes

    assert _upload_max_bytes() == 500 * 1024 * 1024


def _blob_exists(sha: str) -> bool:
    # Resolve `files` at call time like the upload pipeline does — main's
    # module-level blob_path binding can be stale after sibling reloads.
    from files import blob_path
    return blob_path(sha).exists()


def _files_row(sha: str):
    with main.get_db() as conn:
        return conn.execute("SELECT id, ref_count FROM files WHERE id = ?", (sha,)).fetchone()


# ---------------------------------------------------------------------------
# 1. Owner deletes an unreferenced blob -> blob + row gone.
# ---------------------------------------------------------------------------

def test_owner_delete_unreferenced_blob_removes_disk_and_row():
    client = _client()
    sha = _upload(client, b"deletable content one")
    assert _blob_exists(sha) is True
    assert _files_row(sha) is not None

    resp = client.delete(f"/uploads/{sha}", headers=_AUTH)
    assert resp.status_code == 204, resp.text

    # Blob removed from disk AND files row deleted (ref_count was 0, no owner).
    assert _blob_exists(sha) is False
    assert _files_row(sha) is None


# ---------------------------------------------------------------------------
# 2. Blob still bound to a run (ref_count > 0) is NOT physically deleted.
# ---------------------------------------------------------------------------

def test_delete_keeps_blob_when_still_referenced_by_run():
    client = _client()
    sha = _upload(client, b"still referenced content")

    # Simulate a run binding this blob.
    main._increment_file_ref_counts([sha])
    row = _files_row(sha)
    assert int(row["ref_count"]) == 1

    resp = client.delete(f"/uploads/{sha}", headers=_AUTH)
    assert resp.status_code == 204, resp.text

    # The owner is dropped, but the blob + row survive because a run still
    # references it (ref_count > 0).
    assert _blob_exists(sha) is True
    assert _files_row(sha) is not None


# ---------------------------------------------------------------------------
# 3. Owner-scoped: a non-owner cannot delete; gets 404 (no existence oracle).
# ---------------------------------------------------------------------------

def test_delete_is_owner_scoped_non_owner_gets_404():
    client = _client()
    sha = _upload(client, b"owned by local-user only")

    # A second user must not be able to delete local-user's upload. Swap the auth
    # override to a different user for just this DELETE.
    main.app.dependency_overrides[get_auth_context] = _auth_as("intruder")
    try:
        resp = client.delete(f"/uploads/{sha}", headers=_AUTH)
    finally:
        main.app.dependency_overrides[get_auth_context] = _auth_as(_OWNER)

    assert resp.status_code == 404, resp.text
    # The blob is untouched for the real owner.
    assert _blob_exists(sha) is True
    assert _files_row(sha) is not None


def test_delete_missing_or_bad_id_returns_404():
    client = _client()
    missing_sha = "b" * 64
    resp = client.delete(f"/uploads/{missing_sha}", headers=_AUTH)
    assert resp.status_code == 404

    resp_bad = client.delete("/uploads/not-a-sha", headers=_AUTH)
    assert resp_bad.status_code == 404


# ---------------------------------------------------------------------------
# 4. GC sweep reclaims ref_count == 0 + ownerless orphan blobs.
# ---------------------------------------------------------------------------

def test_gc_orphan_blobs_reclaims_ownerless_unreferenced():
    client = _client()
    sha = _upload(client, b"soon to be an orphan")

    # Manually orphan it: drop ownership but leave the files row + blob (this is
    # exactly the lingering-orphan state F4 targets).
    with main.get_db() as conn:
        conn.execute("DELETE FROM file_owners WHERE file_id = ?", (sha,))
        conn.execute("UPDATE files SET uploaded_by = NULL WHERE id = ?", (sha,))
    assert _blob_exists(sha) is True
    assert _files_row(sha) is not None

    reclaimed = main._gc_orphan_blobs()
    assert reclaimed >= 1

    assert _blob_exists(sha) is False
    assert _files_row(sha) is None


def test_gc_leaves_referenced_blob_alone():
    client = _client()
    sha = _upload(client, b"referenced, must survive gc")
    main._increment_file_ref_counts([sha])
    # Drop ownership but keep ref_count > 0.
    with main.get_db() as conn:
        conn.execute("DELETE FROM file_owners WHERE file_id = ?", (sha,))
        conn.execute("UPDATE files SET uploaded_by = NULL WHERE id = ?", (sha,))

    main._gc_orphan_blobs()

    # ref_count > 0 -> GC must NOT reclaim it.
    assert _blob_exists(sha) is True
    assert _files_row(sha) is not None
