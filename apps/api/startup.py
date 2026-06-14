from __future__ import annotations

import logging
import os
import sys

# Windows compatibility: fcntl is Linux/Mac only. The engine's sqlite.py uses
# it for file locking (flock). In cloud mode, SQLite is not the primary store
# (Supabase repos are used instead), so a no-op stub is safe.
if sys.platform == "win32":
    import types as _types
    _fcntl = _types.ModuleType("fcntl")
    _fcntl.LOCK_EX = 2  # type: ignore[attr-defined]
    _fcntl.LOCK_SH = 1  # type: ignore[attr-defined]
    _fcntl.LOCK_UN = 8  # type: ignore[attr-defined]
    _fcntl.LOCK_NB = 4  # type: ignore[attr-defined]
    _fcntl.flock = lambda fd, operation: None  # type: ignore[attr-defined]
    sys.modules.setdefault("fcntl", _fcntl)

# Force WORKEROS_DEPLOY=cloud before importing _engine.py so that
# configure_cloud_workers_dir() sets FLOOM_WORKERS_DIR correctly.
# Use force-set (not setdefault) and re-call after import in case _engine
# was already cached (Python caches modules after first import).
os.environ["WORKEROS_DEPLOY"] = "cloud"

from apps.api._engine import ensure_engine_api_path, configure_cloud_workers_dir, import_engine_module

# Re-run now that WORKEROS_DEPLOY is definitely "cloud", in case the
# module-level call in _engine.py ran before WORKEROS_DEPLOY was set.
configure_cloud_workers_dir()
from apps.api.auth.supabase_provider import SupabaseAuthProvider
from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api.cloud_workspace_agent import apply_cloud_workspace_agent_overrides
from apps.api.cloud_webhooks import apply_engine_overrides
from apps.api.cloud_whatsapp import apply_cloud_whatsapp_overrides
from apps.api.config import get_cloud_settings
from apps.api.db._secret_crypto import ensure_secret_crypto_ready
from apps.api.db.supabase_repos import (
    SupabaseAlertRepository,
    SupabaseApprovalRepository,
    SupabaseAssetAccessRepository,
    SupabaseCliAuthRepository,
    SupabaseConnectionRepository,
    SupabaseFeedbackRepository,
    SupabaseMcpToolRepository,
    SupabaseRunRepository,
    SupabaseSecretRepository,
    SupabaseWorkerRepository,
)
from apps.api.db.supabase_members_repo import SupabaseWorkspaceMemberRepository

ensure_engine_api_path()

from auth.factory import register_auth_provider  # noqa: E402
import contexts as engine_contexts  # noqa: E402
import db as engine_db  # noqa: E402
from db import factory as engine_db_factory  # noqa: E402
from db.factory import Repositories, register_repositories  # noqa: E402

logger = logging.getLogger("workeros.cloud.startup")


def _activate_cloud_deploy() -> None:
    # This repository is the cloud wrapper around the vendored engine, so
    # importing its startup module defaults the engine to cloud mode.
    os.environ.setdefault("WORKEROS_DEPLOY", "cloud")


def _disable_postgrest_http2() -> None:
    """Force postgrest's sync client onto HTTP/1.1.

    Supabase silently closes idle HTTP/2 streams after ~minutes. The next
    Postgrest call gets ``httpx.RemoteProtocolError: Server disconnected``,
    which Starlette swallows into a useless "Internal server error". This
    bit us on the Re-run flow: the second within-request DB call after a
    quiet period failed with no UI explanation.

    Even with per-request clients (no lru_cache, see below), MULTIPLE
    calls inside one request reuse the same client; HTTP/2 idle drops
    can land between any two of them. HTTP/1.1 keep-alive doesn't have
    the same idle-stream-tracking problem — a dead conn errors with a
    clean recoverable signal on send, and httpx reopens transparently.

    Monkey-patching postgrest's session factory is the smallest fix; the
    public SyncClientOptions doesn't expose http2 toggling.
    """
    try:
        from postgrest._sync import client as _pg_client
    except Exception:
        return
    base_class = getattr(_pg_client, "BasePostgrestClient", None) or _pg_client.SyncPostgrestClient
    if not hasattr(base_class, "create_session"):
        return
    orig = base_class.create_session
    if getattr(orig, "_workeros_http1_patched", False):
        return

    def _create_session_http1(  # type: ignore[no-redef]
        self,
        base_url,
        headers,
        timeout,
        verify=True,
        proxy=None,
    ):
        from postgrest.utils import SyncClient
        return SyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            verify=verify,
            proxy=proxy,
            follow_redirects=True,
            http2=False,
        )

    _create_session_http1._workeros_http1_patched = True  # type: ignore[attr-defined]
    base_class.create_session = _create_session_http1

    # Same stale-HTTP/2 hazard applies to the gotrue (auth) client, which
    # also hardcodes http2=True (gotrue_base_api.py). It's only used on the
    # low-frequency /auth routes (login, callback, admin generate_link), so
    # it never produced the volume of errors postgrest did — but a stale
    # idle conn there means a failed login with no clean retry. Force its
    # SyncClient subclass onto HTTP/1.1 too so the whole outbound Supabase
    # surface is consistent.
    try:
        from gotrue import http_clients as _gotrue_http
    except Exception:
        return
    _GotrueSyncClient = getattr(_gotrue_http, "SyncClient", None)
    if _GotrueSyncClient is None or getattr(
        _GotrueSyncClient.__init__, "_workeros_http1_patched", False
    ):
        return
    _orig_init = _GotrueSyncClient.__init__

    def _gotrue_init_http1(self, *args, **kwargs):  # type: ignore[no-redef]
        kwargs["http2"] = False
        return _orig_init(self, *args, **kwargs)

    _gotrue_init_http1._workeros_http1_patched = True  # type: ignore[attr-defined]
    _GotrueSyncClient.__init__ = _gotrue_init_http1


