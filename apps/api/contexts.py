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
import hashlib
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Optional


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONTEXTS_DIR = Path(os.environ.get("FLOOM_CONTEXTS_DIR", str(PROJECT_ROOT / "contexts"))).resolve()
CONTEXT_METADATA_PATH = CONTEXTS_DIR / ".workeros-contexts.json"
MAX_CONTEXT_BYTES = 50 * 1024 * 1024


# --- Multi-tenant scoping (cloud mode) ---------------------------------------
#
# In single-tenant local/OSS mode every context lives directly under
# CONTEXTS_DIR (e.g. /var/contexts/<name>). In multi-tenant cloud mode the
# same FS root is shared across workspaces; without scoping every authed
# user sees every other tenant's contexts (P0 cross-tenant leak).
#
# The downstream host registers a resolver callable via
# ``set_context_scope_resolver()`` that returns the active workspace_id for
# the current request. When set + returning a non-empty safe string, every
# context path becomes ``CONTEXTS_DIR/<workspace_id>/<name>/...`` and the
# per-scope metadata file lives at
# ``CONTEXTS_DIR/<workspace_id>/.workeros-contexts.json``.
#
# When the resolver is unset or returns None (OSS local mode, scheduler /
# background tasks, tests), paths fall back to the legacy unscoped layout
# so existing single-tenant installs see no behavior change.

_CONTEXT_SCOPE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_scope_resolver: Optional[Callable[[], Optional[str]]] = None
_SCOPE_OVERRIDE_UNSET = object()
_scope_override: ContextVar[object | str | None] = ContextVar(
    "workeros_context_scope_override",
    default=_SCOPE_OVERRIDE_UNSET,
)
_CONTEXT_METADATA_SAVE_LOCK = threading.Lock()

# --- Context hydration hook (cloud Storage lazy-fetch) ----------------------
#
# In OSS single-tenant mode this hook is never set and context_dir() behaves
# exactly as before — a pure filesystem path resolver with no side effects.
#
# In cloud mode, startup.py registers a callable via set_context_hydration_hook
# so that context_dir() transparently pulls the context from Supabase Storage
# when the directory is absent on a fresh ephemeral container (Railway).
#
# Signature: hydrate_hook(scope: str | None, name: str, dest_dir: Path) -> None
# The hook MUST be idempotent and MUST NOT raise (errors are logged internally).
_hydration_hook: Optional[Callable[[Optional[str], str, "Path"], None]] = None


def set_context_hydration_hook(
    hook: Optional[Callable[[Optional[str], str, "Path"], None]],
) -> None:
    """Register (or clear) a callable that lazily hydrates a context directory.

    Called by the cloud startup to plug in Supabase Storage hydration.
    Pass ``None`` to clear (OSS/test mode).

    ``hook(scope, name, dest_dir)`` is called from ``context_dir()`` when the
    target directory does not yet exist or is empty. ``scope`` is the active
    workspace_id (may be ``None`` for unscoped deployments).
    The hook MUST be idempotent and must not raise — failures are swallowed
    so the OSS local-disk path is always the final fallback.
    """
    global _hydration_hook
    _hydration_hook = hook


def set_context_scope_resolver(resolver: Optional[Callable[[], Optional[str]]]) -> None:
    """Register a callable returning the active scope id (workspace_id) for
    the current request. Pass ``None`` to clear the resolver (OSS mode).

    The resolver MUST return either a safe scope id matching
    ``_CONTEXT_SCOPE_NAME_RE`` or ``None``. Invalid scope ids cause the
    request to fall back to the unscoped root (defensive: no traversal
    risk).
    """
    global _scope_resolver
    _scope_resolver = resolver


