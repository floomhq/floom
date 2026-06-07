"""Local git-backed workspace storage for cloud.

Each workspace gets an isolated git repository on the AX41 server disk:
  {WORKEROS_GIT_WORKSPACES_DIR}/{workspace_id}/

After every commit the repo is serialized as a git bundle and uploaded to
Supabase Storage (workeros-git-bundles bucket) for disaster recovery. On cold
start (server wipe / migration), the bundle is downloaded and the repo is
reconstructed before any git operation.

With GitHub connected: commit_workspace also triggers cloud_git.schedule_push
to sync the same changes to GitHub. Without GitHub: local git + Supabase
Storage bundle is the complete version history.

Storage layout:
  bucket "workeros-git-bundles" / {workspace_id} / repo.bundle

Git workspace layout (mirrors GitHub repo layout from cloud_git.py):
  {root}/{workspace_id}/
    .git/
    workers/{worker_id}/worker.yml + run.py + SKILL.md + ...
    contexts/{context_name}/...
    workspace.md
    workspace.base.md
    workspace-tools.yml
"""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Optional

from apps.api.config import get_supabase_service_client

logger = logging.getLogger(__name__)

_BUNDLES_BUCKET = "workeros-git-bundles"

# Per-workspace locks — prevent concurrent git writes for the same workspace.
# (Single AX41 server today; lock protects against simultaneous HTTP requests.)
_locks: dict[str, threading.Lock] = {}
_locks_mu = threading.Lock()


def _get_lock(workspace_id: str) -> threading.Lock:
    with _locks_mu:
        if workspace_id not in _locks:
            _locks[workspace_id] = threading.Lock()
        return _locks[workspace_id]


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def get_workspaces_root() -> Path:
    """Root directory for all workspace git repos.

    Override with WORKEROS_GIT_WORKSPACES_DIR env var (useful for local dev).
    Production default: /var/workeros-cloud/workspaces
    """
    env = (os.environ.get("WORKEROS_GIT_WORKSPACES_DIR") or "").strip()
    return Path(env) if env else Path("/var/workeros-cloud/workspaces")


def get_workspace_git_dir(workspace_id: str) -> Path:
    return get_workspaces_root() / workspace_id


# ---------------------------------------------------------------------------
# Git subprocess helper
# ---------------------------------------------------------------------------

def _git(
    args: list[str],
    cwd: Path,
    check: bool = True,
    timeout: int = 30,
) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git"] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ},
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed: {result.stderr.strip()}")
    return result


# ---------------------------------------------------------------------------
# Repo initialisation
# ---------------------------------------------------------------------------

def _init_repo(git_dir: Path) -> None:
    git_dir.mkdir(parents=True, exist_ok=True)
    _git(["init"], git_dir)
    _git(["config", "user.email", "workeros@local"], git_dir)
    _git(["config", "user.name", "WorkerOS"], git_dir)
    gitignore = git_dir / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text(
            "*.env\n.env\nsecrets.env\nworkeros.db*\n.venv/\n__pycache__/\n*.pyc\n",
            encoding="utf-8",
        )


