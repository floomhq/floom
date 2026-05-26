"""Content-addressed upload helpers for worker file inputs."""

from __future__ import annotations

import mimetypes
import os
import re
from pathlib import Path
from typing import Optional


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BLOBS_DIR = Path(os.environ.get("FLOOM_BLOBS_DIR", PROJECT_ROOT / "data" / "blobs")).resolve()
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def normalize_media_type(value: Optional[str]) -> str:
    if not value:
        return "application/octet-stream"
    media_type = value.split(";", 1)[0].strip().lower()
    return media_type or "application/octet-stream"


def is_sha256(value: object) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def blob_path(sha256: str) -> Path:
    if not is_sha256(sha256):
        raise ValueError("file reference must be a sha256 hex digest")
    return BLOBS_DIR / sha256[:2] / sha256


def ensure_blob_dir(sha256: str) -> Path:
    target = blob_path(sha256)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def extension_for_file(filename: Optional[str], media_type: Optional[str]) -> str:
    media_type = normalize_media_type(media_type)
    known = {
        "application/json": ".json",
        "application/pdf": ".pdf",
        "application/zip": ".zip",
        "text/csv": ".csv",
        "text/markdown": ".md",
        "text/plain": ".txt",
    }
    if media_type in known:
        return known[media_type]

    guessed = mimetypes.guess_extension(media_type)
    if guessed:
        return guessed

    suffix = Path(filename or "").suffix.lower()
    if suffix and re.fullmatch(r"\.[a-z0-9]{1,12}", suffix):
        return suffix

    return ".bin"
