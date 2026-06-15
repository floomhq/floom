"""Git workspace resolution and commit-identity helpers.

Extracted from main.py. These are pure resolution helpers used across the
worker, context, and workspace route groups. They depend only on leaf modules
(``git_ops`` for the active-workspace resolver, ``worker_registry`` for the
workers directory), never on ``main``.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:
    from auth import AuthContext

logger = logging.getLogger("floom.api")


# #1001: a host (workeros-cloud) maintains its per-workspace git repos in its
# own materialized tree (var/workspaces/{id}), NOT WORKERS_DIR/{id}. It registers
# a resolver here so EVERY engine git op — versions read AND rollback — runs in
# the same real tree (mirrors run_token.set_worker_call_secret_resolver). Pass
# None to clear (OSS mode). Receives the active workspace_id (or None).
_git_workspace_resolver: "Optional[Callable[[Optional[str]], Optional[Path | str]]]" = None
_workspace_git_bundle_restore_resolver: "Optional[Callable[[Optional[str], Path], bool | None]]" = None


def set_git_workspace_resolver(resolver: "Optional[Callable[[Optional[str]], Optional[Path | str]]]") -> None:
    global _git_workspace_resolver
    _git_workspace_resolver = resolver


def set_workspace_git_bundle_restore_resolver(
    resolver: "Optional[Callable[[Optional[str], Path], bool | None]]",
) -> None:
    """Register a host restore hook for ephemeral per-workspace git repos.

    Cloud registers a resolver that restores ``repo.bundle`` from Supabase
    Storage before an export push when the materialized workspace repo is absent.
    OSS keeps this unset and falls back to local git initialization.
    """
    global _workspace_git_bundle_restore_resolver
    _workspace_git_bundle_restore_resolver = resolver


def _git_workspace() -> Path:
    """Return the git workspace root for the current request.

    OSS (single-tenant): WORKEROS_WORKSPACE_DIR env var, or WORKERS_DIR.parent.
    Cloud (multi-tenant): a host-registered resolver (#1001) returns the real
    materialized per-workspace git root; else WORKERS_DIR / {workspace_id}.

    git_ops and worker_registry are resolved lazily: the test suite pops and
    re-imports worker_registry (with a temp WORKERS_DIR) between cases, so binding
    WORKERS_DIR at module load would pin this helper to a stale directory.
    """
    import git_ops as _git_ops
    from worker_registry import WORKERS_DIR

    custom = os.environ.get("WORKEROS_WORKSPACE_DIR", "").strip()
    if custom:
        return Path(custom).resolve()
    workspace_id = _git_ops.get_active_workspace_id()
    # #1001: host resolver wins — points read AND rollback at one consistent tree.
    if _git_workspace_resolver is not None:
        try:
            resolved = _git_workspace_resolver(workspace_id)
        except Exception:
            logger.warning("git workspace resolver failed for %s", workspace_id, exc_info=True)
            resolved = None
        if resolved:
            return Path(resolved).resolve()
    if workspace_id:
        # Cloud default (no resolver): each workspace has its own git repo.
        return (WORKERS_DIR / workspace_id).resolve()
    # OSS: single workspace at WORKERS_DIR.parent
    return WORKERS_DIR.parent.resolve()


def _restore_workspace_git_bundle_if_missing(workspace: Path) -> bool:
    """Restore the active workspace git repo via the host hook when .git is gone.

    Returns True when the hook reports a restore. The hook is intentionally
    dependency-free here; workeros-cloud owns the Supabase Storage implementation
    and registers it at startup.
    """
    if (workspace / ".git").exists():
        return False
    if _workspace_git_bundle_restore_resolver is None:
        return False
    import git_ops as _git_ops

    workspace_id = _git_ops.get_active_workspace_id()
    restored = bool(_workspace_git_bundle_restore_resolver(workspace_id, workspace))
    if restored and not (workspace / ".git").exists():
        raise RuntimeError("Workspace git bundle restore completed without a .git directory")
    return restored


def _git_author(auth: "AuthContext") -> tuple[str, str]:
    """Return (author_name, author_email) suitable for a git commit."""
    name = getattr(auth, "username", None) or getattr(auth, "user_id", None) or "WorkerOS"
    email = getattr(auth, "email", None) or f"{name}@workeros.local"
    return name, email


import threading

_git_ops_lock = threading.Lock()

_WORKSPACE_TOOLS_FILENAME = "workspace-tools.yml"


def _ensure_git_workspace_ready(workspace: Path) -> None:
    """Initialize the git workspace before path-level commit helpers run."""
    import git_ops as _git_ops

    remote = os.environ.get("WORKEROS_GIT_REMOTE", "").strip()
    if remote and not (workspace / ".git").exists():
        _git_ops.clone_or_init(workspace, remote)
    else:
        _git_ops.ensure_repo(workspace)
        if remote:
            _git_ops.configure_remote(workspace, remote)


def _sync_workspace_tools_yml(user_id: str, repos) -> None:
    """Write all MCP tools to workspace-tools.yml and commit to git.

    Called after every create/update/delete so the file is always the
    authoritative source of truth for the workspace's tool registrations.
    """
    import logging

    import git_ops as _git_ops
    import yaml as pyyaml

    logger = logging.getLogger("floom.api")
    try:
        tools = repos.mcp_tools.list(user_id=user_id)
        doc = {
            "version": 1,
            "tools": [
                {
                    "id": t["id"],
                    "name": t["name"],
                    "worker_id": t["worker_id"],
                    "description": t.get("description", ""),
                }
                for t in tools
            ],
        }
        workspace = _git_workspace()
        yml_path = workspace / _WORKSPACE_TOOLS_FILENAME
        yml_path.write_text(
            pyyaml.safe_dump(doc, sort_keys=False, default_flow_style=False, allow_unicode=True),
            encoding="utf-8",
        )
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            _git_ops.commit_paths(
                workspace, [_WORKSPACE_TOOLS_FILENAME],
                f"tools: update workspace-tools.yml ({len(tools)} tool{'s' if len(tools) != 1 else ''})",
            )
            _git_ops.push_background(workspace)
    except Exception as exc:
        logger.warning("Failed to sync %s: %s", _WORKSPACE_TOOLS_FILENAME, exc)


# ---------------------------------------------------------------------------
# GitHub workspace config + encrypted secrets vault (.secrets.enc)
# ---------------------------------------------------------------------------

def _git_workspace_key(user_id: str) -> str:
    """Return the key for git_workspace_config rows.

    Cloud: workspace_id — all members of a workspace share one GitHub repo.
    OSS:   user_id — single-user or first-admin owns the config.
    """
    import git_ops as _git_ops

    return _git_ops.get_active_workspace_id() or user_id


def _git_cfg_get(user_id: str) -> dict | None:
    from db import get_db

    key = _git_workspace_key(user_id)
    with get_db() as conn:
        row = conn.execute(
            """SELECT github_pat, github_username, repo_full_name, repo_url,
                      remote_url, connected_at, last_pushed_at
               FROM git_workspace_config WHERE user_id = ?""",
            (key,),
        ).fetchone()
    return dict(row) if row else None


def _git_cfg_upsert(user_id: str, **fields: str) -> None:
    from db import get_db

    key = _git_workspace_key(user_id)
    with get_db() as conn:
        existing = conn.execute(
            "SELECT 1 FROM git_workspace_config WHERE user_id = ?", (key,)
        ).fetchone()
        if existing:
            set_clause = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(
                f"UPDATE git_workspace_config SET {set_clause} WHERE user_id = ?",
                [*fields.values(), key],
            )
        else:
            fields["user_id"] = key
            keys = ", ".join(fields)
            placeholders = ", ".join("?" * len(fields))
            conn.execute(
                f"INSERT INTO git_workspace_config ({keys}) VALUES ({placeholders})",
                list(fields.values()),
            )


def _git_cfg_delete(user_id: str) -> None:
    from db import get_db

    key = _git_workspace_key(user_id)
    with get_db() as conn:
        conn.execute("DELETE FROM git_workspace_config WHERE user_id = ?", (key,))


_SECRETS_ENC_FILENAME = ".secrets.enc"

# Cloud hook — registered by workeros-cloud startup.py to return the
# workspace's AES key from Supabase Vault (pgsodium DARE) instead of
# reading from GitHub Variables.
_secrets_key_resolver = None


def set_secrets_key_resolver(fn) -> None:
    """Register a callable returning the active workspace's AES-256 key bytes.

    Cloud registers this at startup — keys come from Supabase Vault (pgsodium).
    Pass None to clear (OSS fallback).
    """
    global _secrets_key_resolver
    _secrets_key_resolver = fn


_LOCAL_KEY_PATH = Path.home() / ".config" / "workeros" / "secrets.key"


def _get_or_create_secrets_key(pat: str, repo_full_name: str) -> bytes:
    """Return the AES-256 key for .secrets.enc.

    Lookup order:
      1. Cloud: _secrets_key_resolver() — Supabase Vault, never touches GitHub.
      2. OSS + GitHub: GitHub repo Variable (WORKEROS_SECRETS_KEY). Generates
         and stores a random key on first use.
      3. Local git (no GitHub): ~/.config/workeros/secrets.key. Generates and
         writes a random key with mode 600 on first use — same model as SSH keys.
    """
    import github_api as _gh

    # 1. Cloud resolver (Supabase Vault)
    if _secrets_key_resolver is not None:
        return _secrets_key_resolver()

    # 2. OSS + GitHub: key lives in the GitHub repo as an Actions Variable
    if repo_full_name:
        key = _gh.get_secrets_key(pat, repo_full_name)
        if key is None:
            key = os.urandom(32)
            _gh.set_secrets_key(pat, repo_full_name, key)
            logger.info("Generated new secrets key for %s", repo_full_name)
        return key

    # 3. Local git (no GitHub): key lives in ~/.config/workeros/secrets.key
    if _LOCAL_KEY_PATH.exists():
        return _LOCAL_KEY_PATH.read_bytes()
    _LOCAL_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    key = os.urandom(32)
    _LOCAL_KEY_PATH.write_bytes(key)
    _LOCAL_KEY_PATH.chmod(0o600)
    logger.info("Generated local secrets key at %s", _LOCAL_KEY_PATH)
    return key


def _encrypt_secrets_blob(secrets: dict, key: bytes) -> bytes:
    """Encrypt a secrets dict to bytes using AES-256-GCM."""
    import json as _json
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, _json.dumps(secrets).encode("utf-8"), None)
    return nonce + ct  # 12-byte nonce prepended for decryption


def _decrypt_secrets_blob(blob: bytes, key: bytes) -> dict:
    """Decrypt bytes produced by _encrypt_secrets_blob."""
    import json as _json
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce, ct = blob[:12], blob[12:]
    plaintext = AESGCM(key).decrypt(nonce, ct, None)
    return _json.loads(plaintext.decode("utf-8"))


def _sync_secrets_to_enc(user_id: str, repos, pat: str, repo_full_name: str) -> None:
    """Encrypt all workspace secrets and commit .secrets.enc to git.

    Called on every secret save/delete when GitHub is connected.
    """
    import git_ops as _git_ops

    try:
        secrets: dict[str, str] = {}
        for row in repos.secrets.list(user_id=user_id):
            val = repos.secrets.read_value(user_id=user_id, name=row["name"])
            if val is not None:
                secrets[row["name"]] = val
        if not secrets:
            return
        key = _get_or_create_secrets_key(pat, repo_full_name)
        blob = _encrypt_secrets_blob(secrets, key)
        workspace = _git_workspace()
        enc_path = workspace / _SECRETS_ENC_FILENAME
        enc_path.write_bytes(blob)
        with _git_ops_lock:
            _ensure_git_workspace_ready(workspace)
            _git_ops.commit_paths(
                workspace, [_SECRETS_ENC_FILENAME],
                "secrets: update encrypted vault",
            )
            _git_ops.push_background(workspace)
        logger.debug("Encrypted %d secrets to %s", len(secrets), _SECRETS_ENC_FILENAME)
    except Exception as exc:
        logger.warning("Failed to sync secrets to %s: %s", _SECRETS_ENC_FILENAME, exc)


def _load_secrets_from_enc(user_id: str, repos, pat: str, repo_full_name: str) -> int:
    """Decrypt .secrets.enc and load secrets into WorkerOS. Returns count loaded.

    Called on startup (if already connected) and after linking a repo (fresh install).
    """
    try:
        enc_path = _git_workspace() / _SECRETS_ENC_FILENAME
        if not enc_path.is_file():
            return 0
        key = _get_or_create_secrets_key(pat, repo_full_name)
        blob = enc_path.read_bytes()
        secrets = _decrypt_secrets_blob(blob, key)
        loaded = 0
        for name, value in secrets.items():
            try:
                repos.secrets.set(user_id=user_id, name=name, value=str(value))
                loaded += 1
            except Exception:
                pass
        if loaded:
            logger.info("Loaded %d secrets from %s", loaded, _SECRETS_ENC_FILENAME)
        return loaded
    except Exception as exc:
        logger.warning("Failed to load secrets from %s: %s", _SECRETS_ENC_FILENAME, exc)
        return 0


def _load_workspace_tools_yml(user_id: str, repos) -> int:
    """Parse workspace-tools.yml and sync missing tools into the DB.

    Called on startup after a fresh clone so MCP tool registrations
    are restored automatically. Returns count of tools loaded.
    """
    import yaml as pyyaml

    from services.worker_access import _mcp_input_schema_from_worker_record
    yml_path = _git_workspace() / _WORKSPACE_TOOLS_FILENAME
    if not yml_path.is_file():
        return 0
    try:
        doc = pyyaml.safe_load(yml_path.read_text(encoding="utf-8")) or {}
        tools_in_file = doc.get("tools") or []
        existing_names = {t["name"] for t in repos.mcp_tools.list(user_id=user_id)}
        loaded = 0
        for t in tools_in_file:
            name = t.get("name", "").strip()
            worker_id = t.get("worker_id", "").strip()
            if not name or not worker_id or name in existing_names:
                continue
            worker = repos.workers.get(user_id=user_id, worker_id=worker_id)
            if not worker:
                continue
            input_schema = _mcp_input_schema_from_worker_record(worker)
            repos.mcp_tools.create(
                user_id=user_id,
                name=name,
                description=t.get("description", ""),
                input_schema=input_schema,
                worker_id=worker_id,
            )
            loaded += 1
        if loaded:
            logger.info("Loaded %d MCP tools from %s", loaded, _WORKSPACE_TOOLS_FILENAME)
        return loaded
    except Exception as exc:
        logger.warning("Failed to load %s: %s", _WORKSPACE_TOOLS_FILENAME, exc)
        return 0


def _workers_git_prefix() -> str:
    """Relative path of the workers dir within the workspace git root.

    OSS: git root is WORKERS_DIR.parent, so workers are at 'workers/'.
    Cloud: git root IS WORKERS_DIR/workspace_id, so workers sit at root — prefix is ''.
    """
    import git_ops as _git_ops
    from worker_registry import WORKERS_DIR

    if _git_ops.get_active_workspace_id():
        return ""  # Cloud: worker_id/ is directly under the git root
    try:
        return WORKERS_DIR.relative_to(_git_workspace()).as_posix()
    except ValueError:
        return "workers"


def _require_sha_in_asset_history(workspace: "Path", sha: str, rel_path: str) -> None:
    """#928: rollback/restore SHAs must come from the target asset's own git
    history. The workspace repo is shared across users and assets, so an
    arbitrary commit id would let a caller materialize file states from other
    users' workers or brain packs into an asset they control."""
    import git_ops as _git_ops
    from fastapi import HTTPException

    if not _git_ops.sha_in_path_history(workspace, sha, rel_path):
        raise HTTPException(
            status_code=404,
            detail=f"Commit {sha!r} not found in this asset's history",
        )
