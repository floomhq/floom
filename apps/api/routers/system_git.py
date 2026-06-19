"""GitHub workspace integration routes (PAT connect, repo link/push/import).

The nine ``/system/git*`` admin routes: connection status, PAT validation,
repo listing/creation, linking + initial push, manual push, disconnect, and
the full workspace import (workers/contexts/instructions/tools/secrets) from
the linked repo. Extracted verbatim from main.py into an APIRouter.

``services.git_service`` (workspace config rows, encrypted vault, tools-yml
loader) is never purged by fixtures and resolves db/git_ops lazily itself, so
it is a real module-level import. ``github_api``/``git_ops``/``contexts``/
``db``/``auth.guards`` are imported lazily inside handlers (purged modules).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from services.git_service import (
    _WORKSPACE_TOOLS_FILENAME,
    _git_cfg_delete,
    _git_cfg_get,
    _git_cfg_upsert,
    _git_workspace,
    _load_secrets_from_enc,
    _load_workspace_tools_yml,
)

logger = logging.getLogger("floom.api")

system_git_router = APIRouter()


def _git_safe_http_detail(exc: BaseException, where: str) -> str:
    """A-05: redact git stderr (remote URL with embedded PAT, fs paths) from
    HTTP responses; log full detail server-side, return a user-safe message."""
    logger.exception("Git endpoint (%s) failed", where)
    detail = str(exc)
    low = detail.lower()
    if "authentication failed" in low or "403" in low or "401" in low or "permission denied" in low:
        return "GitHub authentication failed — check the token has the 'repo' scope."
    if "repository not found" in low or "not found" in low or "404" in low:
        return "GitHub repository not found — check the repo name and access."
    if "could not resolve host" in low or "failed to connect" in low or "timed out" in low or "timeout" in low:
        return "Could not reach GitHub — check network connectivity and try again."
    return "Git operation failed. The error has been logged; please retry or check the workspace's GitHub connection."


def _github_api_safe_detail(exc: BaseException) -> str:
    """A-05: keep GitHub's user-meaningful API message, but never echo a URL/token."""
    detail = str(exc).strip()
    if not detail or re.search(r"https?://|x-access-token|ghp_|github_pat_|@github\.com", detail, re.IGNORECASE):
        logger.exception("GitHub API error (redacted from response)")
        return "GitHub request failed. The error has been logged; please retry."
    return f"GitHub error: {detail}"


class _GitStatus(BaseModel):
    connected: bool
    github_username: Optional[str] = None
    repo_full_name: Optional[str] = None
    repo_url: Optional[str] = None
    connected_at: Optional[str] = None
    last_pushed_at: Optional[str] = None
    # Set after a fresh-install link when secrets were decrypted from .secrets.enc
    secrets_loaded: int = 0


class _GitConnectRequest(BaseModel):
    pat: str


class _GitLinkRequest(BaseModel):
    repo_full_name: str


class _GitCreateRepoRequest(BaseModel):
    name: str


class _GitRepoItem(BaseModel):
    full_name: str
    name: str
    url: str
    private: bool
    description: Optional[str] = None
    pushed_at: Optional[str] = None


@system_git_router.get("/system/git", response_model=_GitStatus)
def get_git_status(auth: AuthContext = Depends(get_auth_context)) -> _GitStatus:
    """Return current GitHub connection + linked repo status."""
    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("repo_full_name"):
        return _GitStatus(connected=False)
    return _GitStatus(
        connected=True,
        github_username=cfg.get("github_username"),
        repo_full_name=cfg.get("repo_full_name"),
        repo_url=cfg.get("repo_url"),
        connected_at=cfg.get("connected_at"),
        last_pushed_at=cfg.get("last_pushed_at"),
    )


