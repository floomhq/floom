"""Cloud git config helpers.

Thin module — git operations (commit, push, rollback) now live in
cloud_git_local.py using real git commands against a per-workspace local
repo. This module retains only the Supabase config lookup used by the
startup overrides and fallback paths.
"""
from __future__ import annotations

from urllib.parse import quote, urlsplit, urlunsplit
from typing import Optional

from apps.api.obs import get_logger

logger = get_logger(__name__)

_GIT_PAT_PREFIX = "fernet:"


def encrypt_git_pat(pat: str) -> str:
    if pat.startswith(_GIT_PAT_PREFIX):
        return pat
    from apps.api.db._secret_crypto import encrypt_secret

    return _GIT_PAT_PREFIX + encrypt_secret(pat).decode("ascii")


def decrypt_git_pat(value: str) -> str:
    if not value.startswith(_GIT_PAT_PREFIX):
        return value
    from apps.api.db._secret_crypto import decrypt_secret

    return decrypt_secret(value.removeprefix(_GIT_PAT_PREFIX).encode("ascii"))


def strip_remote_credentials(remote_url: str | None) -> str | None:
    if not remote_url:
        return remote_url
    try:
        parsed = urlsplit(remote_url)
    except Exception:
        return remote_url
    if not parsed.scheme or not parsed.netloc:
        return remote_url
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, parsed.query, parsed.fragment))


def storage_fields(fields: dict) -> dict:
    safe = dict(fields)
    pat = safe.get("github_pat")
    if pat:
        safe["github_pat"] = encrypt_git_pat(str(pat))
    if "remote_url" in safe:
        safe["remote_url"] = strip_remote_credentials(safe.get("remote_url"))
    return safe


def plaintext_cfg(row: dict | None) -> dict | None:
    if not row:
        return None
    cfg = dict(row)
    pat = cfg.get("github_pat")
    if pat:
        cfg["github_pat"] = decrypt_git_pat(str(pat))
    cfg["remote_url"] = strip_remote_credentials(cfg.get("remote_url"))
    return cfg


def authenticated_github_remote_url(pat: str, repo_full_name: str) -> str:
    return f"https://{quote(pat, safe='')}@github.com/{repo_full_name}.git"


def get_git_cfg(workspace_id: str) -> Optional[dict]:
    """Return the git_workspace_config row for the workspace, or None."""
    from apps.api.config import get_supabase_service_client
    try:
        svc = get_supabase_service_client()
        rows = (
            svc.table("git_workspace_config")
            .select(
                "github_pat,github_username,repo_full_name,repo_url,"
                "remote_url,connected_at,last_pushed_at"
            )
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
        if not rows.data:
            return None
        raw = dict(rows.data[0])
        cfg = plaintext_cfg(raw)
        pat = raw.get("github_pat")
        if pat and not str(pat).startswith(_GIT_PAT_PREFIX) and cfg:
            svc.table("git_workspace_config").update(
                {"github_pat": encrypt_git_pat(cfg["github_pat"])}
            ).eq("workspace_id", workspace_id).execute()
        return cfg
    except Exception:
        logger.warning(
            "get_git_cfg failed for workspace %s (git remote / GitHub sync config "
            "unavailable for this request)",
            workspace_id, exc_info=True,
        )
        return None