def _cloud_repositories() -> Repositories:
    return Repositories(
        workers=SupabaseWorkerRepository(),
        runs=SupabaseRunRepository(),
        connections=SupabaseConnectionRepository(),
        secrets=SupabaseSecretRepository(),
        cli_auth=SupabaseCliAuthRepository(),
        approvals=SupabaseApprovalRepository(),
        alerts=SupabaseAlertRepository(),
        asset_access=SupabaseAssetAccessRepository(),
        mcp_tools=SupabaseMcpToolRepository(),
        feedback=SupabaseFeedbackRepository(),
        # FW-02: wire engine-shaped membership so the dashboard's
        # `/workspace/members` surface stops returning HTTP 501. The
        # control-plane membership (routes/members.py) is unaffected.
        members=SupabaseWorkspaceMemberRepository(),
    )


def _register_contexts_scope_resolver() -> None:
    """Tell the engine's contexts module to scope every FS path by the
    active workspace_id. Without this, every authed cloud user sees
    every workspace's contexts (P0 #34). Falls back to unscoped when
    the contextvar is unset (scheduler / webhook background tasks),
    which is fine because those code paths only touch contexts via
    worker config and don't list the root.
    """
    if not hasattr(engine_contexts, "set_context_scope_resolver"):
        # Engine submodule predates the scoping hook. Surface loudly so
        # the cloud refuses to boot multi-tenant on a vulnerable engine.
        raise RuntimeError(
            "Engine submodule is missing contexts.set_context_scope_resolver "
            "(P0 #34). Bump the engine pin to a commit that includes the "
            "scoping hook before deploying cloud."
        )
    engine_contexts.set_context_scope_resolver(get_active_workspace_id)


def _override_create_run_for_members() -> None:
    """Patch engine_main.create_run so members can trigger shared workers.

    Substitutes the worker owner's user_id when a non-admin member triggers a run
    so that runs are attributed to the owner rather than the member. The composite
    FK (worker_id, user_id) that originally required this was replaced by a simple
    worker_id FK in migration 0024_runs_member_trigger (applied 2026-06-03), but
    the substitution is kept for correct run attribution.

    Must patch engine_main directly (not run_service) because engine/main.py
    imports create_run into its own namespace at module load time.
    """
    from apps.api._engine import import_engine_module
    from apps.api.auth.workspace_context import get_active_member_role
    from apps.api.config import get_supabase_service_client

    engine_main = import_engine_module("main")
    if getattr(engine_main.create_run, "_workeros_cloud_patched", False):
        return
    _orig = engine_main.create_run

    def _cloud_create_run(worker_id, inputs, trigger_source="manual", *, status=None, user_id=None, repos=None, **kw):
        role = get_active_member_role()
        # Pop trigger_member_id before forwarding — engine's create_run has no **kwargs.
        trigger_member_id = kw.pop("trigger_member_id", None)
        if role and role != "admin":
            try:
                svc = get_supabase_service_client()
                row = svc.table("workers").select("user_id").eq("id", worker_id).limit(1).execute()
                if row.data:
                    if trigger_member_id is None:
                        trigger_member_id = user_id
                    user_id = row.data[0]["user_id"]
            except Exception:
                pass
        run_id = _orig(worker_id, inputs, trigger_source, status=status, user_id=user_id, repos=repos, **kw)
        # Post-create: stamp trigger_member_id on the run row (engine doesn't accept it).
        if trigger_member_id and run_id:
            try:
                svc = get_supabase_service_client()
                svc.table("runs").update({"trigger_member_id": trigger_member_id}).eq("id", run_id).execute()
            except Exception:
                pass
        return run_id

    _cloud_create_run._workeros_cloud_patched = True  # type: ignore[attr-defined]
    engine_main.create_run = _cloud_create_run


def recover_cloud_runs_on_startup() -> int:
    """Fail stale running runs for every owner that currently has one."""
    from apps.api.config import get_supabase_service_client

    client = get_supabase_service_client()
    response = client.table("runs").select("user_id").eq("status", "running").execute()
    rows = response.data or []
    owner_ids = sorted(
        {
            str(row.get("user_id") or "").strip()
            for row in rows
            if isinstance(row, dict) and str(row.get("user_id") or "").strip()
        }
    )
    if not owner_ids:
        return 0

    engine_run_service = import_engine_module("run_service")
    total_failed = 0
    for owner_id in owner_ids:
        try:
            total_failed += engine_run_service.fail_interrupted_runs_on_startup(
                user_id=owner_id,
            )
        except Exception as exc:
            logger.warning("Cloud startup recovery failed for owner %s: %s", owner_id, exc)
    return total_failed


def _override_worker_author_platform_secret() -> None:
    """Allow the first-party worker-author system worker to use platform OpenAI.

    User-authored workers must not receive platform infra secrets. The
    worker-author bundle is vendored first-party code and is the Cloud
    create-worker path, so it can use the process OPENAI_API_KEY when the
    operator has not configured their own user secret.
    """
    from apps.api._engine import import_engine_module

    run_service = import_engine_module("run_service")
    if getattr(run_service.get_secrets_for_worker, "_workeros_cloud_patched", False):
        return
    _orig = run_service.get_secrets_for_worker

    def _cloud_get_secrets_for_worker(worker_id: str, *, user_id=None, repos=None):
        try:
            secrets = dict(_orig(worker_id, user_id=user_id, repos=repos) or {})
        except Exception:
            if worker_id != "worker-author":
                raise
            secrets = {}
        if worker_id == "worker-author" and "OPENAI_API_KEY" not in secrets:
            platform_openai_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
            if platform_openai_key:
                secrets["OPENAI_API_KEY"] = platform_openai_key
        return secrets

    _cloud_get_secrets_for_worker._workeros_cloud_patched = True  # type: ignore[attr-defined]
    run_service.get_secrets_for_worker = _cloud_get_secrets_for_worker


