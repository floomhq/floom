"""Root pytest config for the WorkerOS backend test suite.

Hermetic isolation guard. The API modules (`main`, `run_service`,
`composio_client`) call `python-dotenv` `load_dotenv()` at import time, which
loads `apps/api/.env` AND the operator's `/root/.config/workeros/api.env`.
The latter holds the PRODUCTION `FLOOM_SECRET` and a `FLOOM_DB` that points at
the live prod database (`../../data/floom.db`, ~605 runs). Without this guard:

  * prod `FLOOM_SECRET` leaks into the test process, defeating every test's
    `os.environ.pop("FLOOM_SECRET")` dev-mode setup (the ~26 `test_api_endpoints`
    failures and friends), and
  * a test that forgets to set `FLOOM_DB` would read/write the PROD database.

`load_dotenv(override=False)` never overrides a key already present in
`os.environ`. So by pinning the dangerous keys to safe values *before* any
test module (and therefore any `main` import) runs, the prod values can never
be injected. This file is imported by pytest before collection, which is
before any `test_*.py` import.
"""

from __future__ import annotations

import os
import tempfile

# 1) Pin the DB to a throwaway temp file so nothing can touch the prod DB even
#    if a test forgets its own override. Individual tests still set their own
#    per-test temp DB; this is the backstop default.
if not os.environ.get("WORKEROS_DB") and not os.environ.get("FLOOM_DB"):
    _suite_db = tempfile.NamedTemporaryFile(prefix="workeros-suite-", suffix=".db", delete=False)
    _suite_db.close()
    os.environ["FLOOM_DB"] = _suite_db.name

# 1b) Pin a throwaway WORKERS/ARTIFACTS dir as the session default so tests that
#     create workers via the API but forget to isolate FLOOM_WORKERS_DIR write
#     into a temp dir instead of polluting the canonical repo `workers/` tree
#     (which made stock-worker tests like test_all_stock_workers_parse non-
#     deterministic and left hundreds of untracked tw*/fb-* dirs behind).
#     Stock-worker tests that genuinely need the real workers/ override this
#     explicitly (os.environ[...] = REPO_ROOT/workers, not setdefault).
_SUITE_WORKSPACE_DIR = os.environ.get("WORKEROS_WORKSPACE_DIR")
_SUITE_WORKERS_DIR = os.environ.get("FLOOM_WORKERS_DIR")
if not _SUITE_WORKERS_DIR:
    _SUITE_WORKSPACE_DIR = tempfile.mkdtemp(prefix="workeros-suite-workspace-")
    _SUITE_WORKERS_DIR = os.path.join(_SUITE_WORKSPACE_DIR, "workers")
    os.makedirs(_SUITE_WORKERS_DIR, exist_ok=True)
    os.environ["FLOOM_WORKERS_DIR"] = _SUITE_WORKERS_DIR
if _SUITE_WORKSPACE_DIR and not os.environ.get("WORKEROS_WORKSPACE_DIR"):
    os.environ["WORKEROS_WORKSPACE_DIR"] = _SUITE_WORKSPACE_DIR
if not os.environ.get("FLOOM_ARTIFACTS_DIR"):
    os.environ["FLOOM_ARTIFACTS_DIR"] = tempfile.mkdtemp(prefix="workeros-suite-artifacts-")

# 1c) Point the operator-secrets .env persistence at a throwaway file. The
#     secrets writer (db.sqlite._upsert_env_var, used by repos.secrets.set) and
#     main._write_env_lines write NAME=value into apps/api/.env by default; in
#     tests that pollutes the checkout's .env with USER_AUDIT_SECRET rows and
#     trips the plaintext-.env pre-commit guard. WORKEROS_API_ENV_FILE is the
#     canonical override both honour.
if not os.environ.get("WORKEROS_API_ENV_FILE") and not os.environ.get("FLOOM_API_ENV_FILE"):
    _suite_env_dir = tempfile.mkdtemp(prefix="workeros-suite-secrets-")
    os.environ["WORKEROS_API_ENV_FILE"] = os.path.join(_suite_env_dir, "api.env")

# 2) Force single-tenant local deploy mode for the suite.
os.environ.setdefault("WORKEROS_DEPLOY", "local")

