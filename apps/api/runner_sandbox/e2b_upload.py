"""Bulk file upload helpers for E2B sandboxes."""

from __future__ import annotations

import io
import logging
import tarfile
import time
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger("floom.runner_sandbox.upload")

_UPLOAD_ARCHIVE_NAME = ".workeros-upload.tar.gz"


def _safe_tar_name(rel: Path) -> str:
    name = rel.as_posix()
    if not name or name == "." or name.startswith("/") or ".." in rel.parts:
        raise ValueError(f"unsafe archive member path: {name!r}")
    return name


def _tree_tarball(
    local_root: Path,
    *,
    skip: Callable[[Path, Path], bool] | None = None,
    log_fn: Callable[[str, str], None] | None = None,
) -> tuple[bytes, int, int]:
    files = 0
    dirs = 0
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w:gz") as tf:
        for path in sorted(local_root.rglob("*")):
            rel = path.relative_to(local_root)
            if path.is_symlink():
                if log_fn:
                    log_fn(f"[e2b] Skipping symlink during archive upload: {rel.as_posix()}", "warning")
                continue
            if skip and skip(path, rel):
                continue
            name = _safe_tar_name(rel)
            if path.is_dir():
                info = tarfile.TarInfo(name.rstrip("/") + "/")
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tf.addfile(info)
                dirs += 1
            elif path.is_file():
                data = path.read_bytes()
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                tf.addfile(info, io.BytesIO(data))
                files += 1
    return out.getvalue(), files, dirs


def upload_tree_tarball(
    sandbox: Any,
    local_root: Path,
    remote_root: str,
    *,
    skip: Callable[[Path, Path], bool] | None = None,
    log_fn: Callable[[str, str], None] | None = None,
    label: str = "tree",
) -> tuple[int, int]:
    """Upload a local tree with one E2B file write plus in-sandbox extraction.

    E2B file writes are remote API calls. For workers with many bundled files,
    serial writes dominate startup time. This helper preserves the existing
    symlink-skip behavior while reducing the upload to a single archive write.
    """
    if not local_root.exists():
        return (0, 0)
    if not local_root.is_dir():
        raise ValueError(f"local upload root is not a directory: {local_root}")

    started = time.monotonic()
    sandbox.files.make_dir(remote_root)
    make_dir_ms = (time.monotonic() - started) * 1000.0

    tar_started = time.monotonic()
    raw, file_count, dir_count = _tree_tarball(local_root, skip=skip, log_fn=log_fn)
    tar_ms = (time.monotonic() - tar_started) * 1000.0
    if file_count == 0 and dir_count == 0:
        return (0, 0)

    archive_path = f"{remote_root.rstrip('/')}/{_UPLOAD_ARCHIVE_NAME}"
    write_started = time.monotonic()
    sandbox.files.write(archive_path, raw)
    write_ms = (time.monotonic() - write_started) * 1000.0
    extract_started = time.monotonic()
    result = sandbox.commands.run(
        f"tar -xzf {_UPLOAD_ARCHIVE_NAME} --no-same-owner --no-same-permissions && rm -f {_UPLOAD_ARCHIVE_NAME}",
        cwd=remote_root,
        timeout=120,
        request_timeout=180,
    )
    extract_ms = (time.monotonic() - extract_started) * 1000.0
    if getattr(result, "exit_code", 1) != 0:
        stderr = (getattr(result, "stderr", "") or getattr(result, "stdout", "") or "")[:500]
        raise RuntimeError(f"failed to extract {label} archive in sandbox: {stderr}")
    if log_fn:
        log_fn(
            "[e2b] Uploaded "
            f"{label} archive ({file_count} files, {dir_count} dirs, {len(raw)} bytes; "
            f"make_dir={make_dir_ms:.1f}ms, tar={tar_ms:.1f}ms, "
            f"write={write_ms:.1f}ms, extract={extract_ms:.1f}ms)",
            "debug",
        )
    return (file_count, dir_count)