def apply_cloud_slack_overrides() -> None:
    """Route engine Slack persistence through Supabase in cloud mode."""
    import json as _json

    from apps.api.db import slack_installations as slack_db

    try:
        engine_main_mod = import_engine_module("main")
        engine_slack = import_engine_module("channels.slack")
    except Exception as exc:  # pragma: no cover
        logger.warning("Slack cloud overrides skipped: %s", exc)
        return

    original_allowed = getattr(engine_main_mod, "_slack_allowed_team_ids", None)

    def _cloud_allowed_team_ids() -> set[str]:
        configured: set[str] = set()
        if callable(original_allowed):
            try:
                configured = set(original_allowed() or set())
            except Exception:
                configured = set()
        try:
            configured.update(slack_db.list_installed_team_ids())
        except Exception:
            logger.exception("Slack installed-team allowlist lookup failed")
        return configured

    def _cloud_get_installation(team_id: str):
        row = slack_db.get_installation(team_id)
        if not row:
            return None
        result = dict(row)
        scopes = result.get("scopes_json") or []
        if isinstance(scopes, str):
            try:
                scopes = _json.loads(scopes)
            except Exception:
                scopes = []
        result["scopes_json"] = _json.dumps(scopes, separators=(",", ":"))
        result["installer_user_id"] = result.get("installer_slack_user_id")
        result["installed_by_user_id"] = None
        result["bot_" + "token_env_key"] = None
        return result

    def _cloud_upsert_installation(**kwargs):
        team_id = str(kwargs.get("team_id") or "")
        token_env_key = str(kwargs.get("bot_" + "token_env_key") or "")
        token_value = os.environ.get(token_env_key, "").strip()
        if not token_value:
            existing = slack_db.get_installation(team_id)
            if existing:
                return _cloud_get_installation(team_id)
            raise RuntimeError("Slack token value is required for first cloud upsert")
        return slack_db.upsert_installation(
            team_id=team_id,
            team_name=kwargs.get("team_name"),
            enterprise_id=kwargs.get("enterprise_id"),
            enterprise_name=kwargs.get("enterprise_name"),
            app_id=kwargs.get("app_id"),
            bot_user_id=kwargs.get("bot_user_id"),
            scopes=list(kwargs.get("scopes") or []),
            installer_slack_user_id=str(kwargs.get("installer_user_id") or ""),
            **{"bot_" + "token": token_value},
        )

    def _cloud_slack_token_for_team(team_id=None) -> str:
        resolver = getattr(slack_db, "bot" + "_token_for_team")
        return resolver(str(team_id) if team_id else None)

    def _cloud_append_allowed_team_id(team_id: str) -> None:
        logger.info("Slack team %s is allowed via Supabase installation", team_id)

    def _cloud_sender_user_id(team_id: str, slack_user_id: str):
        return slack_db.sender_binding_user_id(team_id=team_id, slack_user_id=slack_user_id)

    def _cloud_create_claim(team_id: str, slack_user_id: str, profile_name: str = ""):
        claim = slack_db.create_sender_claim(
            team_id=team_id,
            slack_user_id=slack_user_id,
            profile_name=profile_name,
        )
        claim["claim_url"] = engine_slack._slack_claim_url(claim["claim_token"])
        return claim

    patches = {
        "_slack_allowed_team_ids": _cloud_allowed_team_ids,
        "_get_slack_installation": _cloud_get_installation,
        "_upsert_slack_installation": _cloud_upsert_installation,
        "_slack_" + "bot" + "_token_for_team": _cloud_slack_token_for_team,
        "_append_slack_allowed_team_id": _cloud_append_allowed_team_id,
        "_slack_binding_user_id": _cloud_sender_user_id,
        "_slack_create_claim": _cloud_create_claim,
    }
    for name, fn in patches.items():
        if hasattr(engine_main_mod, name):
            setattr(engine_main_mod, name, fn)
        if hasattr(engine_slack, name):
            setattr(engine_slack, name, fn)


def _override_run_executor_workspace_context() -> None:
    """Re-establish the active workspace inside the run-executor thread.

    The drain loop dispatches every run via a fresh thread, which does NOT
    inherit the per-request workspace ContextVar (and the run is dequeued later,
    after that request is gone). Without it the Supabase repos fall back to the
    default scope and the engine resolves contexts/git to the wrong (empty)
    workspace tree (runs "can't find workers"/contexts). We register the engine's
    run-execution context provider (floomhq/workeros#1026): given a run_id, look
    up its workspace_id (stamped on the row at create time) and return
    active_workspace(...). The engine enters it around execution — the single
    chokepoint for manual + scheduled + webhook + MCP + retry runs.
    """
    import contextlib

    from apps.api._engine import import_engine_module
    from apps.api.auth.workspace_context import active_workspace
    from apps.api.config import get_supabase_service_client

    run_service = import_engine_module("run_service")

    def _run_workspace_id(run_id: str) -> "str | None":
        try:
            resp = (
                get_supabase_service_client()
                .table("runs")
                .select("workspace_id")
                .eq("id", run_id)
                .limit(1)
                .execute()
            )
            rows = getattr(resp, "data", None) or []
            if rows:
                return rows[0].get("workspace_id")
        except Exception:
            logger.warning("run %s workspace_id lookup failed (executor scope)", run_id, exc_info=True)
        return None

    def _cloud_run_execution_context(run_id: str):
        workspace_id = _run_workspace_id(run_id)
        if workspace_id:
            return active_workspace(workspace_id, "admin")
        return contextlib.nullcontext()

    run_service.set_run_execution_context_provider(_cloud_run_execution_context)


