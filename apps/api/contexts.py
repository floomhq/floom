"""Filesystem-backed worker contexts.

Contexts are named directories under ``CONTEXTS_DIR``. The directory contents
are customer-managed knowledge and state files, so helpers here are deliberately
path-safe and binary-safe.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONTEXTS_DIR = Path(os.environ.get("FLOOM_CONTEXTS_DIR", str(PROJECT_ROOT / "contexts"))).resolve()
CONTEXT_METADATA_PATH = CONTEXTS_DIR / ".workeros-contexts.json"
MAX_CONTEXT_BYTES = 50 * 1024 * 1024

CONTEXT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TEXT_FILE_EXTENSIONS = {
    ".c",
    ".conf",
    ".cpp",
    ".cs",
    ".css",
    ".csv",
    ".env",
    ".go",
    ".h",
    ".hpp",
    ".htm",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".kt",
    ".kts",
    ".log",
    ".md",
    ".mdx",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsv",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
TEXT_FILE_NAMES = {
    ".env",
    ".gitignore",
    "dockerfile",
    "makefile",
}
TEXT_MIME_TYPES = {
    "application/javascript",
    "application/json",
    "application/toml",
    "application/typescript",
    "application/yaml",
    "application/x-yaml",
    "application/xml",
}


def validate_context_name(name: str) -> str:
    stripped = (name or "").strip()
    if not CONTEXT_NAME_RE.fullmatch(stripped):
        raise ValueError("context name must be 1-64 letters, digits, dots, underscores, or hyphens")
    return stripped


def context_dir(name: str) -> Path:
    safe_name = validate_context_name(name)
    target = (CONTEXTS_DIR / safe_name).resolve()
    try:
        target.relative_to(CONTEXTS_DIR)
    except ValueError as exc:
        raise ValueError(f"Path traversal attempt: {target}") from exc
    return target


def safe_context_file_path(name: str, raw_path: str) -> Path:
    rel = normalize_context_file_path(raw_path)
    target = (context_dir(name) / rel).resolve()
    try:
        target.relative_to(context_dir(name))
    except ValueError as exc:
        raise ValueError(f"Path traversal attempt: {target}") from exc
    return target


def normalize_context_file_path(raw_path: str) -> str:
    text = (raw_path or "").replace("\\", "/").strip("/")
    path = PurePosixPath(text)
    if not text or str(path) == ".":
        raise ValueError("file path is required")
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"invalid context file path: {raw_path!r}")
    return path.as_posix()


def ensure_contexts_dir() -> None:
    CONTEXTS_DIR.mkdir(parents=True, exist_ok=True)


def load_context_metadata() -> dict[str, dict[str, Any]]:
    if not CONTEXT_METADATA_PATH.is_file():
        return {}
    try:
        parsed = json.loads(CONTEXT_METADATA_PATH.read_text())
    except Exception:
        return {}
    if not isinstance(parsed, dict):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for key, value in parsed.items():
        if isinstance(key, str) and isinstance(value, dict):
            result[key] = dict(value)
    return result


def save_context_metadata(metadata: dict[str, dict[str, Any]]) -> None:
    ensure_contexts_dir()
    tmp_path = CONTEXT_METADATA_PATH.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    os.replace(tmp_path, CONTEXT_METADATA_PATH)


def set_context_metadata(name: str, *, writeable: bool | None = None) -> None:
    safe_name = validate_context_name(name)
    metadata = load_context_metadata()
    existing = metadata.get(safe_name, {})
    if writeable is not None:
        existing["writeable"] = bool(writeable)
    existing["updated_at"] = now_iso()
    metadata[safe_name] = existing
    save_context_metadata(metadata)


def delete_context_metadata(name: str) -> None:
    safe_name = validate_context_name(name)
    metadata = load_context_metadata()
    if safe_name in metadata:
        metadata.pop(safe_name, None)
        save_context_metadata(metadata)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def guess_mime_type(path: str) -> str:
    return mimetypes.guess_type(path)[0] or "application/octet-stream"


def is_binary_mime(mime_type: str) -> bool:
    normalized = (mime_type or "").split(";", 1)[0].lower()
    return not (normalized.startswith("text/") or normalized in TEXT_MIME_TYPES)


def is_text_path(path: str) -> bool:
    pure = PurePosixPath(path)
    name = pure.name.lower()
    return pure.suffix.lower() in TEXT_FILE_EXTENSIONS or name in TEXT_FILE_NAMES


def is_binary_file(path: str, mime_type: str) -> bool:
    if is_text_path(path):
        return False
    return is_binary_mime(mime_type)


def iter_context_files(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return []
    return (
        path
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink()
    )


def context_file_metadata(root: Path, path: Path) -> dict[str, Any]:
    rel = path.relative_to(root).as_posix()
    stat = path.stat()
    mime_type = guess_mime_type(rel)
    return {
        "path": rel,
        "size": stat.st_size,
        "mime_type": mime_type,
        "updated_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "is_binary": is_binary_file(rel, mime_type),
    }


def context_total_size(root: Path) -> int:
    return sum(path.stat().st_size for path in iter_context_files(root))


def context_updated_at(root: Path) -> str | None:
    latest = None
    for path in iter_context_files(root):
        mtime = path.stat().st_mtime
        latest = mtime if latest is None else max(latest, mtime)
    if latest is None and root.exists():
        latest = root.stat().st_mtime
    if latest is None:
        return None
    return datetime.fromtimestamp(latest, timezone.utc).isoformat()


def normalize_context_mount(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        return {"name": validate_context_name(raw), "writeable": False, "source": "local"}
    if isinstance(raw, dict):
        name = validate_context_name(str(raw.get("name") or ""))
        source = str(raw.get("source") or "local").strip()
        if source != "local" and not source.startswith("git+"):
            raise ValueError("context source must be 'local' or start with 'git+'")
        return {
            "name": name,
            "writeable": bool(raw.get("writeable", raw.get("writable", False))),
            "source": source,
        }
    if hasattr(raw, "model_dump"):
        return normalize_context_mount(raw.model_dump())
    raise ValueError("context must be a name string or object")


def context_mount_names(contexts: Iterable[Any]) -> list[str]:
    names: list[str] = []
    for item in contexts or []:
        try:
            names.append(normalize_context_mount(item)["name"])
        except ValueError:
            continue
    return names