# 2b) Run-creation tests use tiny temp DB/artifact dirs and must not depend on
#     the host runner's free disk. Dedicated disk-guard tests set their own
#     threshold and still exercise production behavior.
os.environ.setdefault("WORKEROS_MIN_FREE_DISK_BYTES", "0")

# 3) Ensure the prod FLOOM_SECRET from /root/.config/workeros/api.env can never
#    be injected. Presence of this key (even empty) blocks load_dotenv's
#    override=False from setting the real prod value. Empty => local dev mode.
#    Tests that exercise auth set their own FLOOM_SECRET explicitly in setUp.
os.environ.setdefault("FLOOM_SECRET", "")

# 4) Neuter dotenv so file-based secrets can NEVER leak into the test process.
#    main / run_service / composio_client call load_dotenv() at import time,
#    loading apps/api/.env AND /root/.config/workeros/api.env (which holds the
#    prod FLOOM_SECRET + prod FLOOM_DB). The setdefault guard above is defeated
#    the moment a test does `os.environ.pop("FLOOM_SECRET"); import main` — the
#    pop removes the guard and load_dotenv(override=False) then injects the real
#    prod secret (and prod DB path). Patch load_dotenv to drop these sensitive
#    keys from every file load so dev-mode tests stay in dev mode and no test
#    can ever be pointed at the prod DB via dotenv.
_SENSITIVE_DOTENV_KEYS = frozenset({"FLOOM_SECRET", "FLOOM_DB", "WORKEROS_DB", "WORKEROS_USER_ID"})


def _install_dotenv_guard() -> None:
    try:
        import dotenv as _dotenv
        import dotenv.main as _dotenv_main
    except Exception:
        return

    _orig_dotenv_values = _dotenv.dotenv_values

    def _filtered_dotenv_values(*args, **kwargs):
        values = _orig_dotenv_values(*args, **kwargs)
        return {k: v for k, v in values.items() if k not in _SENSITIVE_DOTENV_KEYS}

    def _guarded_load_dotenv(*args, **kwargs):
        # Re-resolve dotenv_values through the patched name and set non-sensitive
        # keys ourselves, honoring override semantics. Returns True like upstream.
        path = kwargs.get("dotenv_path") or (args[0] if args else None)
        override = kwargs.get("override", False)
        try:
            values = _filtered_dotenv_values(dotenv_path=path) if path else _filtered_dotenv_values()
        except Exception:
            return False
        for key, value in values.items():
            if value is None:
                continue
            if override or key not in os.environ:
                os.environ[key] = value
        return True

    for mod in (_dotenv, _dotenv_main):
        if hasattr(mod, "dotenv_values"):
            mod.dotenv_values = _filtered_dotenv_values
        if hasattr(mod, "load_dotenv"):
            mod.load_dotenv = _guarded_load_dotenv


_install_dotenv_guard()


import sys

import pytest


# Env keys that test modules mutate for auth/scope/DB and that, if leaked, break
# subsequently-run modules. Snapshotted and restored around every test.
_VOLATILE_ENV_KEYS = (
    "FLOOM_SECRET",
    "FLOOM_DB",
    "WORKEROS_DB",
    "FLOOM_WORKERS_DIR",
    "FLOOM_ARTIFACTS_DIR",
    "FLOOM_BLOBS_DIR",
    "FLOOM_CONTEXTS_DIR",
    "WORKEROS_DEPLOY",
    "WORKEROS_USER_ID",
    "WORKEROS_ENABLE_USER_HEADER_SCOPE",
    "WORKEROS_PRECLEAR_BACKUP_DIR",
    "WORKEROS_RATE_LIMIT_DEV",
    "WORKEROS_MIN_FREE_DISK_BYTES",
    "WORKEROS_WORKSPACE_DIR",
    "WORKEROS_API_ENV_FILE",
    "FLOOM_API_ENV_FILE",
    "COMPOSIO_API_KEY",
    "OPENAI_API_KEY",
    "ALLOWED_ORIGINS",
    "ALLOWED_ORIGIN_REGEX",
)