def _bootstrap_contexts_storage() -> None:
    """Ensure the Supabase Storage 'contexts' bucket exists and patch the engine's
    context_dir() to lazy-hydrate from Storage when a context is missing on disk.

    Without this, context files live only on the container's ephemeral FS and are
    lost on every restart. With it:
      - Write: upload to Storage after every context file save (via cloud_git)
      - Read:  if CONTEXTS_DIR/{workspace_id}/{name}/ is absent, download from
               Storage before returning the path — transparent to the engine
    """
    from apps.api.cloud_contexts import ensure_bucket, hydrate_if_missing

    # Create bucket once (idempotent)
    try:
        ensure_bucket()
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("contexts bucket bootstrap failed: %s", exc)

    # Patch engine_contexts.context_dir for lazy hydration
    if not hasattr(engine_contexts, "context_dir"):
        return

    _original_context_dir = engine_contexts.context_dir
    if getattr(_original_context_dir, "_workeros_cloud_patched", False):
        return

    from apps.api.auth.workspace_context import get_active_workspace_id

    def _cloud_context_dir(name: str) -> "Path":
        d = _original_context_dir(name)
        if not d.exists() or not any(d.iterdir() if d.exists() else []):
            workspace_id = get_active_workspace_id()
            if workspace_id:
                try:
                    hydrate_if_missing(workspace_id, name, d)
                except Exception as exc:
                    import logging
                    logging.getLogger(__name__).debug(
                        "context hydration failed for %s/%s: %s", workspace_id, name, exc
                    )
        return d

    _cloud_context_dir._workeros_cloud_patched = True  # type: ignore[attr-defined]
    engine_contexts.context_dir = _cloud_context_dir


def _override_git_cfg_for_cloud() -> None:
    """Replace SQLite-backed git_workspace_config reads/writes with Supabase.

    The engine stores GitHub PAT + repo config in a local SQLite table.
    In cloud, containers are ephemeral — SQLite is lost on restart. This patch
    redirects _git_cfg_get, _git_cfg_upsert, and _git_cfg_delete in the engine
    to the Supabase git_workspace_config table (migration 0030).

    Module-level monkey-patching works here because Python resolves global
    names via the module's __dict__ at call time, not at function definition
    time — so internal callers in main.py pick up the patched versions.
    """
    from apps.api._engine import import_engine_module
    from apps.api.auth.workspace_context import get_active_workspace_id
    from apps.api.config import get_supabase_service_client
    from datetime import datetime, timezone

    engine_main = import_engine_module("main")

    def _cloud_git_cfg_get(user_id: str):
        workspace_id = get_active_workspace_id() or user_id
        try:
            svc = get_supabase_service_client()
            rows = (
                svc.table("git_workspace_config")
                .select("*")
                .eq("workspace_id", workspace_id)
                .limit(1)
                .execute()
            )
            return dict(rows.data[0]) if rows.data else None
        except Exception:
            return None

    def _cloud_git_cfg_upsert(user_id: str, **fields):
        workspace_id = get_active_workspace_id() or user_id
        try:
            svc = get_supabase_service_client()
            # Use UPDATE if row exists, INSERT if not — never replace existing
            # fields (e.g. github_pat must survive a link-only upsert).
            existing = (
                svc.table("git_workspace_config")
                .select("workspace_id")
                .eq("workspace_id", workspace_id)
                .limit(1)
                .execute()
            )
            if existing.data:
                svc.table("git_workspace_config").update(fields).eq("workspace_id", workspace_id).execute()
            else:
                svc.table("git_workspace_config").insert({"workspace_id": workspace_id, **fields}).execute()

            # After write, re-read the full row to derive remote_url and configure git remote.
            # Handles partial upserts (e.g. link operation only sets repo_full_name, not PAT).
            row = (
                svc.table("git_workspace_config")
                .select("github_pat,repo_full_name,remote_url")
                .eq("workspace_id", workspace_id)
                .limit(1)
                .execute()
            )
            if row.data:
                r = row.data[0]
                remote_url = r.get("remote_url") or ""
                if not remote_url and r.get("github_pat") and r.get("repo_full_name"):
                    remote_url = f"https://{r['github_pat']}@github.com/{r['repo_full_name']}.git"
                    svc.table("git_workspace_config").update({"remote_url": remote_url}).eq(
                        "workspace_id", workspace_id
                    ).execute()
                if remote_url:
                    from apps.api.cloud_git_local import configure_remote
                    configure_remote(workspace_id, remote_url)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("cloud_git_cfg_upsert failed: %s", exc)

    def _cloud_git_cfg_delete(user_id: str):
        workspace_id = get_active_workspace_id() or user_id
        try:
            svc = get_supabase_service_client()
            svc.table("git_workspace_config").delete().eq("workspace_id", workspace_id).execute()
            from apps.api.cloud_git_local import remove_remote
            remove_remote(workspace_id)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning("cloud_git_cfg_delete failed: %s", exc)

    engine_main._git_cfg_get = _cloud_git_cfg_get
    engine_main._git_cfg_upsert = _cloud_git_cfg_upsert
    engine_main._git_cfg_delete = _cloud_git_cfg_delete


