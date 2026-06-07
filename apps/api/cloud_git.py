"""Cloud GitOps — push workspace state to GitHub via the Contents API.

No local git clone or persistent disk required. Supabase is the runtime
source of truth; GitHub is version control + disaster recovery.

Write path per entity type:
  worker   → manifest_json._files from skill_versions table → GitHub API
  context  → CONTEXTS_DIR/{name}/* on disk (contexts are still FS-based)
  workspace.md / workspace.base.md → disk → GitHub API
  workspace-tools.yml → serialized from Supabase mcp_tools table → GitHub API

Secrets are NOT pushed to GitHub in cloud (Supabase handles them).
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_WORKERS_GIT_PREFIX = "workers"
_CONTEXTS_GIT_PREFIX = "contexts"


# ---------------------------------------------------------------------------
# Config lookup
# ---------------------------------------------------------------------------

def get_git_cfg(workspace_id: str) -> Optional[dict]:
    """Return {github_pat, repo_full_name} for the workspace, or None."""
    from apps.api.config import get_supabase_service_client
    try:
        svc = get_supabase_service_client()
        rows = (
            svc.table("git_workspace_config")
            .select("github_pat,github_username,repo_full_name,repo_url,connected_at,last_pushed_at")
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
        return rows.data[0] if rows.data else None
    except Exception as exc:
        logger.debug("get_git_cfg failed for %s: %s", workspace_id, exc)
        return None


def _stamp_last_pushed(workspace_id: str) -> None:
    from apps.api.config import get_supabase_service_client
    from datetime import datetime, timezone
    try:
        svc = get_supabase_service_client()
        svc.table("git_workspace_config").update(
            {"last_pushed_at": datetime.now(timezone.utc).isoformat()}
        ).eq("workspace_id", workspace_id).execute()
    except Exception as exc:
        logger.debug("Failed to stamp last_pushed_at: %s", exc)


# ---------------------------------------------------------------------------
# Low-level GitHub Contents API push
# ---------------------------------------------------------------------------

def _put_file(pat: str, repo: str, path: str, content: bytes, message: str) -> None:
    import github_api
    try:
        sha = github_api.get_file_sha(pat, repo, path)
        github_api.put_file(pat, repo, path, content, message, sha=sha)
    except Exception as exc:
        logger.debug("put_file %s failed: %s", path, exc)
        raise


# ---------------------------------------------------------------------------
# Per-entity push helpers
# ---------------------------------------------------------------------------

def push_worker(workspace_id: str, worker_id: str, pat: str, repo: str, message: str) -> None:
    """Serialize worker from skill_versions in Supabase and push to GitHub."""
    from apps.api.config import get_supabase_service_client
    import yaml

    svc = get_supabase_service_client()
    rows = (
        svc.table("workers")
        .select("skill_version_id")
        .eq("id", worker_id)
        .eq("workspace_id", workspace_id)
        .limit(1)
        .execute()
    )
    if not rows.data:
        print(f"[push_worker] {worker_id}: no worker row in Supabase", flush=True)
        return
    sv_id = rows.data[0]["skill_version_id"]
    sv_rows = (
        svc.table("skill_versions")
        .select("manifest_json")
        .eq("id", sv_id)
        .limit(1)
        .execute()
    )
    if not sv_rows.data:
        return

    manifest: dict = dict(sv_rows.data[0]["manifest_json"] or {})
    files: dict = manifest.pop("_files", {}) or {}

    # If _files is empty, fall back to reading from disk (e.g. after rollback
    # wrote historical files to the workers dir but manifest lacks _files).
    if not files:
        import os as _os
        workers_dir_env = (_os.environ.get("FLOOM_WORKERS_DIR") or "").strip()
        if workers_dir_env:
            from pathlib import Path as _Path
            worker_dir = _Path(workers_dir_env) / worker_id
            if worker_dir.is_dir():
                for fpath in worker_dir.iterdir():
                    if fpath.is_file() and fpath.name != "worker.yml":
                        try:
                            files[fpath.name] = fpath.read_text(encoding="utf-8")
                        except Exception:
                            pass

    prefix = f"{_WORKERS_GIT_PREFIX}/{worker_id}"

    # Push each embedded file (SKILL.md, run.py, requirements.txt, ...)
    for fname, content in files.items():
        _put_file(pat, repo, f"{prefix}/{fname}", content.encode("utf-8"), message)

    # Push worker.yml (clean manifest without _files)
    manifest.pop("_files", None)
    yml_bytes = yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True).encode("utf-8")
    _put_file(pat, repo, f"{prefix}/worker.yml", yml_bytes, message)


def push_context(workspace_id: str, context_name: str, pat: str, repo: str, message: str) -> None:
    """Push all files for a context from disk to GitHub."""
    from apps.api._engine import ensure_engine_api_path
    ensure_engine_api_path()
    from contexts import current_contexts_root  # noqa: PLC0415

    ctx_dir = current_contexts_root() / context_name
    if not ctx_dir.is_dir():
        return
    prefix = f"{_CONTEXTS_GIT_PREFIX}/{context_name}"
    for fpath in ctx_dir.rglob("*"):
        if not fpath.is_file():
            continue
        rel = fpath.relative_to(ctx_dir).as_posix()
        try:
            _put_file(pat, repo, f"{prefix}/{rel}", fpath.read_bytes(), message)
        except Exception as exc:
            logger.debug("push_context file %s failed: %s", rel, exc)


def push_workspace_md(pat: str, repo: str, message: str, workspace_dir: Path) -> None:
    """Push workspace.md and workspace.base.md from disk to GitHub."""
    for fname in ("workspace.md", "workspace.base.md"):
        fpath = workspace_dir / fname
        if fpath.is_file():
            try:
                _put_file(pat, repo, fname, fpath.read_bytes(), message)
            except Exception as exc:
                logger.debug("push_workspace_md %s failed: %s", fname, exc)


def push_workspace_tools(workspace_id: str, pat: str, repo: str, message: str) -> None:
    """Serialize workspace-tools.yml from Supabase mcp_tools and push to GitHub."""
    import yaml
    from apps.api.config import get_supabase_service_client
    from apps.api.auth.workspace_context import get_active_workspace_id

    svc = get_supabase_service_client()
    try:
        rows = svc.table("mcp_tools").select("*").eq("workspace_id", workspace_id).execute()
        tools = rows.data or []
        doc = {
            "version": 1,
            "tools": [
                {
                    "id": t["id"],
                    "name": t["name"],
                    "worker_id": t["worker_id"],
                    "description": t.get("description") or "",
                }
                for t in tools
            ],
        }
        content = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True).encode("utf-8")
        _put_file(pat, repo, "workspace-tools.yml", content, message)
    except Exception as exc:
        logger.debug("push_workspace_tools failed: %s", exc)


def push_all(workspace_id: str, pat: str, repo: str) -> None:
    """Push all workspace content to GitHub (used on initial link).

    Pushes all workers, contexts, workspace instructions, and MCP tools.
    Secrets are not pushed — they live in Supabase in cloud.
    """
    from apps.api.config import get_supabase_service_client
    from apps.api._engine import ensure_engine_api_path
    ensure_engine_api_path()

    svc = get_supabase_service_client()
    message = "chore: initial workspace snapshot"

    # Workers
    try:
        rows = svc.table("workers").select("id").eq("workspace_id", workspace_id).execute()
        for row in (rows.data or []):
            try:
                push_worker(workspace_id, row["id"], pat, repo, message)
            except Exception as exc:
                logger.warning("push_all: skipped worker %s: %s", row["id"], exc)
    except Exception as exc:
        logger.warning("push_all: workers query failed: %s", exc)

    # Contexts (disk-based)
    try:
        from contexts import current_contexts_root  # noqa: PLC0415
        ctx_root = current_contexts_root()
        if ctx_root.is_dir():
            for ctx_dir in ctx_root.iterdir():
                if ctx_dir.is_dir():
                    try:
                        push_context(workspace_id, ctx_dir.name, pat, repo, message)
                    except Exception as exc:
                        logger.warning("push_all: skipped context %s: %s", ctx_dir.name, exc)
    except Exception as exc:
        logger.warning("push_all: contexts push failed: %s", exc)

    # workspace.md / workspace.base.md
    try:
        import main as engine_main  # noqa: PLC0415
        workspace_dir = engine_main._git_workspace()
        push_workspace_md(pat, repo, message, workspace_dir)
    except Exception as exc:
        logger.debug("push_all: workspace.md push failed: %s", exc)

    # workspace-tools.yml
    try:
        push_workspace_tools(workspace_id, pat, repo, message)
    except Exception as exc:
        logger.debug("push_all: workspace-tools.yml push failed: %s", exc)

    _stamp_last_pushed(workspace_id)


# ---------------------------------------------------------------------------
# Background dispatcher — called by the overridden git_ops.commit_paths
# ---------------------------------------------------------------------------

def schedule_push(workspace_id: str, rel_paths: list, message: str) -> None:
    """Determine what changed from rel_paths and push to GitHub in background."""
    def _run() -> None:
        try:
            cfg = get_git_cfg(workspace_id)
            if not cfg:
                return
            pat = cfg.get("github_pat") or ""
            repo = cfg.get("repo_full_name") or ""
            if not pat or not repo:
                return

            for rel in rel_paths:
                try:
                    _dispatch_rel(workspace_id, rel, pat, repo, message)
                except Exception as exc:
                    logger.debug("schedule_push: %s failed: %s", rel, exc)

            _stamp_last_pushed(workspace_id)
        except Exception as exc:
            logger.debug("schedule_push background failed: %s", exc)

    threading.Thread(target=_run, daemon=True, name="workeros-github-push").start()


def _dispatch_rel(workspace_id: str, rel: str, pat: str, repo: str, message: str) -> None:
    """Route a rel_path to the correct push helper."""
    import main as engine_main  # noqa: PLC0415

    # Skip secrets — cloud uses Supabase
    if rel == ".secrets.enc":
        return

    if rel == "workspace-tools.yml":
        push_workspace_tools(workspace_id, pat, repo, message)
        return

    if rel in ("workspace.md", "workspace.base.md"):
        workspace_dir = engine_main._git_workspace()
        push_workspace_md(pat, repo, message, workspace_dir)
        return

    # Context: "contexts/{name}" or "contexts/{name}/file"
    if rel.startswith("contexts/"):
        context_name = rel.split("/", 2)[1]
        is_delete = "delete" in message.lower()
        if is_delete:
            # Clean up Storage — disk is already gone
            try:
                from apps.api.cloud_contexts import delete_context_from_storage  # noqa: PLC0415
                delete_context_from_storage(workspace_id, context_name)
            except Exception as exc:
                logger.debug("delete_context_from_storage failed: %s", exc)
        else:
            push_context(workspace_id, context_name, pat, repo, message)
            # Also sync to Supabase Storage for container-restart persistence
            try:
                from apps.api.cloud_contexts import upload_context_background  # noqa: PLC0415
                from apps.api._engine import ensure_engine_api_path  # noqa: PLC0415
                ensure_engine_api_path()
                from contexts import current_contexts_root  # noqa: PLC0415
                ctx_dir = current_contexts_root() / context_name
                upload_context_background(workspace_id, context_name, ctx_dir)
            except Exception as exc:
                logger.debug("context Storage upload failed: %s", exc)
        return

    # Worker: "workers/{id}" or just "{id}" (cloud empty prefix)
    if rel.startswith("workers/"):
        worker_id = rel.split("/")[1]
        push_worker(workspace_id, worker_id, pat, repo, message)
        return

    # Bare worker_id (when _workers_git_prefix returns "" — treated as worker)
    # Exclude known non-worker filenames
    _known_files = {"workspace.md", "workspace.base.md", "workspace-tools.yml", ".secrets.enc", ".gitignore"}
    if rel not in _known_files and "/" not in rel:
        push_worker(workspace_id, rel, pat, repo, message)
