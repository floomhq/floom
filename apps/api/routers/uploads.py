"""User upload routes: store, signed download, owner-scoped delete + GC.

``POST /uploads`` (content-addressed blob store), ``GET /uploads/{file_id}``
(signed-token download), ``DELETE /uploads/{file_id}`` (drop ownership, GC the
blob when unreferenced). Extracted verbatim from main.py into an APIRouter.

The shared pipeline lives in ``services.uploads`` (never purged by fixtures and
resolves ``files``/``db`` lazily itself, so it is a real module-level import).
``AuthContext``/``get_auth_context`` appear in route signatures, so they are
real module-level imports; upload test fixtures purge ``routers.*`` alongside
``main``/``auth`` so this router rebuilds with fresh deps.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse

from auth import AuthContext, get_auth_context
from services.uploads import (
    _delete_blob_file,
    _store_uploaded_blob,
    _user_owns_uploaded_file,
    _verify_upload_download_token,
)

uploads_router = APIRouter()


@uploads_router.post("/uploads")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    max_size_mb: Optional[float] = Form(None),
    accepts: Optional[str] = Form(None),
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    return await _store_uploaded_blob(
        request,
        file,
        auth.user_id or "anonymous",
        max_size_mb=max_size_mb,
        accepts=accepts,
    )


@uploads_router.get("/uploads/{file_id}")
def download_upload(
    file_id: str,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> FileResponse:
    from db import get_db
    from files import blob_path, is_sha256, normalize_media_type

    if not is_sha256(file_id):
        raise HTTPException(status_code=404, detail="Uploaded file not found")

    download_token = request.query_params.get("download_token", "")
    token_user_id = _verify_upload_download_token(file_id, download_token)
    if auth.user_id != token_user_id:
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT filename, media_type
            FROM files
            WHERE id = ?
            """,
            (file_id,),
        ).fetchone()
        if row is not None and not _user_owns_uploaded_file(conn, file_id, auth.user_id):
            raise HTTPException(status_code=404, detail="Uploaded file not found")

    path = blob_path(file_id)
    if row is None or not path.exists():
        raise HTTPException(status_code=404, detail="Uploaded file not found")

    filename = row["filename"] or file_id
    media_type = normalize_media_type(row["media_type"])
    return FileResponse(
        path,
        filename=filename,
        media_type=media_type,
        headers={"Cache-Control": "no-store"},
    )


@uploads_router.delete("/uploads/{file_id}", status_code=204)
def delete_upload(
    file_id: str,
    auth: AuthContext = Depends(get_auth_context),
):
    """Owner-scoped delete of an uploaded blob.

    F4 (2026-06-03): uploaded blobs (approval screenshots, file inputs) with
    ``ref_count = 0`` previously lingered on disk forever — no cleanup route
    existed, so orphaned blobs accumulated. This route lets an owner release a
    blob and GCs it when it is truly unreferenced.

    Semantics (blobs are content-addressed + can be shared across owners and
    bound to runs):
      - The caller MUST own the file (file_owners row, or legacy uploaded_by).
      - The caller's ownership is dropped.
      - The physical blob + files row are deleted ONLY when no owners remain AND
        ``ref_count == 0`` (i.e. not bound to any run). If another owner holds it
        or a run still references it, the blob is kept; the caller simply no
        longer owns it.

    Returns 204 on success (idempotent for the caller's own ownership);
    404 if the caller does not own the file (no existence oracle for others'
    files — same 404 as a genuinely-missing file).
    """
    from db import get_db
    from files import is_sha256

    if not is_sha256(file_id):
        raise HTTPException(status_code=404, detail="Uploaded file not found")

    user_id = auth.user_id or "anonymous"
    with get_db() as conn:
        row = conn.execute(
            "SELECT ref_count FROM files WHERE id = ? LIMIT 1",
            (file_id,),
        ).fetchone()
        if row is None or not _user_owns_uploaded_file(conn, file_id, user_id):
            raise HTTPException(status_code=404, detail="Uploaded file not found")

        # Drop the caller's ownership (both the explicit row and any legacy
        # uploaded_by anchor that made them an owner).
        conn.execute(
            "DELETE FROM file_owners WHERE file_id = ? AND user_id = ?",
            (file_id, user_id),
        )
        conn.execute(
            "UPDATE files SET uploaded_by = NULL WHERE id = ? AND COALESCE(uploaded_by, 'anonymous') = ?",
            (file_id, user_id),
        )

        remaining_owners = conn.execute(
            "SELECT 1 FROM file_owners WHERE file_id = ? LIMIT 1",
            (file_id,),
        ).fetchone()
        ref_count = int(row["ref_count"] or 0)

        if remaining_owners is None and ref_count <= 0:
            # No owners + not bound to any run → safe to GC the blob + row.
            conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
            _delete_blob_file(file_id)

    return Response(status_code=204)