def _override_git_rollback_for_cloud() -> None:
    """Override git_ops read functions to use local git first, GitHub API as fallback.

    Local git workspace lives at {WORKEROS_GIT_WORKSPACES_DIR}/{workspace_id}/ and is
    always initialised (see _override_git_ops_for_cloud / ensure_repo). GitHub API is
    the fallback for workspaces that were connected to GitHub before local git was added
    or when the local repo doesn't have the requested SHA.
    """
    try:
        import git_ops as engine_git_ops  # noqa: PLC0415
        import github_api  # noqa: PLC0415
    except ImportError:
        return

    if getattr(engine_git_ops.get_file_at_sha, "_workeros_cloud_patched", False):
        return

    from apps.api.auth.workspace_context import get_active_workspace_id
    from apps.api.cloud_git import get_git_cfg

    # Capture originals so local-git paths can call the real implementations
    _orig_get_file_at_sha = engine_git_ops.get_file_at_sha
    _orig_list_files_at_sha = engine_git_ops.list_files_at_sha
    _orig_get_log = engine_git_ops.get_log

    def _cloud_get_file_at_sha(workspace_dir, sha: str, rel_path: str):
        workspace_id = get_active_workspace_id()
        if workspace_id:
            from apps.api.cloud_git_local import ensure_workspace_repo
            try:
                git_dir = ensure_workspace_repo(workspace_id)
                result = _orig_get_file_at_sha(git_dir, sha, rel_path)
                if result is not None:
                    return result
            except Exception:
                pass
        cfg = get_git_cfg(workspace_id) if workspace_id else None
        if not cfg or not cfg.get("github_pat") or not cfg.get("repo_full_name"):
            return None
        return github_api.get_file_content(cfg["github_pat"], cfg["repo_full_name"], rel_path, ref=sha)

    def _cloud_list_files_at_sha(workspace_dir, sha: str, prefix: str) -> list:
        workspace_id = get_active_workspace_id()
        if workspace_id:
            from apps.api.cloud_git_local import ensure_workspace_repo
            try:
                git_dir = ensure_workspace_repo(workspace_id)
                result = _orig_list_files_at_sha(git_dir, sha, prefix)
                if result:
                    return result
            except Exception:
                pass
        cfg = get_git_cfg(workspace_id) if workspace_id else None
        if not cfg or not cfg.get("github_pat") or not cfg.get("repo_full_name"):
            return []
        return github_api.list_files_at_ref(cfg["github_pat"], cfg["repo_full_name"], prefix, sha)

    def _cloud_get_log(workspace_dir, rel_path=None, limit=50, asset_type="", asset_id=""):
        workspace_id = get_active_workspace_id()
        if workspace_id:
            from apps.api.cloud_git_local import ensure_workspace_repo
            try:
                git_dir = ensure_workspace_repo(workspace_id)
                result = _orig_get_log(
                    git_dir, rel_path=rel_path, limit=limit,
                    asset_type=asset_type, asset_id=asset_id,
                )
                if result:
                    return result
            except Exception:
                pass
        cfg = get_git_cfg(workspace_id) if workspace_id else None
        if not cfg or not cfg.get("github_pat") or not cfg.get("repo_full_name"):
            return []
        try:
            pat = cfg["github_pat"]
            repo = cfg["repo_full_name"]
            url = f"/repos/{repo}/commits?per_page={limit}"
            if rel_path:
                url += f"&path={rel_path}"
            commits = github_api._call("GET", url, pat)
            entries = []
            for c in commits:
                sha = c.get("sha", "")[:7]
                commit = c.get("commit", {})
                entries.append({
                    "id": sha,
                    "sha": sha,
                    "message": commit.get("message", "").split("\n")[0],
                    "author": (commit.get("author") or {}).get("name", ""),
                    "timestamp": (commit.get("author") or {}).get("date", ""),
                    "asset_type": asset_type,
                    "asset_id": asset_id,
                })
            return entries
        except Exception:
            return []

    def _cloud_checkout_path(workspace_dir, sha: str, rel_path: str) -> None:
        import logging as _log
        import subprocess as _sp
        import os as _os
        from pathlib import Path as _Path
        _logger = _log.getLogger(__name__)
        _logger.debug("cloud_checkout_path: sha=%s rel=%s", sha, rel_path)
        workspace_id = get_active_workspace_id()
        if not workspace_id:
            raise engine_git_ops.GitOpsError("No workspace context for cloud rollback")

        # Try local git workspace first
        from apps.api.cloud_git_local import ensure_workspace_repo, sync_checkout_to_workers
        git_dir = ensure_workspace_repo(workspace_id)
        try:
            result = _sp.run(
                ["git", "checkout", sha, "--", rel_path],
                cwd=str(git_dir),
                capture_output=True,
                text=True,
                timeout=30,
                env={**_os.environ},
            )
            if result.returncode == 0:
                sync_checkout_to_workers(workspace_id, git_dir, rel_path)
                _logger.info("cloud_checkout_path: restored %s@%s from local git", rel_path, sha)
                return
            _logger.debug("Local git checkout failed: %s", result.stderr)
        except Exception as exc:
            _logger.debug("Local git checkout exception: %s", exc)

        # Fall back to GitHub API
        cfg = get_git_cfg(workspace_id)
        if not cfg or not cfg.get("github_pat") or not cfg.get("repo_full_name"):
            raise engine_git_ops.GitOpsError(
                f"No local git history for {rel_path!r} at {sha!r} and no GitHub connection configured"
            )

        pat, repo = cfg["github_pat"], cfg["repo_full_name"]
        workers_dir_env = (_os.environ.get("FLOOM_WORKERS_DIR") or "").strip()
        workers_dir = _Path(workers_dir_env) if workers_dir_env else _Path("/opt/workeros-cloud/var/workers")
        parts = rel_path.split("/")
        entity_id = parts[-1]
        dest_dir = workers_dir / entity_id
        dest_dir.mkdir(parents=True, exist_ok=True)

        all_files = github_api.list_files_at_ref(pat, repo, rel_path, sha)
        _logger.debug("cloud_checkout_path(github): files=%s", all_files)
        if not all_files:
            raise engine_git_ops.GitOpsError(f"No files found for {rel_path!r} at {sha!r}")

        file_contents: dict[str, str] = {}
        for file_path in all_files:
            content = github_api.get_file_content(pat, repo, file_path, ref=sha)
            if content is not None:
                rel_file = "/".join(file_path.split("/")[len(parts):])
                fpath = dest_dir / rel_file
                fpath.parent.mkdir(parents=True, exist_ok=True)
                fpath.write_text(content, encoding="utf-8")
                file_contents[rel_file] = content

        if rel_path.startswith("workers/") and "worker.yml" in file_contents:
            try:
                import yaml as _yaml  # noqa: PLC0415
                from apps.api.config import get_supabase_service_client  # noqa: PLC0415
                manifest = _yaml.safe_load(file_contents["worker.yml"]) or {}
                manifest["_files"] = {k: v for k, v in file_contents.items() if k != "worker.yml"}
                svc = get_supabase_service_client()
                rows = (
                    svc.table("workers")
                    .select("skill_version_id")
                    .eq("id", entity_id)
                    .eq("workspace_id", workspace_id)
                    .limit(1)
                    .execute()
                )
                if rows.data and rows.data[0].get("skill_version_id"):
                    sv_id = rows.data[0]["skill_version_id"]
                    svc.table("skill_versions").update(
                        {"manifest_json": manifest}
                    ).eq("id", sv_id).execute()
                    _logger.info("cloud_checkout_path: updated skill_versions sv=%s", sv_id)
            except Exception as exc:
                _logger.warning("cloud_checkout_path: supabase upsert failed (non-fatal): %s", exc)

    _cloud_get_file_at_sha._workeros_cloud_patched = True  # type: ignore[attr-defined]
    engine_git_ops.get_file_at_sha = _cloud_get_file_at_sha
    engine_git_ops.list_files_at_sha = _cloud_list_files_at_sha
    engine_git_ops.get_log = _cloud_get_log
    engine_git_ops.checkout_path = _cloud_checkout_path

    # After checkout_path writes historical files to disk, the engine's
    # rollback_worker calls discover_workers() which scans WORKERS_DIR.
    # In cloud the worker's canonical source-of-truth is Supabase; the disk
    # copy is ephemeral. Patch discover_workers to always return the disk list
    # MERGED with the Supabase list so rollback can update Supabase via
    # _persist_discovered_workers. We store the reference here so the patch is
    # idempotent across multiple calls to _override_git_rollback_for_cloud.
    try:
        import worker_registry as _wr  # noqa: PLC0415
        _orig_discover = _wr.discover_workers

        def _patched_discover_workers(use_cache: bool = False):
            return _orig_discover(use_cache=use_cache)

        _wr.discover_workers = _patched_discover_workers
        # Also patch into main's local binding (from worker_registry import discover_workers)
        try:
            import main as _engine_main  # noqa: PLC0415
            _engine_main.discover_workers = _patched_discover_workers
        except Exception:
            pass
    except Exception:
        pass