def _restore_from_bundle(workspace_id: str, git_dir: Path) -> bool:
    """Download bundle from Supabase Storage and clone into git_dir.

    Returns True if a bundle was found and restored successfully.
    """
    try:
        svc = get_supabase_service_client()
        bundle_data = svc.storage.from_(_BUNDLES_BUCKET).download(
            f"{workspace_id}/repo.bundle"
        )
        if not bundle_data:
            return False
    except Exception as exc:
        logger.debug("No bundle in Storage for %s: %s", workspace_id, exc)
        return False

    with tempfile.NamedTemporaryFile(suffix=".bundle", delete=False) as f:
        f.write(bundle_data)
        tmp_path = f.name

    try:
        git_dir.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["git", "clone", tmp_path, str(git_dir)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            logger.warning(
                "git clone from bundle failed for %s: %s", workspace_id, result.stderr
            )
            return False
        _git(["config", "user.email", "workeros@local"], git_dir)
        _git(["config", "user.name", "WorkerOS"], git_dir)
        logger.info("Restored git workspace from bundle for %s", workspace_id)
        return True
    except Exception as exc:
        logger.warning("Bundle restore failed for %s: %s", workspace_id, exc)
        return False
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def ensure_workspace_repo(workspace_id: str) -> Path:
    """Ensure a git repo exists for this workspace. Returns the git root.

    On first call for a fresh workspace:
    1. Try to download and restore a bundle from Supabase Storage.
       If restored, backfill any worker _files missing from Supabase so
       workers can execute on the new server without a GitHub connection.
    2. Otherwise initialise a new empty repo.
    Subsequent calls are a fast-path (just checks for .git/).
    """
    git_dir = get_workspace_git_dir(workspace_id)
    if (git_dir / ".git").exists():
        return git_dir

    with _get_lock(workspace_id):
        if (git_dir / ".git").exists():
            return git_dir
        restored = _restore_from_bundle(workspace_id, git_dir)
        if restored:
            # Backfill worker execution files into Supabase so workers can run
            # on this new server without needing GitHub or the old disk.
            _backfill_worker_files_from_git(workspace_id, git_dir)
        else:
            _init_repo(git_dir)
            logger.info("Initialised fresh git workspace for %s", workspace_id)

    return git_dir


def _backfill_worker_files_from_git(workspace_id: str, git_dir: Path) -> None:
    """After restoring from a bundle on a fresh server, update Supabase
    skill_versions.manifest_json._files for any workers whose _files are
    missing. This ensures workers can execute (E2B reads _files from Supabase)
    even when GitHub is not connected.

    Only updates workers that belong to this workspace and have empty _files.
    Safe to call multiple times — skips workers that already have _files.
    """
    workers_git_dir = git_dir / "workers"
    if not workers_git_dir.is_dir():
        return

    import yaml

    svc = get_supabase_service_client()

    for worker_dir in workers_git_dir.iterdir():
        if not worker_dir.is_dir():
            continue
        worker_id = worker_dir.name
        worker_yml = worker_dir / "worker.yml"
        if not worker_yml.exists():
            continue

        try:
            # Check if this worker has _files in Supabase already
            rows = (
                svc.table("workers")
                .select("skill_version_id")
                .eq("id", worker_id)
                .eq("workspace_id", workspace_id)
                .limit(1)
                .execute()
            )
            if not rows.data or not rows.data[0].get("skill_version_id"):
                continue
            sv_id = rows.data[0]["skill_version_id"]

            sv_rows = (
                svc.table("skill_versions")
                .select("manifest_json")
                .eq("id", sv_id)
                .limit(1)
                .execute()
            )
            if not sv_rows.data:
                continue

            manifest = dict(sv_rows.data[0]["manifest_json"] or {})
            existing_files = manifest.get("_files") or {}
            if existing_files:
                continue  # Already has files — nothing to backfill

            # Read all non-yml files from the git workspace
            files: dict[str, str] = {}
            for fpath in worker_dir.iterdir():
                if fpath.is_file() and fpath.name != "worker.yml":
                    try:
                        files[fpath.name] = fpath.read_text(encoding="utf-8")
                    except Exception:
                        pass

            if not files:
                continue  # Nothing to backfill

            manifest["_files"] = files
            svc.table("skill_versions").update(
                {"manifest_json": manifest}
            ).eq("id", sv_id).execute()
            logger.info(
                "backfill: restored _files for worker %s/%s (%d files)",
                workspace_id, worker_id, len(files),
            )
        except Exception as exc:
            logger.warning(
                "backfill: failed for worker %s/%s: %s", workspace_id, worker_id, exc
            )


# ---------------------------------------------------------------------------
# Remote git operations (provider-agnostic)
# ---------------------------------------------------------------------------

def configure_remote(workspace_id: str, remote_url: str) -> None:
    """Set or replace the origin remote in the workspace git repo.

    remote_url must embed credentials:
      GitHub:    https://{pat}@github.com/{owner}/{repo}.git
      GitLab:    https://oauth2:{token}@gitlab.com/{owner}/{repo}.git
      Bitbucket: https://{user}:{app_password}@bitbucket.org/{owner}/{repo}.git
      Generic:   https://{token}@{host}/{path}.git
    """
    git_dir = ensure_workspace_repo(workspace_id)
    with _get_lock(workspace_id):
        _git(["remote", "remove", "origin"], git_dir, check=False)
        _git(["remote", "add", "origin", remote_url], git_dir)
    logger.info("Configured git remote for workspace %s", workspace_id)


def remove_remote(workspace_id: str) -> None:
    """Remove the origin remote (called on disconnect)."""
    git_dir = get_workspace_git_dir(workspace_id)
    if (git_dir / ".git").exists():
        _git(["remote", "remove", "origin"], git_dir, check=False)


def push_background(workspace_id: str) -> None:
    """Push HEAD to origin in a daemon thread. Silent no-op if no remote configured."""
    git_dir = get_workspace_git_dir(workspace_id)
    if not (git_dir / ".git").exists():
        return

    def _run() -> None:
        try:
            has_remote = _git(["remote", "get-url", "origin"], git_dir, check=False)
            if has_remote.returncode != 0:
                return
            result = _git(["push", "-u", "origin", "HEAD"], git_dir, check=False, timeout=60)
            if result.returncode == 0:
                _stamp_last_pushed(workspace_id)
            else:
                logger.debug("git push failed for %s: %s", workspace_id, result.stderr.strip())
        except Exception as exc:
            logger.debug("push_background failed for %s: %s", workspace_id, exc)

    threading.Thread(
        target=_run, daemon=True, name=f"workeros-git-push-{workspace_id[:8]}"
    ).start()


def _stamp_last_pushed(workspace_id: str) -> None:
    from datetime import datetime, timezone
    try:
        svc = get_supabase_service_client()
        svc.table("git_workspace_config").update(
            {"last_pushed_at": datetime.now(timezone.utc).isoformat()}
        ).eq("workspace_id", workspace_id).execute()
    except Exception as exc:
        logger.debug("_stamp_last_pushed failed: %s", exc)


def commit_and_push_all(workspace_id: str) -> None:
    """Commit all workspace content to local git then push to the configured remote.

    Used on initial remote link to snapshot everything. Runs in a background thread.
    Workers that have already been committed individually are idempotent (git detects
    no change and skips those commits).
    """
    def _run() -> None:
        try:
            svc = get_supabase_service_client()
            msg = "chore: initial workspace snapshot"

            rows = svc.table("workers").select("id").eq("workspace_id", workspace_id).execute()
            for row in (rows.data or []):
                try:
                    commit_workspace(workspace_id, [f"workers/{row['id']}"], msg)
                except Exception as exc:
                    logger.debug("commit_and_push_all: worker %s: %s", row["id"], exc)

            try:
                commit_workspace(
                    workspace_id,
                    ["workspace-tools.yml", "workspace.md", "workspace.base.md"],
                    msg,
                )
            except Exception as exc:
                logger.debug("commit_and_push_all: workspace files: %s", exc)

            push_background(workspace_id)
        except Exception as exc:
            logger.warning("commit_and_push_all failed for %s: %s", workspace_id, exc)

    threading.Thread(
        target=_run, daemon=True, name=f"workeros-git-push-all-{workspace_id[:8]}"
    ).start()


# ---------------------------------------------------------------------------
# Bundle upload
# ---------------------------------------------------------------------------

def _upload_bundle(workspace_id: str) -> None:
    git_dir = get_workspace_git_dir(workspace_id)
    if not (git_dir / ".git").exists():
        return

    # Nothing to bundle if there are no commits yet
    head = _git(["rev-parse", "HEAD"], git_dir, check=False)
    if head.returncode != 0:
        return

    with tempfile.NamedTemporaryFile(suffix=".bundle", delete=False) as f:
        tmp_path = f.name

    try:
        _git(["bundle", "create", tmp_path, "--all"], git_dir, timeout=120)
        with open(tmp_path, "rb") as f:
            bundle_data = f.read()

        svc = get_supabase_service_client()
        storage_path = f"{workspace_id}/repo.bundle"
        try:
            svc.storage.from_(_BUNDLES_BUCKET).upload(
                path=storage_path,
                file=bundle_data,
                file_options={"upsert": "true", "content-type": "application/octet-stream"},
            )
        except Exception:
            svc.storage.from_(_BUNDLES_BUCKET).update(storage_path, bundle_data)

        logger.debug("Uploaded git bundle for %s (%d bytes)", workspace_id, len(bundle_data))
    except Exception as exc:
        logger.warning("Bundle upload failed for %s: %s", workspace_id, exc)
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def upload_bundle_background(workspace_id: str) -> None:
    threading.Thread(
        target=_upload_bundle,
        args=(workspace_id,),
        daemon=True,
        name=f"workeros-git-bundle-{workspace_id[:8]}",
    ).start()


# ---------------------------------------------------------------------------
# Supabase Storage bucket bootstrap
# ---------------------------------------------------------------------------

def ensure_bucket() -> None:
    svc = get_supabase_service_client()
    try:
        svc.storage.create_bucket(
            _BUNDLES_BUCKET,
            options={"public": False},
        )
        logger.info("Created Supabase Storage bucket '%s'", _BUNDLES_BUCKET)
    except Exception as exc:
        if "already exists" in str(exc).lower() or "duplicate" in str(exc).lower():
            return
        logger.warning("Could not create Storage bucket '%s': %s", _BUNDLES_BUCKET, exc)


# ---------------------------------------------------------------------------
# File writers — serialize workspace entities into the local git tree
# ---------------------------------------------------------------------------

def _write_worker(git_dir: Path, workspace_id: str, worker_id: str) -> bool:
    """Fetch worker manifest from Supabase and write to git_dir/workers/{id}/."""
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
        return False
    sv_id = rows.data[0].get("skill_version_id")
    if not sv_id:
        return False

    sv_rows = (
        svc.table("skill_versions")
        .select("manifest_json")
        .eq("id", sv_id)
        .limit(1)
        .execute()
    )
    if not sv_rows.data:
        return False

    manifest: dict = dict(sv_rows.data[0]["manifest_json"] or {})
    files: dict = manifest.pop("_files", {}) or {}

    # Fall back to disk if _files is empty (e.g. freshly imported worker)
    if not files:
        workers_dir_env = (os.environ.get("FLOOM_WORKERS_DIR") or "").strip()
        if workers_dir_env:
            disk_dir = Path(workers_dir_env) / worker_id
            if disk_dir.is_dir():
                for fpath in disk_dir.iterdir():
                    if fpath.is_file() and fpath.name != "worker.yml":
                        try:
                            files[fpath.name] = fpath.read_text(encoding="utf-8")
                        except Exception:
                            pass

    worker_dir = git_dir / "workers" / worker_id
    worker_dir.mkdir(parents=True, exist_ok=True)

    for fname, content in files.items():
        (worker_dir / fname).write_text(content, encoding="utf-8")

    manifest.pop("_files", None)
    yml = yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True)
    (worker_dir / "worker.yml").write_text(yml, encoding="utf-8")
    return True


