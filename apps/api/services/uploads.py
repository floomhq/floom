"""Content-addressed upload storage: validation, quota, signed URLs, blob GC.

The shared `_store_uploaded_blob` pipeline (extension/media-type allowlists,
size + hourly-quota caps, sha256 content addressing, owner rows) is used by the
authed ``/uploads`` route and the approval-scoped screenshot uploads (authed
owner + signed-link public reviewer), so every path enforces the same rules.
Extracted verbatim from main.py.

``files`` and ``db`` are imported lazily inside the functions (the test suite
purges and re-imports them between cases). NOTE: ``_upload_quota_store`` is
module-level mutable state that main reloads used to reset — the root-suite
conftest now clears it per test (see _clear_router_caches there).
"""

from __future__ import annotations

import base64
import collections
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request, UploadFile

from core.utils import _positive_int_env

logger = logging.getLogger("floom.api")

_DEFAULT_UPLOAD_MAX_BYTES = 500 * 1024 * 1024
_DEFAULT_UPLOAD_HOURLY_CAP_BYTES = 1024 * 1024 * 1024
_UPLOAD_HOURLY_WINDOW_SECONDS = 3600.0
_UPLOAD_ALLOWED_MEDIA_TYPES = frozenset({
    "application/json",
    "application/pdf",
    "application/rtf",
    "application/sql",
    "application/toml",
    "application/typescript",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/x-yaml",
    "application/xml",
    "application/yaml",
    "application/zip",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-m4v",
    "text/css",
    "text/csv",
    "text/html",
    "text/markdown",
    "text/plain",
    "text/tab-separated-values",
    "text/x-python",
    "text/xml",
    "text/yaml",
})
# Text/code/data/doc/image formats a worker can read as context or a user can
# attach. Mirrors what Mac/GitHub treat as ordinary repo files. True
# executables / scripts stay in the blocklist below.
_UPLOAD_ALLOWED_EXTENSIONS = frozenset({
    ".c", ".cpp", ".cc", ".h", ".hpp",
    ".csv", ".tsv",
    ".css", ".scss",
    ".docx", ".pptx", ".xlsx", ".rtf", ".odt",
    ".gif", ".jpeg", ".jpg", ".png", ".webp",
    ".m4v", ".mov", ".mp4", ".webm",
    ".go", ".rs", ".rb", ".java", ".kt", ".swift",
    ".htm", ".html", ".xml",
    ".ini", ".toml", ".env", ".conf", ".cfg",
    ".ipynb",
    ".json", ".jsonl", ".ndjson",
    ".log",
    ".md", ".markdown", ".mdx", ".rst",
    ".pdf",
    ".py",
    ".sql",
    ".ts", ".tsx", ".jsx",
    ".txt", ".text",
    ".yaml", ".yml",
    ".zip",
})
# Declared media types we reject outright (defense-in-depth), even when the
# file extension is benign — these signal an executable/script payload.
_UPLOAD_DANGEROUS_MEDIA_TYPES = frozenset({
    "application/javascript",
    "image/svg+xml",
    "image/svg",
    "application/x-dosexec",
    "application/x-executable",
    "application/x-msdownload",
    "application/x-msdos-program",
    "application/x-sh",
    "application/x-shellscript",
    "application/vnd.microsoft.portable-executable",
    "text/javascript",
})
# Active/executable formats: blocked regardless of the allowlist (a blocked
# extension always wins, see _validate_upload_filename).
_UPLOAD_BLOCKED_EXTENSIONS = frozenset({
    ".bat",
    ".svg",
    ".cmd",
    ".com",
    ".dll",
    ".exe",
    ".js",
    ".mjs",
    ".php",
    ".ps1",
    ".scr",
    ".sh",
})
_upload_quota_lock = threading.Lock()
_upload_quota_store: Dict[str, collections.deque] = {}


def _upload_max_bytes() -> int:
    return _positive_int_env("WORKEROS_UPLOAD_MAX_BYTES", _DEFAULT_UPLOAD_MAX_BYTES)


def _upload_hourly_cap_bytes() -> int:
    return _positive_int_env("WORKEROS_UPLOAD_HOURLY_CAP_BYTES", _DEFAULT_UPLOAD_HOURLY_CAP_BYTES)


def _format_bytes(value: int) -> str:
    if value % (1024 * 1024) == 0:
        return f"{value // (1024 * 1024)} MiB"
    return f"{value} bytes"


def _upload_quota_key(request: Request) -> str:
    secret = request.headers.get("x-floom-secret") or ""
    if not secret:
        return "anon"
    return "s:" + hashlib.sha256(secret.encode()).hexdigest()[:16]