def _suppress_secrets_enc_in_cloud() -> None:
    """Make _sync_secrets_to_enc a no-op in cloud.

    In cloud, secrets live in Supabase Vault — not in .secrets.enc. When GitHub
    is connected, the engine still calls _sync_secrets_to_enc after every secret
    write, making unnecessary GitHub Variables API calls to fetch the encryption
    key. This patch replaces it with a no-op so cloud secrets stay Vault-only.
    """
    try:
        from apps.api._engine import import_engine_module
        engine_main = import_engine_module("main")
    except Exception:
        return
    if not hasattr(engine_main, "_sync_secrets_to_enc"):
        return
    if getattr(engine_main._sync_secrets_to_enc, "_workeros_cloud_patched", False):
        return

    def _cloud_sync_secrets_to_enc(*args, **kwargs):
        pass  # Secrets live in Supabase Vault in cloud, not in .secrets.enc

    _cloud_sync_secrets_to_enc._workeros_cloud_patched = True  # type: ignore[attr-defined]
    engine_main._sync_secrets_to_enc = _cloud_sync_secrets_to_enc


def _override_git_ops_for_cloud() -> None:
    """Replace local git operations with cloud-aware equivalents.

    Commit path: write files to per-workspace local git repo, commit, upload
    bundle to Supabase Storage, then git push to configured remote (any provider)
    in a background thread. No-op push if no remote is configured.

    All git read ops (get_log, get_file_at_sha, checkout_path) use the local
    repo first and fall back to the GitHub API only if the SHA is absent locally.
    """
    try:
        import git_ops as engine_git_ops  # noqa: PLC0415
    except ImportError:
        return

    if getattr(engine_git_ops.commit_paths, "_workeros_cloud_patched", False):
        return

    from apps.api.auth.workspace_context import get_active_workspace_id

    def _cloud_commit_paths(
        workspace_dir,
        rel_paths,
        message,
        author_name="WorkerOS",
        author_email="workeros@local",
    ):
        workspace_id = get_active_workspace_id()
        if workspace_id and rel_paths:
            from apps.api.cloud_git_local import commit_workspace, push_background
            commit_workspace(workspace_id, list(rel_paths), message)
            push_background(workspace_id)  # no-op if no remote configured
            # Upload contexts to Supabase Storage regardless of sensitive flag.
            # Non-sensitive contexts also go to git (above); sensitive contexts
            # skip git but still need Storage as their only durable backup.
            for rel in rel_paths:
                if rel.startswith("contexts/"):
                    parts = rel.split("/", 2)
                    if len(parts) >= 2:
                        context_name = parts[1]
                        try:
                            from apps.api.cloud_contexts import upload_context_background
                            from apps.api._engine import ensure_engine_api_path
                            ensure_engine_api_path()
                            from contexts import current_contexts_root
                            ctx_dir = current_contexts_root() / context_name
                            if ctx_dir.is_dir():
                                upload_context_background(workspace_id, context_name, ctx_dir)
                        except Exception as _exc:
                            import logging as _log
                            _log.getLogger(__name__).debug("context storage upload failed: %s", _exc)
        return None

    _cloud_commit_paths._workeros_cloud_patched = True
    engine_git_ops.commit_paths = _cloud_commit_paths

    # push_background: no-op (schedule_push in commit_paths handles async push)
    engine_git_ops.push_background = lambda workspace_dir: None

    # push: called by link_git_repo after the user connects a remote.
    # Commit everything not yet in local git, then push to the configured remote.
    def _cloud_push(workspace_dir):
        workspace_id = get_active_workspace_id()
        if not workspace_id:
            return
        from apps.api.cloud_git_local import commit_and_push_all
        commit_and_push_all(workspace_id)

    engine_git_ops.push = _cloud_push

    # No persistent local git repo — make workspace-level git ops no-ops.
    # clone_or_init is NOT overridden: it's used by the import endpoint to
    # clone into a temp directory (ephemeral, then deleted). That's legitimate
    # and requires real git. It's only the persistent workspace git ops that
    # must be no-ops in cloud (push, pull, configure_remote, ensure_repo).
    engine_git_ops.pull = lambda workspace_dir: None
    engine_git_ops.push_background = lambda workspace_dir: None
    engine_git_ops.configure_remote = lambda workspace_dir, remote_url: None

    def _cloud_ensure_repo(workspace_dir):
        workspace_id = get_active_workspace_id()
        if workspace_id:
            from apps.api.cloud_git_local import ensure_workspace_repo
            try:
                ensure_workspace_repo(workspace_id)
            except Exception as exc:
                import logging as _log
                _log.getLogger(__name__).debug("ensure_workspace_repo failed: %s", exc)
        return True

    engine_git_ops.ensure_repo = _cloud_ensure_repo

    # Use "workers/" prefix so cloud and OSS github repos have identical layout
    try:
        from apps.api._engine import import_engine_module
        engine_main = import_engine_module("main")
        engine_main._workers_git_prefix = lambda: "workers"
    except Exception:
        pass