# API modules that several test files pop from sys.modules and re-import with a
# per-test temp env (test_round8_worker_authz, test_pr_q_connections_ux,
# test_r5/r7/round6_security, test_s22d_stream, test_s35_queue, ...). When such
# a test does not restore them, the reloaded module objects (bound to a deleted
# temp DB / different scope) leak into modules that imported `main`/`db` at their
# own import time, breaking them. Snapshot + restore the originals around every
# test so each starts from the same module graph.
_API_MODULE_NAMES = (
    "main",
    "db",
    "auth",
    "run_service",
    "models",
    "worker_registry",
    "contexts",
    "chat_service",
    "composio_client",
    "scheduler",
    "files",
)


def _clear_auth_provider_cache() -> None:
    auth_factory = sys.modules.get("auth.factory")
    if auth_factory is not None:
        getter = getattr(auth_factory, "get_auth_provider", None)
        cache_clear = getattr(getter, "cache_clear", None)
        if callable(cache_clear):
            cache_clear()


def _clear_rate_buckets() -> None:
    """Reset the in-process rate-limit buckets between tests.

    `main._rate_buckets` is a module-global dict accumulating request timestamps
    for per-IP/per-user rate limits (e.g. the 20/hour draft-from-prompt cap).
    Across a full suite the bucket fills up and unrelated later tests get a 429
    ("Draft rate limit reached"). Clearing it per test makes limits deterministic.

    The draft rate store moved from main into services.worker_codegen
    (_draft_rate_store), so it is reset there now — same class of state as the
    integrations/uploads caches handled in _clear_router_caches.
    """
    for mod_name, attr in (
        ("main", "_rate_buckets"),
        ("main", "_draft_rate_store"),
        ("services.worker_codegen", "_draft_rate_store"),
    ):
        mod = sys.modules.get(mod_name)
        store = getattr(mod, attr, None)
        if hasattr(store, "clear"):
            store.clear()


def _clear_router_caches() -> None:
    """Reset module-level mutable caches living in routers.* between tests.

    The integrations trigger-catalog cache moved from main (reset by every main
    reload) into routers.integrations (NOT reloaded by most fixtures), so a
    catalog populated by one test would otherwise serve cached 200s to a later
    test expecting the uncached path (e.g. the missing-COMPOSIO_API_KEY 503).
    """
    integrations = sys.modules.get("routers.integrations")
    cache = getattr(integrations, "_trigger_catalog_cache", None)
    if isinstance(cache, dict):
        cache["items"] = None
        cache["expires_at"] = 0.0
    # Same class of state: the upload hourly-quota store moved from main into
    # services.uploads — without this reset, quota consumed by one test would
    # bleed into later tests' caps (e.g. test_r5_security_fixes).
    uploads = sys.modules.get("services.uploads")
    store = getattr(uploads, "_upload_quota_store", None)
    if isinstance(store, dict):
        store.clear()


def _module_pinned_db(request) -> str | None:
    """The DB path a test's module pinned at import via a module-level _tmp_db.

    Many modules do `os.environ["FLOOM_DB"] = _tmp_db.name; db.DB_PATH = ...` at
    import time, expecting that DB for all their tests. But pytest collects every
    module before running any test, and `get_db()` reads FLOOM_DB live, so the
    LAST module collected wins the env for the whole run phase — pointing earlier
    modules' requests at a foreign DB (e.g. `no such table: secrets`). Re-pinning
    per test from the module's own _tmp_db restores correctness.
    """
    mod = getattr(request, "module", None)
    tmp = getattr(mod, "_tmp_db", None)
    name = getattr(tmp, "name", None)
    if isinstance(name, str) and name:
        return name
    return None


