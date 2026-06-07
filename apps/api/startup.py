from __future__ import annotations

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

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.supabase_provider import SupabaseAuthProvider
from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api.cloud_workspace_agent import apply_cloud_workspace_agent_overrides
from apps.api.cloud_webhooks import apply_engine_overrides
from apps.api.config import get_cloud_settings
from apps.api.db._secret_crypto import ensure_secret_crypto_ready
from apps.api.db.supabase_repos import (
    SupabaseApprovalRepository,
    SupabaseAssetAccessRepository,
    SupabaseCliAuthRepository,
    SupabaseConnectionRepository,
    SupabaseMcpToolRepository,
    SupabaseRunRepository,
    SupabaseSecretRepository,
    SupabaseWorkerRepository,
)

ensure_engine_api_path()

from auth.factory import register_auth_provider  # noqa: E402
import contexts as engine_contexts  # noqa: E402
import db as engine_db  # noqa: E402
from db import factory as engine_db_factory  # noqa: E402
from db.factory import Repositories, register_repositories  # noqa: E402


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
    from db.sqlite import SqliteAlertRepository  # noqa: PLC0415
    return Repositories(
        workers=SupabaseWorkerRepository(),
        runs=SupabaseRunRepository(),
        connections=SupabaseConnectionRepository(),
        secrets=SupabaseSecretRepository(),
        cli_auth=SupabaseCliAuthRepository(),
        approvals=SupabaseApprovalRepository(),
        alerts=SqliteAlertRepository(),
        asset_access=SupabaseAssetAccessRepository(),
        mcp_tools=SupabaseMcpToolRepository(),
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
    if not hasattr(engine_git_ops, "set_workspace_id_resolver"):
        return  # hook not yet in engine — skip silently
    engine_git_ops.set_workspace_id_resolver(get_active_workspace_id)


def _register_secrets_key_resolver() -> None:
    """Tell the engine to fetch the .secrets.enc key from Supabase Vault (pgsodium).

    In OSS mode the key lives in a GitHub repo Variable (readable via API).
    In cloud, it is a random 32-byte key stored per-workspace in Supabase Vault
    with pgsodium DARE — it never appears in any readable API response.

    Placeholder: the actual Supabase Vault fetch is wired here once the Vault
    schema and per-workspace key provisioning are set up. Until then the
    resolver is not registered and the engine falls back to GitHub Variables
    (still safe for private repos but less secure than Vault).
    """
    try:
        import main as engine_main  # noqa: PLC0415
    except ImportError:
        return
    if not hasattr(engine_main, "set_secrets_key_resolver"):
        return  # engine predates the hook — skip silently

    # TODO: implement get_workspace_secrets_key(workspace_id) that reads from
    # Supabase Vault via pgsodium, then register it here:
    #   engine_main.set_secrets_key_resolver(
    #       lambda: get_workspace_secrets_key(get_active_workspace_id())
    #   )
    # Until that is wired up, leave the resolver unset — OSS fallback (GitHub Variable).


def register_cloud_components() -> None:
    _activate_cloud_deploy()
    get_cloud_settings()
    ensure_secret_crypto_ready()
    _disable_postgrest_http2()
    register_auth_provider("cloud", lambda: SupabaseAuthProvider())
    register_repositories("cloud", _cloud_repositories)
    apply_engine_overrides()
    apply_cloud_workspace_agent_overrides()
    _register_contexts_scope_resolver()
    _register_git_workspace_resolver()
    _register_secrets_key_resolver()
    _override_create_run_for_members()
    _override_worker_author_platform_secret()
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