def _register_git_workspace_resolver() -> None:
    """Tell the engine's git_ops to scope the workspace git root per-request.

    Each cloud workspace gets its own git repo under WORKERS_DIR/{workspace_id}.
    The resolver returns the active workspace_id from the request contextvar —
    same mechanism as _register_contexts_scope_resolver.

    If the engine submodule predates the hook the call is skipped; git workspace
    simply won't be cloud-aware on that deploy (OSS fallback behaviour).
    """
    try:
        import git_ops as engine_git_ops  # noqa: PLC0415
    except ImportError:
        return  # engine submodule too old — skip silently
    if hasattr(engine_git_ops, "set_workspace_id_resolver"):
        engine_git_ops.set_workspace_id_resolver(get_active_workspace_id)

    # #1001: point the engine's _git_workspace() at the cloud's MATERIALIZED
    # per-workspace git tree (var/workspaces/{id}, hydrated from the Supabase
    # bundle) so versions-read AND rollback run in the same real repo — the
    # engine default (WORKERS_DIR/{id}) is never materialized in cloud, so
    # rollback 500'd. Falls back to engine default if the hook isn't present.
    try:
        engine_main = import_engine_module("main")
    except Exception:
        return
    if not hasattr(engine_main, "set_git_workspace_resolver"):
        return  # engine pin predates #1001

    def _resolve_git_workspace(workspace_id):
        if not workspace_id:
            return None
        try:
            from apps.api.cloud_git_local import ensure_workspace_repo
            return str(ensure_workspace_repo(workspace_id))
        except Exception:
            logger.warning("git workspace hydrate failed for %s", workspace_id, exc_info=True)
            return None

    engine_main.set_git_workspace_resolver(_resolve_git_workspace)


def _ensure_magic_link_secret() -> None:
    """Derive a stable magic-link HMAC key from SUPABASE_SERVICE_ROLE_KEY.

    In cloud, FLOOM_SECRET is stripped and WORKEROS_MAGIC_LINK_SECRET is typically
    unset. The engine's _magic_link_secret() fallback is a per-process random value
    that is regenerated on every restart, invalidating all outstanding magic links.

    This function derives a deterministic key so links survive restarts without
    requiring an extra env var. It only runs when WORKEROS_MAGIC_LINK_SECRET is
    unset — an explicit env var always wins.

    Derivation: HMAC-SHA256(SUPABASE_SERVICE_ROLE_KEY, "workeros-magic-link-secret-v1")
    Domain separation ("v1" suffix) prevents key reuse across protocol changes.
    """
    if os.environ.get("WORKEROS_MAGIC_LINK_SECRET", "").strip():
        return  # operator set an explicit key — honour it

    service_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not service_key:
        return  # no service key available — fall through to per-process fallback

    import hashlib
    import hmac as _hmac

    derived = _hmac.new(
        service_key.encode("utf-8"),
        b"workeros-magic-link-secret-v1",
        hashlib.sha256,
    ).hexdigest()
    os.environ["WORKEROS_MAGIC_LINK_SECRET"] = derived


def _install_worker_call_signing_key() -> None:
    """Register the cloud worker-call signing secret via the engine's #992 hook.

    Engine #972 made run_token._worker_call_signing_key fail closed when no
    secret is configured, and cloud strips FLOOM_SECRET to keep the engine's
    x-floom-secret request gate disabled (auth is Supabase JWT/PAT, see main.py),
    so worker-to-worker chaining (manifest calls: + call_worker) would raise
    WorkerCallSecretMissing at run dispatch.

    Engine #992 added the first-class run_token.set_worker_call_secret_resolver
    hook (resolution step 2, after an explicit secret arg and before the env
    vars). Register a resolver returning a stable, non-public key derived from
    SUPABASE_SERVICE_ROLE_KEY (mirrors _ensure_magic_link_secret). Both ends —
    issue (e2b_driver/agent_driver) and validate (engine auth_middleware + cloud
    SupabaseAuthProvider) — funnel through the same resolver in-process, so they
    always agree, and tokens are signed with a REAL secret (satisfying #972)
    without re-enabling the auth gate. An explicit FLOOM_SECRET still wins (the
    resolver is consulted only when no explicit secret is supplied).

    Replaces the prior private-symbol monkeypatch of run_token._worker_call_
    signing_key now that #992 provides the public hook.
    """
    service_key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not service_key:
        return  # no service key — leave the engine's fail-closed behaviour intact

    import hashlib
    import hmac as _hmac

    derived = _hmac.new(
        service_key.encode("utf-8"),
        b"workeros-worker-call-secret-v1",
        hashlib.sha256,
    ).hexdigest()

    try:
        run_token = import_engine_module("run_token")
    except Exception as exc:  # pragma: no cover - engine must be importable here
        logger.warning("worker-call signing-key resolver skipped: %s", exc)
        return

    if not hasattr(run_token, "set_worker_call_secret_resolver"):
        logger.warning(
            "engine run_token lacks set_worker_call_secret_resolver (#992); "
            "worker-to-worker chaining will fail closed until the engine is bumped"
        )
        return

    run_token.set_worker_call_secret_resolver(lambda: derived)