def context_scope_for_user(user_id: str | None) -> str | None:
    deploy_mode = (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower()
    scoped_local = os.environ.get("WORKEROS_ENABLE_USER_HEADER_SCOPE") == "1"
    raw = str(user_id or "").strip()
    is_local_workspace = bool(re.search(r"__ws_[a-f0-9]{14}$", raw))
    if deploy_mode != "cloud" and not scoped_local and not is_local_workspace:
        return None
    if not raw:
        return None
    raw = effective_context_user_id(raw)
    if _CONTEXT_SCOPE_NAME_RE.fullmatch(raw):
        return raw
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f"user-{digest}"


def _bootstrap_context_user_id() -> str:
    configured = (os.environ.get("WORKEROS_USER_ID") or "").strip()
    return configured or "federico"


def _scope_has_context_dirs(scope: str) -> bool:
    if not _CONTEXT_SCOPE_NAME_RE.fullmatch(scope):
        return False
    root = CONTEXTS_DIR / scope
    if not root.is_dir():
        return False
    try:
        return any(
            child.is_dir() and not child.is_symlink() and not child.name.startswith(".")
            for child in root.iterdir()
        )
    except OSError:
        return False


def _can_use_bootstrap_context_scope(user_id: str, bootstrap_id: str) -> bool:
    """True when a real local admin owns the bootstrap/default context scope.

    Multi-member setup can create a UUID admin while pre-existing Brain packs
    remain under the bootstrap user scope (usually ``federico``). This check is
    intentionally narrow: it never applies in cloud mode, never applies to
    non-default derived workspace IDs, and requires either a single configured
    account or an active owner row for ``local-default``.
    """
    deploy_mode = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy_mode != "local":
        return False
    if os.environ.get("WORKEROS_ENABLE_USER_HEADER_SCOPE") != "1":
        return False
    if not user_id or user_id == bootstrap_id:
        return False
    if re.search(r"__ws_[a-f0-9]{14}$", user_id):
        return False
    if _scope_has_context_dirs(user_id):
        return False
    if not _scope_has_context_dirs(bootstrap_id):
        return False
    try:
        from db import get_db

        with get_db() as conn:
            user = conn.execute(
                "SELECT 1 FROM users WHERE id = ? AND disabled = 0 LIMIT 1",
                (user_id,),
            ).fetchone()
            if user is None:
                return False
            bootstrap_user = conn.execute(
                "SELECT 1 FROM users WHERE id = ? AND disabled = 0 LIMIT 1",
                (bootstrap_id,),
            ).fetchone()
            if bootstrap_user is not None:
                return False
            owner = conn.execute(
                """
                SELECT 1 FROM workspace_members
                WHERE workspace_id = 'local-default'
                  AND user_id = ?
                  AND role = 'owner'
                  AND status = 'active'
                LIMIT 1
                """,
                (user_id,),
            ).fetchone()
            if owner is not None:
                return True
            count = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()
            return int(count["count"] if count is not None else 0) == 1
    except Exception:
        return False


def effective_context_user_id(user_id: str | None) -> str:
    raw = str(user_id or "").strip()
    if not raw:
        return raw
    bootstrap_id = _bootstrap_context_user_id()
    if _can_use_bootstrap_context_scope(raw, bootstrap_id):
        return bootstrap_id
    return raw


@contextmanager
def use_context_scope(scope: str | None):
    safe_scope = None
    if scope is not None:
        raw = str(scope).strip()
        if raw and _CONTEXT_SCOPE_NAME_RE.fullmatch(raw):
            safe_scope = raw
    token = _scope_override.set(safe_scope)
    try:
        yield safe_scope
    finally:
        _scope_override.reset(token)


def _current_scope() -> Optional[str]:
    override = _scope_override.get()
    if override is not _SCOPE_OVERRIDE_UNSET:
        return override if isinstance(override, str) and override else None
    if _scope_resolver is None:
        return None
    try:
        raw = _scope_resolver()
    except Exception:
        return None
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or not _CONTEXT_SCOPE_NAME_RE.fullmatch(text):
        return None
    return text


def current_contexts_root() -> Path:
    """Return the active CONTEXTS_DIR root for the current request.

    Scoped to a per-workspace subdir in cloud mode; equal to CONTEXTS_DIR
    otherwise. The returned path may not exist yet (callers should
    ``mkdir(parents=True, exist_ok=True)`` before iterating).
    """
    scope = _current_scope()
    if scope is None:
        return CONTEXTS_DIR
    return (CONTEXTS_DIR / scope).resolve()


def current_metadata_path() -> Path:
    """Return the active metadata file path for the current request."""
    return current_contexts_root() / ".workeros-contexts.json"

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
    root = current_contexts_root()
    target = (root / safe_name).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"Path traversal attempt: {target}") from exc
    # Cloud lazy-hydration: if the directory is absent or empty and a hydration
    # hook is registered (cloud startup sets one), fetch the context pack from
    # Supabase Storage before returning the path.  This is a no-op in OSS /
    # single-tenant mode (_hydration_hook is None) and a no-op whenever the
    # directory is already populated (idempotency guard is inside the hook).
    hook = _hydration_hook
    if hook is not None and (not target.exists() or not any(target.iterdir())):
        try:
            hook(_current_scope(), safe_name, target)
        except Exception:
            pass  # hydration failures must never block a run
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
    # #1052 — reject percent-encoded path separators (%2f, %5c) so this validator
    # and the worker-file validator agree; they were previously accepted as
    # literal filenames.
    lowered = (raw_path or "").lower()
    if "%2f" in lowered or "%5c" in lowered:
        raise ValueError(f"invalid context file path: {raw_path!r}")
    # #1077 — reject NUL and other ASCII control characters. A %00 in the URL
    # decodes to a literal null byte that later reached Path.is_file()/lstat and
    # raised an uncaught "embedded null character in path" (raw OS error -> 500).
    # Reject it here so every context-file route returns a clean 400 instead.
    if any(ord(ch) < 0x20 for ch in (raw_path or "")):
        raise ValueError(f"invalid context file path: {raw_path!r}")
    text = (raw_path or "").replace("\\", "/").strip("/")
    path = PurePosixPath(text)
    if not text or str(path) == ".":
        raise ValueError("file path is required")
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"invalid context file path: {raw_path!r}")
    return path.as_posix()