def _write_context(git_dir: Path, workspace_id: str, context_name: str) -> bool:
    """Copy context files from disk into git_dir/contexts/{name}/."""
    try:
        from apps.api._engine import ensure_engine_api_path
        ensure_engine_api_path()
        from contexts import current_contexts_root  # noqa: PLC0415
        src = current_contexts_root() / context_name
    except Exception:
        return False

    if not src.is_dir():
        return False

    dest = git_dir / "contexts" / context_name
    dest.mkdir(parents=True, exist_ok=True)
    for fpath in src.rglob("*"):
        if not fpath.is_file():
            continue
        rel = fpath.relative_to(src)
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(fpath.read_bytes())
    return True


def _write_workspace_md(git_dir: Path) -> bool:
    try:
        import main as engine_main  # noqa: PLC0415
        workspace_dir = engine_main._git_workspace()
    except Exception:
        return False

    wrote = False
    for fname in ("workspace.md", "workspace.base.md"):
        src = workspace_dir / fname
        if src.is_file():
            (git_dir / fname).write_bytes(src.read_bytes())
            wrote = True
    return wrote


def _write_workspace_tools(git_dir: Path, workspace_id: str) -> bool:
    import yaml

    try:
        svc = get_supabase_service_client()
        rows = svc.table("mcp_tools").select("*").eq("workspace_id", workspace_id).execute()
        doc = {
            "version": 1,
            "tools": [
                {
                    "id": t["id"],
                    "name": t["name"],
                    "worker_id": t["worker_id"],
                    "description": t.get("description") or "",
                }
                for t in (rows.data or [])
            ],
        }
        content = yaml.safe_dump(doc, sort_keys=False, allow_unicode=True)
        (git_dir / "workspace-tools.yml").write_text(content, encoding="utf-8")
        return True
    except Exception as exc:
        logger.debug("_write_workspace_tools failed: %s", exc)
        return False