def _claim_upload_quota(request: Request, size: int) -> Optional[int]:
    now = time.monotonic()
    cutoff = now - _UPLOAD_HOURLY_WINDOW_SECONDS
    cap = _upload_hourly_cap_bytes()
    key = _upload_quota_key(request)
    with _upload_quota_lock:
        dq = _upload_quota_store.setdefault(key, collections.deque())
        while dq and dq[0][0] <= cutoff:
            dq.popleft()
        used = sum(entry_size for _entry_ts, entry_size in dq)
        if used + size > cap:
            return cap
        dq.append((now, size))
        return None


def _validate_upload_filename(raw_filename: str) -> None:
    if not raw_filename:
        raise HTTPException(status_code=400, detail="filename is required")
    if (
        "%00" in raw_filename.lower()
        or any(ord(char) < 32 or ord(char) == 127 for char in raw_filename)
    ):
        raise HTTPException(
            status_code=400,
            detail="filename must not contain control characters",
        )
    if (
        "/" in raw_filename
        or "\\" in raw_filename
        or raw_filename.startswith(".")
        or ".." in raw_filename.split("/")
    ):
        raise HTTPException(
            status_code=400,
            detail="filename must not contain path separators, leading dots, or '..' segments",
        )
    suffixes = [suffix.lower() for suffix in Path(raw_filename).suffixes]
    for inner_suffix in suffixes[:-1]:
        if inner_suffix in _UPLOAD_BLOCKED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"Upload filename contains blocked inner extension {inner_suffix!r}",
            )
    suffix = Path(raw_filename).suffix.lower()
    if suffix in _UPLOAD_BLOCKED_EXTENSIONS or suffix not in _UPLOAD_ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Upload filename extension {suffix or '<none>'!r} is not allowed",
        )


def _upload_url_ttl_seconds() -> int:
    try:
        return max(60, int(os.environ.get("WORKEROS_UPLOAD_URL_TTL_SECONDS", "3600")))
    except ValueError:
        return 3600