def ensure_contexts_dir() -> None:
    current_contexts_root().mkdir(parents=True, exist_ok=True)


def load_context_metadata() -> dict[str, dict[str, Any]]:
    metadata_path = current_metadata_path()
    if not metadata_path.is_file():
        return {}
    try:
        parsed = json.loads(metadata_path.read_text())
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
    metadata_path = current_metadata_path()
    tmp_path = metadata_path.with_name(
        f".{metadata_path.name}.tmp.{os.getpid()}.{threading.get_ident()}"
    )
    with _CONTEXT_METADATA_SAVE_LOCK:
        tmp_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
        os.replace(tmp_path, metadata_path)


def context_owner_id(name: str, metadata: dict[str, dict[str, Any]] | None = None) -> str | None:
    safe_name = validate_context_name(name)
    meta = metadata if metadata is not None else load_context_metadata()
    entry = meta.get(safe_name) or {}
    owner_id = str(entry.get("owner_id") or "").strip()
    return owner_id or None


def set_context_metadata(
    name: str,
    *,
    writeable: bool | None = None,
    owner_id: str | None = None,
    sensitive: bool | None = None,
    category: str | None = None,
) -> None:
    safe_name = validate_context_name(name)
    metadata = load_context_metadata()
    existing = metadata.get(safe_name, {})
    if writeable is not None:
        existing["writeable"] = bool(writeable)
    if owner_id is not None:
        owner_value = str(owner_id).strip()
        if owner_value:
            existing["owner_id"] = owner_value
    if sensitive is not None:
        existing["sensitive"] = bool(sensitive)
    if category is not None:
        # #780: content-category tag (e.g. marketing/accounting/research/data);
        # empty string clears it.
        cat = str(category).strip()
        if cat:
            existing["category"] = cat
        else:
            existing.pop("category", None)
    existing["updated_at"] = now_iso()
    metadata[safe_name] = existing
    save_context_metadata(metadata)


def get_context_category(name: str) -> str | None:
    """#780: read a context pack's content-category tag, or None."""
    try:
        safe_name = validate_context_name(name)
        return load_context_metadata().get(safe_name, {}).get("category") or None
    except Exception:
        return None


def is_context_sensitive(name: str) -> bool:
    """Return True if this context should be excluded from git.

    Sensitive is the DEFAULT — contexts are only git-tracked when explicitly
    marked non-sensitive (sensitive=False) by the user.
    """
    try:
        safe_name = validate_context_name(name)
        entry = load_context_metadata().get(safe_name, {})
        # If the key is absent the context has never been explicitly opted in,
        # so treat it as sensitive (never committed to git).
        return bool(entry.get("sensitive", True))
    except Exception:
        return True


def set_context_file_metadata(
    name: str,
    file_path: str,
    *,
    tags: list[str] | None = None,
    file_metadata: dict[str, Any] | None = None,
    owner_id: str | None = None,
) -> dict[str, Any]:
    safe_name = validate_context_name(name)
    rel = normalize_context_file_path(file_path)
    metadata = load_context_metadata()
    pack = metadata.get(safe_name, {})
    if owner_id is not None:
        owner_value = str(owner_id).strip()
        if owner_value:
            pack["owner_id"] = owner_value
    files = pack.get("files")
    if not isinstance(files, dict):
        files = {}
    file_entry = files.get(rel)
    if not isinstance(file_entry, dict):
        file_entry = {}
    if tags is not None:
        clean_tags = []
        for tag in tags:
            clean = str(tag).strip()
            if clean and clean not in clean_tags:
                clean_tags.append(clean[:64])
            if len(clean_tags) >= 20:
                break
        if clean_tags:
            file_entry["tags"] = clean_tags
        else:
            file_entry.pop("tags", None)
    if file_metadata is not None:
        clean_metadata: dict[str, Any] = {}
        for raw_key, raw_value in file_metadata.items():
            key = str(raw_key).strip()
            if not key:
                continue
            if isinstance(raw_value, (str, int, float, bool)) or raw_value is None:
                clean_metadata[key[:64]] = raw_value
        if clean_metadata:
            file_entry["metadata"] = clean_metadata
        else:
            file_entry.pop("metadata", None)
    if file_entry:
        files[rel] = file_entry
    else:
        files.pop(rel, None)
    if files:
        pack["files"] = files
    else:
        pack.pop("files", None)
    pack["updated_at"] = now_iso()
    metadata[safe_name] = pack
    save_context_metadata(metadata)
    return pack