def _dispatch_write(git_dir: Path, workspace_id: str, rel: str) -> bool:
    """Route a rel_path string to the appropriate write helper."""
    if rel == ".secrets.enc":
        return False  # Secrets never go to git in cloud

    if rel == "workspace-tools.yml":
        return _write_workspace_tools(git_dir, workspace_id)

    if rel in ("workspace.md", "workspace.base.md"):
        return _write_workspace_md(git_dir)

    if rel.startswith("contexts/"):
        context_name = rel.split("/", 2)[1]
        return _write_context(git_dir, workspace_id, context_name)

    if rel.startswith("workers/"):
        worker_id = rel.split("/")[1]
        return _write_worker(git_dir, workspace_id, worker_id)

    # Bare worker_id (cloud passes UUID without prefix in some paths)
    _known = {
        "workspace.md", "workspace.base.md", "workspace-tools.yml",
        ".secrets.enc", ".gitignore",
    }
    if rel not in _known and "/" not in rel:
        return _write_worker(git_dir, workspace_id, rel)

    return False


# ---------------------------------------------------------------------------
# Main commit entry point
# ---------------------------------------------------------------------------

def commit_workspace(workspace_id: str, rel_paths: list[str], message: str) -> Optional[str]:
    """Write changed entities to the workspace git repo and commit.

    Returns the short SHA of the new commit, or None on failure.
    Uploads bundle to Supabase Storage in a background thread after commit.
    """
    git_dir = ensure_workspace_repo(workspace_id)

    with _get_lock(workspace_id):
        wrote_any = False
        for rel in rel_paths:
            try:
                if _dispatch_write(git_dir, workspace_id, rel):
                    wrote_any = True
            except Exception as exc:
                logger.warning("commit_workspace: write failed for %s: %s", rel, exc)

        if not wrote_any:
            return None

        try:
            _git(["add", "-A"], git_dir)
            status = _git(["status", "--porcelain"], git_dir, check=False)
            if not status.stdout.strip():
                head = _git(["rev-parse", "HEAD"], git_dir, check=False)
                return head.stdout.strip()[:7] if head.returncode == 0 else None

            result = _git(
                ["commit", "-m", message, "--author=WorkerOS <workeros@local>"],
                git_dir,
                check=False,
            )
            if result.returncode != 0:
                stderr = result.stderr + result.stdout
                if "nothing to commit" in stderr:
                    head = _git(["rev-parse", "HEAD"], git_dir, check=False)
                    return head.stdout.strip()[:7] if head.returncode == 0 else None
                logger.warning("git commit failed: %s", result.stderr.strip())
                return None

            sha = _git(["rev-parse", "HEAD"], git_dir).stdout.strip()[:7]
            upload_bundle_background(workspace_id)
            return sha
        except Exception as exc:
            logger.warning("commit_workspace: git operations failed: %s", exc)
            return None