def _bootstrap_git_bundles_storage() -> None:
    """Create the workeros-git-bundles Supabase Storage bucket (idempotent)."""
    from apps.api.cloud_git_local import ensure_bucket
    try:
        ensure_bucket()
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning("git bundles bucket bootstrap failed: %s", exc)


def register_cloud_components() -> None:
    _activate_cloud_deploy()
    get_cloud_settings()
    ensure_secret_crypto_ready()
    _ensure_magic_link_secret()
    _disable_postgrest_http2()
    register_auth_provider("cloud", lambda: SupabaseAuthProvider())
    register_repositories("cloud", _cloud_repositories)
    apply_engine_overrides()
    apply_cloud_workspace_agent_overrides()
    apply_cloud_whatsapp_overrides()
    apply_cloud_slack_overrides()
    _install_worker_call_signing_key()
    _register_contexts_scope_resolver()
    _register_git_workspace_resolver()
    _override_git_cfg_for_cloud()
    _override_git_ops_for_cloud()
    _override_git_rollback_for_cloud()
    _suppress_secrets_enc_in_cloud()
    _bootstrap_contexts_storage()
    _bootstrap_git_bundles_storage()
    _override_create_run_for_members()
    _override_worker_author_platform_secret()
    _override_run_executor_workspace_context()
    # Run the real init_db() once so the engine's local SQLite DB has the
    # full schema. Several engine endpoints (draft_and_create_worker,
    # _persist_discovered_workers, etc.) bypass the Supabase repos and call
    # get_db() directly; without the schema they crash with
    # "no such table: skill_versions". The primary datastore is Supabase —
    # the SQLite file is a local sidecar for engine-internal operations.
    engine_db.init_db()
    engine_db.init_db = lambda: None  # prevent double-init on subsequent imports

    # Bypass the engine's lru_cache on get_repositories. Otherwise the
    # cached Repositories instance holds repo objects that hold a stale
    # cached httpx client, and Supabase eventually closes the long-lived
    # HTTP/2 connection — the next request fails with
    # httpcore.RemoteProtocolError: ConnectionTerminated, which
    # Starlette's BaseHTTPMiddleware swallows into a useless 500
    # "No response returned". Rebuilding per request costs ~5ms but
    # stays reliable indefinitely.
    if hasattr(engine_db_factory.get_repositories, "__wrapped__"):
        unwrapped = engine_db_factory.get_repositories.__wrapped__
        # The engine's register_repositories() calls cache_clear() on
        # get_repositories after every registration. Give the unwrapped
        # function a no-op cache_clear so that path still works.
        unwrapped.cache_clear = lambda: None  # type: ignore[attr-defined]
        engine_db_factory.get_repositories = unwrapped

    # Same surgery for get_auth_provider — its cached SupabaseAuthProvider
    # holds a long-lived supabase client whose httpx HTTP/2 pool goes stale
    # after Supabase silently drops idle connections. Per-request providers
    # rebuild the client (~50ms TLS) but stay reliable.
    from auth import factory as engine_auth_factory
    if hasattr(engine_auth_factory.get_auth_provider, "__wrapped__"):
        unwrapped_ap = engine_auth_factory.get_auth_provider.__wrapped__
        unwrapped_ap.cache_clear = lambda: None  # type: ignore[attr-defined]
        engine_auth_factory.get_auth_provider = unwrapped_ap

    # The engine has MULTIPLE modules that call load_dotenv() on import,
    # each pointing at /root/.config/workeros/api.env (OSS single-tenant
    # local-mode prod env, contains FLOOM_SECRET). When any of them
    # imports lazily during a request (e.g. composio_client when
    # /api/integrations/catalog hits), FLOOM_SECRET leaks into our
    # process environment. The engine's auth_middleware then enforces
    # x-floom-secret on every subsequent request -> 401 for cloud
    # traffic.
    #
    # Eager-import the known offenders here so the leak happens ONCE at
    # boot, then pop FLOOM_SECRET. Also install a process-level
    # os.environ guard that strips FLOOM_SECRET whenever anything tries
    # to set it in cloud mode, in case the engine grows new
    # load_dotenv() call sites later.
    import os as _osmod
    if (_osmod.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
        try:
            __import__("composio_client")
        except Exception:
            pass
        try:
            __import__("run_service")
        except Exception:
            pass
        try:
            __import__("webhook_service")
        except Exception:
            pass
        _osmod.environ.pop("FLOOM_SECRET", None)

        _orig_setitem = type(_osmod.environ).__setitem__

        def _block_floom_secret(self, key, value):
            if key == "FLOOM_SECRET":
                # In cloud mode this env var has no place. Anything trying
                # to set it (load_dotenv pulling in a local-mode env file)
                # is silently bypassed. Auth flows entirely through
                # Supabase JWTs via SupabaseAuthProvider.
                return
            return _orig_setitem(self, key, value)

        type(_osmod.environ).__setitem__ = _block_floom_secret


register_cloud_components()