@pytest.fixture(autouse=True)
def _isolate_global_state(request):
    """Restore process-global state mutated by reload-heavy test modules.

    Snapshots the volatile env vars and the API entries in sys.modules (plus any
    auth.* / db.* submodules) before each test, then restores them after. This
    contains the cross-module contamination that otherwise made files which pass
    in isolation fail when run together in the full suite.
    """
    env_snapshot = {key: os.environ.get(key) for key in _VOLATILE_ENV_KEYS}

    # Reset FLOOM_WORKERS_DIR to the suite temp default unless the test's module
    # explicitly needs the real repo workers/ dir (stock-worker tests opt in via
    # a module-level `_USE_REAL_WORKERS_DIR = True`). A stock-worker test module
    # sets the env to the real dir at import; without this reset that real path
    # would leak into every later test, re-enabling worker pollution of the repo
    # tree. Tests that set their own per-test workers dir (monkeypatch) override
    # this in their body, which runs after fixture setup.
    mod = getattr(request, "module", None)
    _wants_real = getattr(mod, "_USE_REAL_WORKERS_DIR", False)
    if _wants_real:
        _target_workers_dir = os.environ.get("FLOOM_WORKERS_DIR")
    elif _SUITE_WORKERS_DIR:
        _target_workers_dir = _SUITE_WORKERS_DIR
        os.environ["FLOOM_WORKERS_DIR"] = _SUITE_WORKERS_DIR
        if _SUITE_WORKSPACE_DIR:
            os.environ["WORKEROS_WORKSPACE_DIR"] = _SUITE_WORKSPACE_DIR
    else:
        _target_workers_dir = None
    # worker_registry.WORKERS_DIR is a module global resolved ONCE at import; the
    # API projection helpers read it directly, so an env-only reset is not enough
    # when an earlier module imported worker_registry against a different dir.
    # Re-pin the live module attribute to match the env each test.
    if _target_workers_dir:
        import pathlib as _pathlib
        wr_mod = sys.modules.get("worker_registry")
        if wr_mod is not None and hasattr(wr_mod, "WORKERS_DIR"):
            wr_mod.WORKERS_DIR = _pathlib.Path(_target_workers_dir).resolve()

    # "routers" covers the routers package + routers.* route-group modules: a
    # router module pins the auth.dependency/auth.factory instances it imported
    # at load time, so it must be snapshot/restored IN LOCKSTEP with main/auth —
    # a stale router otherwise routes requests through a previous test file's
    # auth provider (cached FLOOM_SECRET -> spurious 401s).
    tracked_prefixes = ("auth.", "db.", "routers")
    module_snapshot = {}
    for name in list(sys.modules):
        if name in _API_MODULE_NAMES or name.startswith(tracked_prefixes):
            module_snapshot[name] = sys.modules[name]

    # Re-pin this test's module DB so live get_db() reads the DB the module
    # init'd at import, not whatever module was collected last. A stray
    # WORKEROS_DB would take precedence over FLOOM_DB, so clear it too.
    pinned_db = _module_pinned_db(request)
    if pinned_db:
        os.environ.pop("WORKEROS_DB", None)
        os.environ["FLOOM_DB"] = pinned_db
        db_mod = sys.modules.get("db")
        if db_mod is not None and hasattr(db_mod, "DB_PATH"):
            db_mod.DB_PATH = pinned_db
            # The module init'd this DB via `import main` at its own import time,
            # but pytest imports every module during collection and init_db only
            # runs on main's FIRST import — so a module imported after main was
            # already cached ends up with an EMPTY tmp DB (no skill_versions /
            # secrets tables). Re-run the idempotent migrations against the
            # re-pinned DB so the schema is always present at test time.
            init_db = getattr(db_mod, "init_db", None)
            if callable(init_db):
                try:
                    init_db()
                except Exception:
                    pass

    _clear_rate_buckets()
    _clear_router_caches()

    try:
        yield
    finally:
        # Restore sys.modules: re-instate snapshotted modules, drop ones a test
        # newly imported/reloaded that were not present before.
        for name in list(sys.modules):
            if name in _API_MODULE_NAMES or name.startswith(tracked_prefixes):
                if name in module_snapshot:
                    sys.modules[name] = module_snapshot[name]
                else:
                    sys.modules.pop(name, None)
        for name, mod in module_snapshot.items():
            sys.modules[name] = mod

        # Restore env to its pre-test values.
        for key, value in env_snapshot.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

        # Re-pin db.DB_PATH on the restored db module to its snapshotted env so a
        # module-level `client` in another file keeps writing to the right DB.
        db_mod = sys.modules.get("db")
        if db_mod is not None and hasattr(db_mod, "DB_PATH"):
            pinned = os.environ.get("WORKEROS_DB") or os.environ.get("FLOOM_DB")
            if pinned:
                db_mod.DB_PATH = pinned

        _clear_auth_provider_cache()