# ---------------------------------------------------------------------------
# Post-checkout sync — used by _cloud_checkout_path in startup.py
# ---------------------------------------------------------------------------

def sync_checkout_to_workers(
    workspace_id: str,
    git_dir: Path,
    rel_path: str,
) -> None:
    """After 'git checkout sha -- rel_path', copy files to FLOOM_WORKERS_DIR
    and update Supabase skill_versions so the API reflects the rolled-back version.

    Only handles workers/ paths; context rollback is purely disk-based.
    """
    if not rel_path.startswith("workers/"):
        return

    parts = rel_path.split("/")
    worker_id = parts[1] if len(parts) > 1 else parts[-1]
    src_dir = git_dir / "workers" / worker_id
    if not src_dir.is_dir():
        return

    workers_dir_env = (os.environ.get("FLOOM_WORKERS_DIR") or "").strip()
    workers_dir = Path(workers_dir_env) if workers_dir_env else Path("/opt/workeros-cloud/var/workers")
    dest_dir = workers_dir / worker_id
    dest_dir.mkdir(parents=True, exist_ok=True)

    file_contents: dict[str, str] = {}
    for fpath in src_dir.iterdir():
        if fpath.is_file():
            content = fpath.read_text(encoding="utf-8")
            (dest_dir / fpath.name).write_text(content, encoding="utf-8")
            file_contents[fpath.name] = content

    if "worker.yml" not in file_contents:
        return

    try:
        import yaml  # noqa: PLC0415
        manifest = yaml.safe_load(file_contents["worker.yml"]) or {}
        manifest["_files"] = {k: v for k, v in file_contents.items() if k != "worker.yml"}
        svc = get_supabase_service_client()
        rows = (
            svc.table("workers")
            .select("skill_version_id")
            .eq("id", worker_id)
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
        if rows.data and rows.data[0].get("skill_version_id"):
            sv_id = rows.data[0]["skill_version_id"]
            svc.table("skill_versions").update({"manifest_json": manifest}).eq("id", sv_id).execute()
            logger.info("sync_checkout_to_workers: updated skill_versions sv=%s", sv_id)
    except Exception as exc:
        logger.warning("sync_checkout_to_workers: Supabase update failed (non-fatal): %s", exc)