@system_git_router.post("/system/git/connect")
def connect_github(
    payload: _GitConnectRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> Dict[str, Any]:
    """Validate a GitHub PAT and store it. Admin only."""
    from auth.guards import _require_admin
    from db import now_iso

    _require_admin(auth)
    import github_api as _gh

    pat = payload.pat.strip()
    if not pat:
        raise HTTPException(status_code=400, detail="PAT cannot be empty")
    try:
        user_info = _gh.validate_pat(pat)
    except _gh.GitHubAPIError as exc:
        status = getattr(exc, "status", 0)
        if status == 401:
            raise HTTPException(status_code=400, detail="Invalid GitHub token — check it has the 'repo' scope") from exc
        raise HTTPException(status_code=400, detail=_github_api_safe_detail(exc)) from exc

    # Preserve existing repo link if there is one
    existing = _git_cfg_get(auth.user_id) or {}
    _git_cfg_upsert(
        auth.user_id,
        github_pat=pat,
        github_username=user_info.get("login", ""),
        connected_at=existing.get("connected_at") or now_iso(),
        # Keep existing repo fields if already linked
        **({
            "repo_full_name": existing["repo_full_name"],
            "repo_url": existing["repo_url"],
            "remote_url": existing["remote_url"],
        } if existing.get("repo_full_name") else {}),
    )
    return {
        "username": user_info.get("login"),
        "avatar_url": user_info.get("avatar_url"),
        "name": user_info.get("name"),
    }


@system_git_router.get("/system/git/repos", response_model=List[_GitRepoItem])
def list_git_repos(auth: AuthContext = Depends(get_auth_context)) -> List[_GitRepoItem]:
    """List GitHub repos that look like WorkerOS workspaces. Admin only."""
    from auth.guards import _require_admin

    _require_admin(auth)
    import github_api as _gh

    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("github_pat"):
        raise HTTPException(status_code=400, detail="Not connected to GitHub — provide a PAT first")
    try:
        repos = _gh.list_workeros_repos(cfg["github_pat"])
    except _gh.GitHubAPIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [_GitRepoItem(**{k: r[k] for k in _GitRepoItem.model_fields if k in r}) for r in repos]


@system_git_router.post("/system/git/repos", response_model=_GitRepoItem, status_code=201)
def create_git_repo(
    payload: _GitCreateRepoRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> _GitRepoItem:
    """Create a new private GitHub repo for this workspace. Admin only."""
    from auth.guards import _require_admin

    _require_admin(auth)
    import github_api as _gh

    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("github_pat"):
        raise HTTPException(status_code=400, detail="Not connected to GitHub")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Repo name cannot be empty")
    try:
        repo = _gh.create_workeros_repo(cfg["github_pat"], name)
    except _gh.GitHubAPIError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _GitRepoItem(**{k: repo[k] for k in _GitRepoItem.model_fields if k in repo})


@system_git_router.post("/system/git/link", response_model=_GitStatus)
def link_git_repo(
    payload: _GitLinkRequest,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> _GitStatus:
    """Link a GitHub repo as this workspace's remote and push. Admin only."""
    import git_ops as _git_ops
    from auth.guards import _require_admin
    from db import now_iso

    _require_admin(auth)
    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("github_pat"):
        raise HTTPException(status_code=400, detail="Not connected to GitHub")

    pat = cfg["github_pat"]
    full_name = payload.repo_full_name.strip()
    remote_url = f"https://github.com/{full_name}.git"
    repo_url = f"https://github.com/{full_name}"

    workspace = _git_workspace()
    try:
        _git_ops.configure_remote(workspace, remote_url)
        # Pull if the remote has commits (e.g. auto-init), then push
        try:
            _git_ops.pull_with_github_token(workspace, pat)
        except _git_ops.GitOpsError:
            pass  # Remote is empty — fine, we'll just push
        _git_ops.push_with_github_token(workspace, pat)
    except _git_ops.GitOpsError as exc:
        raise HTTPException(
            status_code=500,
            detail=_git_safe_http_detail(exc, "link"),
        ) from exc

    pushed_at = now_iso()
    _git_cfg_upsert(
        auth.user_id,
        repo_full_name=full_name,
        repo_url=repo_url,
        remote_url=repo_url,
        last_pushed_at=pushed_at,
    )

    # Fresh-install: if .secrets.enc is in the cloned repo, decrypt and load now.
    # On an existing install this is a no-op (secrets already loaded).
    secrets_loaded = _load_secrets_from_enc(auth.user_id, repos, pat, full_name)

    return _GitStatus(
        connected=True,
        github_username=cfg.get("github_username"),
        repo_full_name=full_name,
        repo_url=repo_url,
        connected_at=cfg.get("connected_at"),
        last_pushed_at=pushed_at,
        secrets_loaded=secrets_loaded,
    )


@system_git_router.post("/system/git/push", response_model=_GitStatus)
def push_git_workspace(auth: AuthContext = Depends(get_auth_context)) -> _GitStatus:
    """Push the workspace git repo to GitHub. Admin only."""
    import git_ops as _git_ops
    from auth.guards import _require_admin
    from db import now_iso

    _require_admin(auth)
    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("repo_full_name") or not cfg.get("github_pat"):
        raise HTTPException(status_code=400, detail="No GitHub repo linked")
    try:
        _git_ops.push_with_github_token(_git_workspace(), cfg["github_pat"])
    except _git_ops.GitOpsError as exc:
        raise HTTPException(
            status_code=500,
            detail=_git_safe_http_detail(exc, "push"),
        ) from exc

    pushed_at = now_iso()
    _git_cfg_upsert(auth.user_id, last_pushed_at=pushed_at)
    return _GitStatus(
        connected=True,
        github_username=cfg.get("github_username"),
        repo_full_name=cfg.get("repo_full_name"),
        repo_url=cfg.get("repo_url"),
        connected_at=cfg.get("connected_at"),
        last_pushed_at=pushed_at,
    )


@system_git_router.delete("/system/git", status_code=204)
def disconnect_git(auth: AuthContext = Depends(get_auth_context)) -> Response:
    """Remove stored GitHub credentials and detach the remote. Admin only."""
    import git_ops as _git_ops
    from auth.guards import _require_admin

    _require_admin(auth)
    _git_cfg_delete(auth.user_id)
    try:
        _git_ops._git(["remote", "remove", "origin"], _git_workspace(), check=False)
    except Exception:
        pass
    return Response(status_code=204)


@system_git_router.post("/system/git/import", status_code=200)
def import_git_workspace(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Import workers and contexts from the linked GitHub repo into WorkerOS.

    Clones the repo into a temp directory, parses each worker bundle, upserts
    into the repository, then cleans up. Safe to call on an existing install —
    workers already in the DB are updated, not duplicated. Admin only.

    In cloud, repos.workers is SupabaseWorkerRepository so upsert goes to
    Supabase. Secrets are skipped in cloud (.secrets.enc is OSS-only).
    In OSS, worker files are written to WORKERS_DIR and committed to git.
    """
    import tempfile, shutil as _shutil
    import git_ops as _git_ops
    import github_api as _gh
    import yaml as pyyaml
    from auth.guards import _require_admin
    from contexts import current_contexts_root

    _require_admin(auth)
    cfg = _git_cfg_get(auth.user_id)
    if not cfg or not cfg.get("repo_full_name"):
        raise HTTPException(status_code=400, detail="No GitHub repo linked")

    pat = cfg["github_pat"]
    repo_full_name = cfg["repo_full_name"]
    imported = {"workers": 0, "contexts": 0, "secrets": 0, "tools": 0}

    tmp = Path(tempfile.mkdtemp(prefix="workeros-import-"))
    try:
        # Clone into temp directory
        remote_url = f"https://github.com/{repo_full_name}.git"
        try:
            _git_ops.clone_or_init_with_github_token(tmp, remote_url, pat)
        except _git_ops.GitOpsError as exc:
            raise HTTPException(
                status_code=500,
                detail=_git_safe_http_detail(exc, "clone"),
            ) from exc

        # Import workers
        workers_dir_in_repo = tmp / "workers"
        if workers_dir_in_repo.is_dir():
            for worker_bundle in sorted(workers_dir_in_repo.iterdir()):
                if not worker_bundle.is_dir():
                    continue
                worker_id = worker_bundle.name
                yml_path = worker_bundle / "worker.yml"
                if not yml_path.is_file():
                    continue
                try:
                    manifest = pyyaml.safe_load(yml_path.read_text(encoding="utf-8")) or {}
                    # Embed all other files as _files
                    files: Dict[str, str] = {}
                    for fpath in worker_bundle.iterdir():
                        if fpath.name == "worker.yml" or not fpath.is_file():
                            continue
                        try:
                            files[fpath.name] = fpath.read_text(encoding="utf-8")
                        except Exception:
                            pass
                    if files:
                        manifest["_files"] = files
                    repos.workers.upsert(
                        user_id=auth.user_id,
                        worker_id=worker_id,
                        name=manifest.get("title") or manifest.get("name") or worker_id,
                        manifest_json=manifest,
                        trigger_type=manifest.get("trigger", {}).get("type") or "manual",
                        bundle_path=f"workers/{worker_id}",
                    )
                    imported["workers"] += 1
                except Exception as exc:
                    logger.warning("Import: skipped worker %s: %s", worker_id, exc)

        # Import contexts (write to disk — contexts are filesystem-based in both OSS and cloud)
        contexts_dir_in_repo = tmp / "contexts"
        if contexts_dir_in_repo.is_dir():
            dest_contexts = current_contexts_root()
            for ctx_bundle in sorted(contexts_dir_in_repo.iterdir()):
                if not ctx_bundle.is_dir():
                    continue
                dest = dest_contexts / ctx_bundle.name
                dest.mkdir(parents=True, exist_ok=True)
                for fpath in ctx_bundle.iterdir():
                    if fpath.is_file():
                        try:
                            (dest / fpath.name).write_bytes(fpath.read_bytes())
                        except Exception:
                            pass
                imported["contexts"] += 1

        # Import workspace instructions
        for fname in ("workspace.md", "workspace.base.md"):
            src = tmp / fname
            if src.is_file():
                try:
                    (_git_workspace() / fname).write_bytes(src.read_bytes())
                except Exception:
                    pass

        # Import workspace-tools.yml
        tools_yml = tmp / "workspace-tools.yml"
        if tools_yml.is_file():
            try:
                dest_tools = _git_workspace() / _WORKSPACE_TOOLS_FILENAME
                dest_tools.parent.mkdir(parents=True, exist_ok=True)
                dest_tools.write_bytes(tools_yml.read_bytes())
                imported["tools"] = _load_workspace_tools_yml(auth.user_id, repos)
            except Exception:
                pass

        # Import secrets from .secrets.enc (OSS only — cloud uses Supabase).
        # Read the resolver from the live service module — it is mutable state
        # registered at startup via set_secrets_key_resolver.
        from services import git_service as _git_service
        if _git_service._secrets_key_resolver is None:
            loaded_secrets = _load_secrets_from_enc(auth.user_id, repos, pat, repo_full_name)
            imported["secrets"] = loaded_secrets

    finally:
        try:
            _shutil.rmtree(tmp, ignore_errors=True)
        except Exception:
            pass

    return {"imported": imported}