def _upload_signing_key() -> bytes:
    key = (
        os.environ.get("WORKEROS_UPLOAD_URL_SIGNING_SECRET")
        or os.environ.get("FLOOM_SECRET")
    )
    if not key:
        raise HTTPException(
            status_code=503,
            detail="Upload download tokens require WORKEROS_UPLOAD_URL_SIGNING_SECRET or FLOOM_SECRET to be configured",
        )
    return key.encode("utf-8")


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _make_upload_download_token(file_id: str, uploaded_by: str) -> str:
    expires_at = int(time.time()) + _upload_url_ttl_seconds()
    payload = _b64url_encode(
        json.dumps(
            {"file_id": file_id, "uploaded_by": uploaded_by, "expires_at": expires_at},
            separators=(",", ":"),
        ).encode("utf-8")
    )
    signature = hmac.new(_upload_signing_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def _verify_upload_download_token(file_id: str, token: str) -> str:
    try:
        payload, signature = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Uploaded file not found") from exc

    expected = hmac.new(_upload_signing_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=404, detail="Uploaded file not found")

    try:
        claims = json.loads(_b64url_decode(payload).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Uploaded file not found") from exc

    if claims.get("file_id") != file_id:
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    expires_at = int(claims.get("expires_at") or 0)
    if expires_at < int(time.time()):
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    uploaded_by = str(claims.get("uploaded_by") or "")
    if not uploaded_by:
        raise HTTPException(status_code=404, detail="Uploaded file not found")
    return uploaded_by


def _user_owns_uploaded_file(conn: sqlite3.Connection, file_id: str, user_id: str) -> bool:
    owner_row = conn.execute(
        "SELECT 1 FROM file_owners WHERE file_id = ? AND user_id = ? LIMIT 1",
        (file_id, user_id),
    ).fetchone()
    if owner_row is not None:
        return True
    legacy_row = conn.execute(
        "SELECT 1 FROM files WHERE id = ? AND COALESCE(uploaded_by, 'anonymous') = ? LIMIT 1",
        (file_id, user_id),
    ).fetchone()
    return legacy_row is not None


def _parse_accepts(value: Optional[str]) -> set[str]:
    from files import normalize_media_type

    if not value:
        return set()
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return {normalize_media_type(str(item)) for item in parsed if str(item).strip()}
    except json.JSONDecodeError:
        pass
    return {normalize_media_type(part) for part in value.split(",") if part.strip()}


def _delete_blob_file(file_id: str) -> None:
    """Best-effort removal of a content-addressed blob from disk."""
    from files import blob_path

    try:
        path = blob_path(file_id)
    except ValueError:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        logger.warning("Failed to remove orphan blob %s: %s", file_id, exc)


async def _store_uploaded_blob(
    request: Request,
    file: UploadFile,
    uploaded_by: str,
    *,
    max_size_mb: Optional[float] = None,
    accepts: Optional[str] = None,
    allowed_media_prefixes: Optional[tuple[str, ...]] = None,
) -> Dict[str, Any]:
    """Validate + content-address one uploaded file under `uploaded_by`.

    Shared by the authed `/uploads` route and the approval-scoped upload routes
    (authed owner + signed-link public reviewer). The same extension allowlist,
    size/quota caps, and content-addressed dedup apply on every path, so the
    public no-auth reviewer cannot smuggle in an executable or oversized blob.
    `allowed_media_prefixes` further restricts the upload to e.g. image/* only.
    """
    from db import get_db, now_iso
    from files import ensure_blob_dir, normalize_media_type

    if max_size_mb is not None and max_size_mb <= 0:
        raise HTTPException(status_code=400, detail="max_size_mb must be greater than 0")

    raw_filename = file.filename or ""
    _validate_upload_filename(raw_filename)

    media_type = normalize_media_type(
        file.content_type or mimetypes.guess_type(raw_filename)[0]
    )
    suffix = Path(raw_filename).suffix.lower()
    if media_type in _UPLOAD_DANGEROUS_MEDIA_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not allowed",
        )
    media_type_ok = (
        media_type in _UPLOAD_ALLOWED_MEDIA_TYPES
        or suffix in _UPLOAD_ALLOWED_EXTENSIONS
        or media_type in {"application/octet-stream", ""}
        or media_type.startswith("text/")
    )
    if not media_type_ok:
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not allowed",
        )

    if allowed_media_prefixes is not None and not any(
        media_type.startswith(prefix) for prefix in allowed_media_prefixes
    ):
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not accepted here",
        )

    accepted = _parse_accepts(accepts)
    if accepted and media_type not in accepted:
        raise HTTPException(
            status_code=400,
            detail=f"Upload media type {media_type!r} is not accepted",
        )

    configured_max_bytes = _upload_max_bytes()
    if max_size_mb is not None:
        max_bytes = min(int(max_size_mb * 1024 * 1024), configured_max_bytes)
    else:
        max_bytes = configured_max_bytes

    hasher = hashlib.sha256()
    size = 0
    from files import BLOBS_DIR as _BLOBS_DIR
    _BLOBS_DIR.mkdir(parents=True, exist_ok=True)
    tmp_upload = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=_BLOBS_DIR,
            prefix=".upload.",
            suffix=".tmp",
            delete=False,
        ) as tmp_out:
            tmp_upload = Path(tmp_out.name)
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    tmp_out.flush()
                    raise HTTPException(
                        status_code=400,
                        detail=f"Uploaded file exceeds {_format_bytes(max_bytes)} limit",
                    )
                hasher.update(chunk)
                tmp_out.write(chunk)
    except HTTPException:
        if tmp_upload is not None:
            tmp_upload.unlink(missing_ok=True)
        raise

    exceeded_cap = _claim_upload_quota(request, size)
    if exceeded_cap is not None:
        if tmp_upload is not None:
            tmp_upload.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail=f"Upload hourly cap exceeded: {_format_bytes(exceeded_cap)} per hour",
        )

    sha256 = hasher.hexdigest()
    target = ensure_blob_dir(sha256)
    if not target.exists():
        final_tmp = target.parent / f".{sha256}.tmp.{os.getpid()}.{threading.get_ident()}"
        try:
            os.replace(tmp_upload, final_tmp)
            os.replace(final_tmp, target)
        finally:
            final_tmp.unlink(missing_ok=True)
            tmp_upload.unlink(missing_ok=True)
    else:
        tmp_upload.unlink(missing_ok=True)

    uploaded_at = now_iso()
    filename = file.filename or sha256
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO files
                (id, filename, media_type, size_bytes, uploaded_by, uploaded_at, ref_count)
            VALUES (?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
                filename=files.filename,
                media_type=files.media_type,
                size_bytes=files.size_bytes,
                uploaded_by=files.uploaded_by,
                uploaded_at=files.uploaded_at,
                ref_count=files.ref_count
            """,
            (sha256, filename, media_type, size, uploaded_by, uploaded_at),
        )
        conn.execute(
            """
            INSERT INTO file_owners (file_id, user_id, first_uploaded_at)
            VALUES (?, ?, ?)
            ON CONFLICT(file_id, user_id) DO NOTHING
            """,
            (sha256, uploaded_by, uploaded_at),
        )

    download_token = _make_upload_download_token(sha256, uploaded_by)
    upload_url = f"/uploads/{sha256}?download_token={download_token}"
    return {
        "id": sha256,
        "sha256": sha256,
        "size": size,
        "media_type": media_type,
        "url": upload_url,
    }