def set_context_file_secret_flag(name: str, file_path: str, has_secret_warning: bool) -> None:
    """Persist (or clear) the ``has_secret_warning`` flag on a context file's
    metadata entry, without disturbing its tags/metadata. Used by the
    write-boundary secret scanner so the UI can badge flagged files.
    """
    safe_name = validate_context_name(name)
    rel = normalize_context_file_path(file_path)
    metadata = load_context_metadata()
    pack = metadata.get(safe_name, {})
    files = pack.get("files")
    if not isinstance(files, dict):
        files = {}
    file_entry = files.get(rel)
    if not isinstance(file_entry, dict):
        file_entry = {}
    if has_secret_warning:
        file_entry["has_secret_warning"] = True
    else:
        file_entry.pop("has_secret_warning", None)
    if file_entry:
        files[rel] = file_entry
    else:
        files.pop(rel, None)
    if files:
        pack["files"] = files
    else:
        pack.pop("files", None)
    pack["updated_at"] = now_iso()
    metadata[safe_name] = pack
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


# Extensions/MIME types that a browser will execute (script, markup) if served
# inline. These are "text" (so not binary) but must NOT be rendered in the
# browser's origin — otherwise an uploaded .html context file is stored XSS.
# Served as attachment (force download) so the script never runs in-origin.
_ACTIVE_MARKUP_EXTENSIONS = {
    ".html",
    ".htm",
    ".xhtml",
    ".svg",
    ".xml",
    ".xsl",
    ".xslt",
    ".mathml",
}
_ACTIVE_MARKUP_MIME_TYPES = {
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/xml",
    "text/xml",
}


def is_active_markup(path: str, mime_type: str) -> bool:
    """Return True for non-binary content a browser would execute inline.

    Such files (html, svg, xhtml, xml) must be force-downloaded, never
    rendered inline, to avoid stored-XSS from uploaded context files.
    """
    if PurePosixPath(path).suffix.lower() in _ACTIVE_MARKUP_EXTENSIONS:
        return True
    return (mime_type or "").split(";", 1)[0].strip().lower() in _ACTIVE_MARKUP_MIME_TYPES


def iter_context_files(root: Path) -> Iterable[Path]:
    if not root.is_dir():
        return []
    return (
        path
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink()
    )


_EXT_DISPLAY_TYPE: dict[str, str] = {
    ".md": "Markdown",
    ".mdx": "Markdown",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".py": "Python",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".json": "JSON",
    ".sh": "Shell",
    ".bash": "Shell",
    ".zsh": "Shell",
    ".sql": "SQL",
    ".csv": "CSV",
    ".txt": "Text",
    ".toml": "TOML",
    ".xml": "XML",
    ".html": "HTML",
    ".htm": "HTML",
    ".css": "CSS",
    ".scss": "CSS",
}
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp"}


def context_file_display_type(path_str: str, mime_type: str) -> str:
    ext = PurePosixPath(path_str).suffix.lower()
    if ext in _IMAGE_EXTS or mime_type.startswith("image/"):
        return "Image"
    if ext in _EXT_DISPLAY_TYPE:
        return _EXT_DISPLAY_TYPE[ext]
    if mime_type.startswith("text/"):
        return "Text"
    return "File"


def context_file_metadata(root: Path, path: Path, pack_metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    rel = path.relative_to(root).as_posix()
    stat = path.stat()
    mime_type = guess_mime_type(rel)
    result = {
        "path": rel,
        "size": stat.st_size,
        "mime_type": mime_type,
        "updated_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "is_binary": is_binary_file(rel, mime_type),
        "display_type": context_file_display_type(rel, mime_type),
    }
    files = (pack_metadata or {}).get("files")
    file_entry = files.get(rel) if isinstance(files, dict) else None
    if isinstance(file_entry, dict):
        if file_entry.get("has_secret_warning"):
            result["has_secret_warning"] = True
        tags = file_entry.get("tags")
        if isinstance(tags, list):
            result["tags"] = [str(tag) for tag in tags if str(tag).strip()]
        extra_metadata = file_entry.get("metadata")
        if isinstance(extra_metadata, dict):
            result["metadata"] = {
                str(key): value
                for key, value in extra_metadata.items()
                if isinstance(value, (str, int, float, bool)) or value is None
            }
    return result


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
