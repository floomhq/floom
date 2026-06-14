from __future__ import annotations

import json
import os
import hashlib as _hashlib
import sys
import threading as _threading
import time as _time
from contextlib import asynccontextmanager
from typing import Any

# Windows compatibility: inject fcntl stub BEFORE any engine module imports.
# fcntl is Linux/Mac only; the engine's sqlite.py uses it for file locking.
# Cloud mode uses Supabase repos, so a no-op stub is safe here.
if sys.platform == "win32":
    import types as _types
    _fcntl = _types.ModuleType("fcntl")
    _fcntl.LOCK_EX = 2  # type: ignore[attr-defined]
    _fcntl.LOCK_SH = 1  # type: ignore[attr-defined]
    _fcntl.LOCK_UN = 8  # type: ignore[attr-defined]
    _fcntl.LOCK_NB = 4  # type: ignore[attr-defined]
    _fcntl.flock = lambda fd, operation: None  # type: ignore[attr-defined]
    sys.modules.setdefault("fcntl", _fcntl)

from pathlib import Path as _Path

# Set FLOOM_WORKERS_DIR before ANY engine module imports.
# run_service.py does `from worker_registry import WORKERS_DIR` at module level;
# WORKERS_DIR is a module-level constant that is evaluated at import time from
# FLOOM_WORKERS_DIR. If FLOOM_WORKERS_DIR isn't set correctly before run_service
# is imported, every subsequent disk-based worker lookup uses the wrong directory.
os.environ["WORKEROS_DEPLOY"] = "cloud"
_custom_wd = (os.environ.get("WORKEROS_WORKERS_DIR") or "").strip()
os.environ.setdefault(
    "FLOOM_WORKERS_DIR",
    _custom_wd or str(_Path(__file__).resolve().parents[2] / "engine" / "workers"),
)

from fastapi import FastAPI, HTTPException, Query, Request

from apps.api.cloud_scheduler import start_cloud_scheduler, stop_cloud_scheduler
from apps.api.cloud_webhooks import verify_webhook_token
from apps.api._engine import import_engine_module
import apps.api.startup as cloud_startup

engine_run_service = import_engine_module("run_service")
from apps.api.routes.auth import router as auth_router
from apps.api.routes.cli_auth_devices import router as cli_auth_devices_router
from apps.api.routes.members import router as members_router
from apps.api.routes.novasearch import router as novasearch_router
from apps.api.routes.slack_events import router as slack_events_router
from apps.api.routes.slack_oauth import router as slack_oauth_router
from apps.api.routes.telemetry import router as telemetry_router
from apps.api.routes.workspace_agent import router as workspace_agent_router
from apps.api.routes.workspaces import router as workspaces_router

engine_main = import_engine_module("main")

# The engine's main.py auto-loads /root/.config/workeros/api.env via load_dotenv()
# on import. That file is the OSS single-tenant local-mode prod env and contains
# FLOOM_SECRET. When loaded into our cloud process, the engine's auth_middleware
# (which gates every request behind x-floom-secret when FLOOM_SECRET is set)
# rejects all our JWT-authed cloud traffic with 401. Strip it in cloud mode.
if (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
    os.environ.setdefault("WORKEROS_RATE_LIMIT_DEV", "1")
    os.environ.pop("FLOOM_SECRET", None)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
        db_host = (os.environ.get("WORKEROS_CLOUD_DB_HOST") or "").strip()
        if not db_host:
            # No DB configured — start scheduler without advisory lock.
            # Safe for single-instance deployments; set WORKEROS_CLOUD_DB_*
            # if running multiple instances to prevent duplicate cron runs.
            import logging as _logging
            _logging.getLogger("workeros.cloud").warning(
                "WORKEROS_CLOUD_DB_HOST not set — starting scheduler without "
                "advisory lock. Safe for single-instance deployments only."
            )
            from apps.api._engine import import_engine_module as _ie
            _ie("scheduler").start_scheduler()
        elif not start_cloud_scheduler():
            raise RuntimeError("Cloud scheduler advisory lock is already held.")
        # Start the run drain loop — picks up queued runs and dispatches them
        # to E2B. The engine only starts this in local mode; cloud must do it
        # explicitly here.
        engine_run_service.start_drain_loop()
        engine_run_service.re_enqueue_queued_runs_on_startup()
        recovered = cloud_startup.recover_cloud_runs_on_startup()
        if recovered:
            import logging as _logging
            _logging.getLogger("workeros.cloud").info(
                "Cloud startup recovery marked %d interrupted run(s) as failed.",
                recovered,
            )
    try:
        yield
    finally:
        if (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
            engine_run_service.stop_drain_loop(timeout=5.0)
            stop_cloud_scheduler()


# Interactive API docs + the raw OpenAPI schema are disabled by default so
# they are never exposed unauthenticated in prod (they leak the full route
# surface, models, and auth shapes). Set WORKEROS_ENABLE_DOCS=1 to re-enable
# them locally for development.
_docs_enabled = (os.environ.get("WORKEROS_ENABLE_DOCS") or "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

app = FastAPI(
    title="workeros-cloud API",
    version="0.1.0",
    description="Supabase-backed wrapper around the workeros OSS API engine.",
    lifespan=lifespan,
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
)


import re as _re
# Worker path across ALL engine mount prefixes (/, /v1, /api, /api/v1) — the
# engine app is mounted at each (see app.mount calls below), so guarding only
# /api/workers left bare /workers/{id} as an isolation bypass.
_RE_WORKER_PATH = _re.compile(r"^(?:/api/v1|/v1|/api)?/workers/([^/]+)(/.*)?$")

_CLOUD_RATE_LIMIT_RULES: list[tuple[tuple[str, ...] | None, _re.Pattern[str], int, float]] = [
    (None, _re.compile(r"^/auth/(?:password-login|password-signup|login|fragment-session|cli-exchange|cli-approve|cli-deny)$"), 5, 60.0),
    (("POST",), _re.compile(r"^/api/cli-auth/devices$"), 5, 60.0),
    (("POST", "DELETE"), _re.compile(r"^/auth/tokens(?:/.*)?$"), 20, 60.0),
    (("POST", "PATCH", "DELETE"), _re.compile(r"^/api/workspaces(?:/.*)?$"), 60, 60.0),
    (("POST",), _re.compile(r"^/api/novasearch(?:/.*)?$"), 30, 60.0),
]
_cloud_rate_lock = _threading.Lock()
_cloud_rate_buckets: dict[str, list[float]] = {}


def _cloud_client_ip(request: Request) -> str:
    cf_ip = (request.headers.get("cf-connecting-ip") or "").strip()
    if cf_ip:
        return cf_ip
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip
    return request.client.host if request.client else "unknown"


def _cloud_rate_identity(request: Request) -> str:
    pat = (request.headers.get("x-floom-token") or "").strip()
    if pat:
        return "x-floom-token:" + _hashlib.sha256(pat.encode()).hexdigest()
    authorization = (request.headers.get("authorization") or "").strip()
    parts = authorization.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer" and parts[1].strip():
        return "bearer:" + _hashlib.sha256(parts[1].strip().encode()).hexdigest()
    return f"ip:{_cloud_client_ip(request)}"


def _cloud_rate_limit_for_request(request: Request) -> tuple[int, float] | None:
    method = request.method.upper()
    path = request.url.path.rstrip("/") or "/"
    for methods, pattern, limit, window in _CLOUD_RATE_LIMIT_RULES:
        if methods is not None and method not in methods:
            continue
        if pattern.fullmatch(path):
            return limit, window
    return None


@app.middleware("http")
async def cloud_rate_limit_middleware(request: Request, call_next):
    config = _cloud_rate_limit_for_request(request)
    if config is None:
        return await call_next(request)
    limit, window = config
    if limit <= 0:
        return await call_next(request)

    now = _time.monotonic()
    key = f"{_cloud_rate_identity(request)}:{request.method.upper()}:{request.url.path.rstrip('/') or '/'}"
    with _cloud_rate_lock:
        bucket = [ts for ts in _cloud_rate_buckets.get(key, []) if ts > now - window]
        if len(bucket) >= limit:
            retry_after = max(1, int((bucket[0] + window) - now))
            from fastapi.responses import JSONResponse as _JSONResponse

            return _JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded"},
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)
        _cloud_rate_buckets[key] = bucket

    return await call_next(request)


def _is_owner_only_worker_write(method: str, suffix: str) -> bool:
    """True for worker mutations that only the owner / workspace admin may do.

    Deliberately EXCLUDES member-permitted actions on shared workers (runs,
    feedback, request-edit) — those are gated by their own per-action rules.
    """
    suffix = suffix or ""
    if method in ("PATCH", "DELETE") and suffix == "":
        return True  # edit fields / delete the worker
    if method == "PUT" and suffix == "/files":
        return True  # replace the worker's code/manifest
    if method == "PATCH" and suffix == "/visibility":
        return True
    if method == "POST" and suffix in ("/archive", "/restore"):
        return True
    if method == "POST" and suffix.startswith("/rollback/"):
        return True
    return False


@app.middleware("http")
async def member_write_guard(request: Request, call_next):
    """Block non-owner members from mutating a worker they don't own.

    Resolves the caller via the same SupabaseAuthProvider the routes use, so it
    works for every auth method (x-floom-token, Bearer floom_ PAT, Supabase JWT)
    and every mount prefix — not just PAT-on-/api as before. Workspace owners and
    promoted admins are allowed; non-owner members get 403. Never blocks when
    auth can't be resolved (the route's own auth returns the proper 401).
    """
    import asyncio as _asyncio
    if request.method in ("DELETE", "PATCH", "PUT", "POST"):
        m = _RE_WORKER_PATH.match(request.url.path)
        if m and _is_owner_only_worker_write(request.method, m.group(2) or ""):
            worker_id = m.group(1)
            try:
                from apps.api.auth.supabase_provider import SupabaseAuthProvider
                from apps.api.auth.workspace_context import (
                    get_active_member_role,
                    get_active_workspace_id,
                )

                auth = await SupabaseAuthProvider().verify(request)
                user_id = getattr(auth, "user_id", None)
                role = get_active_member_role()
                workspace_id = get_active_workspace_id()
            except Exception:
                return await call_next(request)  # let the route's auth handle it

            # Workspace owner / promoted admin may mutate anything in the workspace.
            if user_id and workspace_id and role != "admin":
                def _owns() -> bool:
                    from apps.api.config import get_supabase_service_client
                    svc = get_supabase_service_client()
                    w = (
                        svc.table("workers")
                        .select("user_id")
                        .eq("id", worker_id)
                        .eq("workspace_id", workspace_id)
                        .limit(1)
                        .execute()
                    )
                    if not w.data:
                        return True  # not in this workspace — let the route 404
                    return str(w.data[0].get("user_id")) == str(user_id)

                try:
                    if not await _asyncio.to_thread(_owns):
                        from fastapi.responses import JSONResponse as _JSONResponse
                        return _JSONResponse(
                            status_code=403,
                            content={"detail": "You do not have edit access to this worker."},
                        )
                except Exception:
                    pass  # never hard-fail the request on guard error

    return await call_next(request)


# Cache user_id → email to avoid repeated auth.admin.get_user_by_id() calls.
# Emails essentially never change; 10-minute TTL is safe.
_email_cache: dict[str, tuple[str, float]] = {}
_EMAIL_CACHE_TTL = 600.0


def _resolve_email_cached(svc: Any, user_id: str) -> str | None:
    now = _time.monotonic()
    cached = _email_cache.get(user_id)
    if cached and (now - cached[1]) < _EMAIL_CACHE_TTL:
        return cached[0]
    try:
        resp = svc.auth.admin.get_user_by_id(user_id)
        if resp and resp.user and resp.user.email:
            email: str = resp.user.email
            _email_cache[user_id] = (email, now)
            return email
    except Exception:
        pass
    return None


@app.middleware("http")
async def runs_trigger_member_middleware(request: Request, call_next):
    """Inject trigger_member_id and trigger_member_email into run responses.

    The engine's run response model doesn't include these cloud-only fields.
    This middleware post-processes GET /api/runs/{id} and GET /api/runs list
    responses to surface member attribution.
    """
    import asyncio as _asyncio2
    import json as _json2
    import re as _re2

    path = request.url.path.rstrip("/")
    is_run_detail = request.method == "GET" and bool(_re2.match(r"^/api/runs/[^/]+$", path))
    is_runs_list = request.method == "GET" and path in ("/api/runs", "/runs")
    if not (is_run_detail or is_runs_list):
        return await call_next(request)

    response = await call_next(request)
    if not (200 <= response.status_code < 300):
        return response

    body = b""
    async for chunk in response.body_iterator:
        body += chunk

    try:
        data = _json2.loads(body)
        items = [data] if is_run_detail and isinstance(data, dict) else (data if isinstance(data, list) else [])
        run_ids = [r["id"] for r in items if isinstance(r, dict) and r.get("id")]
        if run_ids:
            def _fetch_run_members():
                from apps.api.config import get_supabase_service_client
                svc = get_supabase_service_client()
                rows = svc.table("runs").select("id,trigger_member_id").in_("id", run_ids).execute()
                id_to_mid = {r["id"]: r.get("trigger_member_id") for r in (rows.data or []) if r.get("trigger_member_id")}
                if not id_to_mid:
                    return {}
                member_ids = list(set(id_to_mid.values()))
                email_map: dict[str, str] = {}
                for mid in member_ids:
                    email = _resolve_email_cached(svc, mid)
                    if email:
                        email_map[mid] = email
                return {run_id: {"trigger_member_id": mid, "trigger_member_email": email_map.get(mid)} for run_id, mid in id_to_mid.items()}

            enrichment = await _asyncio2.to_thread(_fetch_run_members)
            if enrichment:
                if is_run_detail and isinstance(data, dict):
                    meta = enrichment.get(data.get("id", ""), {})
                    data.update(meta)
                else:
                    for item in data:
                        if isinstance(item, dict):
                            item.update(enrichment.get(item.get("id", ""), {}))
                body = _json2.dumps(data).encode()
    except Exception:
        pass

    from starlette.responses import Response as _StResponse2
    return _StResponse2(content=body, status_code=response.status_code, media_type="application/json")


@app.middleware("http")
async def workers_list_visibility_middleware(request: Request, call_next):
    """Inject visibility into workers list API responses.

    The engine's WorkerSummary Pydantic model doesn't include visibility (it's
    a cloud concept). The Supabase repo already fetches it; this middleware
    post-processes the list response to surface it so the frontend badge works.
    Only activates on GET /api/workers or GET /workers (list, not detail).
    """
    import asyncio as _asyncio
    import json as _json

    path = request.url.path.rstrip("/")
    is_list = request.method == "GET" and path in ("/api/workers", "/workers")
    if not is_list:
        return await call_next(request)

    response = await call_next(request)
    if not (200 <= response.status_code < 300):
        return response

    body = b""
    async for chunk in response.body_iterator:
        body += chunk

    try:
        data = _json.loads(body)
        if isinstance(data, list) and data:
            worker_ids = [w["id"] for w in data if isinstance(w, dict) and w.get("id")]
            if worker_ids:
                def _fetch_vis():
                    from apps.api.config import get_supabase_service_client
                    svc = get_supabase_service_client()
                    rows = svc.table("workers").select("id,visibility,user_id").in_("id", worker_ids).execute()
                    return {r["id"]: {"visibility": r.get("visibility") or "private", "owner_id": r.get("user_id")} for r in (rows.data or [])}

                vis_map = await _asyncio.to_thread(_fetch_vis)
                for w in data:
                    if isinstance(w, dict) and w.get("id"):
                        meta = vis_map.get(w["id"], {})
                        w["visibility"] = meta.get("visibility", "private")
                        w["owner_id"] = meta.get("owner_id")
                body = _json.dumps(data).encode()
    except Exception:
        pass

    from starlette.responses import Response as _StResponse
    return _StResponse(content=body, status_code=response.status_code, media_type="application/json")


@app.middleware("http")
async def cloud_security_headers_middleware(request: Request, call_next):
    """Keep cloud-owned routes on the same security-header baseline as engine routes."""
    response = await call_next(request)
    response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy",
        "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    )
    response.headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
    return response


app.include_router(auth_router)
# Mount workspaces + cli-auth/devices under /api BEFORE the engine sub-app
# mount; otherwise FastAPI's path matching dispatches /api/workspaces (and
# /api/cli-auth/devices) into the engine. The engine handler for
# /cli-auth/devices calls _bootstrap_user_id()="federico" which fails the
# UUID FK on public.cli_auth_devices.user_id; the cloud override below mints
# the row with user_id=NULL and lets /auth/cli-approve claim it later.
app.include_router(workspaces_router, prefix="/api")
app.include_router(members_router, prefix="/api")
app.include_router(cli_auth_devices_router, prefix="/api")
app.include_router(telemetry_router, prefix="/api")
app.include_router(novasearch_router, prefix="/api")
app.include_router(workspace_agent_router, prefix="/api")
app.include_router(slack_events_router, prefix="/api")
app.include_router(slack_oauth_router)


def _cloud_persist_worker_files(worker_id: str, files: dict, repos: Any) -> None:
    """Save worker file contents to Supabase manifest_json._files.

    Called after any worker creation or file update so Supabase is always
    the authoritative source of worker code in cloud mode. Railway's disk
    is ephemeral; this ensures files survive restarts.
    """
    import json as _json
    from apps.api.config import get_supabase_service_client
    updated_worker = repos.workers.get_any(worker_id=worker_id) or {}
    sv_id = (updated_worker.get("skill_version_id") or "").strip()
    if not sv_id:
        return
    svc = get_supabase_service_client()
    sv_resp = svc.table("skill_versions").select("manifest_json").eq("id", sv_id).limit(1).execute()
    sv_rows = sv_resp.data or []
    raw_mj = sv_rows[0].get("manifest_json") if sv_rows else {}
    manifest_json = raw_mj if isinstance(raw_mj, dict) else (_json.loads(raw_mj) if isinstance(raw_mj, str) else {})
    manifest_json.pop("_files", None)
    manifest_json["_files"] = _sanitize_cloud_worker_files(files)
    svc.table("skill_versions").update({"manifest_json": manifest_json}).eq("id", sv_id).execute()


def _validate_cloud_worker_file_path(path: str) -> str:
    path = path.strip()
    if not path:
        raise HTTPException(status_code=400, detail="file path must not be empty")
    candidate = _Path(path)
    if candidate.is_absolute() or "\\" in path:
        raise HTTPException(status_code=400, detail=f"file path must be relative: {path!r}")
    parts = candidate.parts
    if any(part in ("", ".", "..") or part.startswith(".") for part in parts):
        raise HTTPException(status_code=400, detail=f"file path contains invalid segment: {path!r}")
    normalized = candidate.as_posix()
    if normalized.startswith("../") or "/../" in normalized:
        raise HTTPException(status_code=400, detail=f"file path contains traversal: {path!r}")
    return normalized


def _sanitize_cloud_worker_files(files: dict) -> dict[str, str]:
    sanitized: dict[str, str] = {}
    for raw_path, raw_content in files.items():
        safe_path = _validate_cloud_worker_file_path(str(raw_path))
        if safe_path in sanitized:
            raise HTTPException(status_code=400, detail=f"duplicate file path: {safe_path!r}")
        if not isinstance(raw_content, str):
            raise HTTPException(status_code=400, detail=f"file content must be text: {safe_path!r}")
        sanitized[safe_path] = raw_content
    return sanitized


def _read_worker_files_from_disk(worker_id: str) -> dict:
    """Read all worker source files from WORKERS_DIR/{worker_id}/."""
    from pathlib import Path as _Path
    workers_dir_env = (os.environ.get("FLOOM_WORKERS_DIR") or "").strip()
    workers_dir = _Path(workers_dir_env) if workers_dir_env else _Path("/opt/workeros-cloud/var/workers")
    worker_dir = workers_dir / worker_id
    if not worker_dir.is_dir():
        return {}
    files = {}
    for fpath in sorted(worker_dir.iterdir()):
        if fpath.is_file() and not fpath.name.startswith(".") and not fpath.name.endswith(".bak"):
            try:
                files[fpath.name] = fpath.read_text(encoding="utf-8")
            except Exception:
                pass
    return files


@app.post("/workers")
@app.post("/api/workers")
async def cloud_create_worker(
    payload: engine_main.WorkerCreateRequest,
    request: Request,
) -> Any:
    """Cloud override for POST /workers.

    Delegates to the engine handler (which writes files to disk and registers
    the worker in DB), then persists file contents to Supabase manifest_json._files
    so worker code survives Railway restarts.
    """
    import asyncio as _asyncio

    from apps.api.auth.supabase_provider import SupabaseAuthProvider
    from auth.context import AuthContext as _AuthContext

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    repos = engine_main.get_repositories()
    engine_auth = _AuthContext(
        user_id=auth.user_id,
        email=getattr(auth, "email", None),
        scopes=getattr(auth, "scopes", ()),
        # SECURITY (A-03): carry the verified role/auth_method. The engine
        # AuthContext.role defaults to "admin", so rebuilding it from only
        # user_id/email/scopes would silently re-grant admin to a member and
        # defeat the SupabaseAuthProvider role fix. Fail closed to "member".
        role=getattr(auth, "role", None) or "member",
        auth_method=getattr(auth, "auth_method", "secret"),
    )

    # Engine creates the worker: validates YAML, writes to disk, registers in DB.
    # Engine's create_worker signature is (payload, request, auth, repos); the
    # request carries the x-workeros-workspace header the engine now requires for
    # worker writes (matches cloud_draft_and_create above).
    result = await _asyncio.to_thread(engine_main.create_worker, payload, request, engine_auth, repos)

    # Persist files to Supabase — source of truth in cloud (Railway disk is ephemeral)
    files = _read_worker_files_from_disk(result.id)
    if not files:
        # Fallback: use payload directly if disk read misses something
        files = {"worker.yml": payload.worker_yml, "run.py": payload.run_py}
        if payload.skill_md:
            files["SKILL.md"] = payload.skill_md
    _cloud_persist_worker_files(result.id, files, repos)

    return result


@app.post("/workers/draft-and-create")
@app.post("/api/workers/draft-and-create")
async def cloud_draft_and_create(
    payload: engine_main.DraftAndCreateRequest,
    request: Request,
) -> Any:
    """Cloud override for POST /workers/draft-and-create.

    Delegates to the engine handler then persists the generated file contents
    to Supabase manifest_json._files so worker code survives Railway restarts.
    """
    from apps.api.auth.supabase_provider import SupabaseAuthProvider
    from auth.context import AuthContext as _AuthContext

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    repos = engine_main.get_repositories()
    engine_auth = _AuthContext(
        user_id=auth.user_id,
        email=getattr(auth, "email", None),
        scopes=getattr(auth, "scopes", ()),
        # SECURITY (A-03): carry the verified role/auth_method. The engine
        # AuthContext.role defaults to "admin", so rebuilding it from only
        # user_id/email/scopes would silently re-grant admin to a member and
        # defeat the SupabaseAuthProvider role fix. Fail closed to "member".
        role=getattr(auth, "role", None) or "member",
        auth_method=getattr(auth, "auth_method", "secret"),
    )
    result = await engine_main.draft_and_create_worker(payload, request, engine_auth, repos)

    # Save files to Supabase right after engine writes them to disk
    files = _read_worker_files_from_disk(result.worker_id)
    if files:
        _cloud_persist_worker_files(result.worker_id, files, repos)

    return result


@app.put("/workers/{worker_id}/files")
@app.put("/api/workers/{worker_id}/files")
async def cloud_update_worker_files(worker_id: str, request: Request) -> Any:
    """Cloud override for PUT /workers/{id}/files.

    Delegates to the engine handler — which writes the files atomically, commits
    a git version so /workers/{id}/versions reflects the edit, and owner-gates
    the write — then persists file contents to Supabase manifest_json._files so
    worker code survives Railway restarts.

    Previously this reimplemented the file write and SKIPPED the version commit,
    which froze /versions at the create baseline (edits never produced a new
    version). Delegating to engine_main.update_worker_files restores versioning
    and the member-isolation authz, mirroring cloud_create_worker.
    """
    import asyncio as _asyncio

    from apps.api.auth.supabase_provider import SupabaseAuthProvider

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    files_list = body.get("files") or []
    if not files_list:
        raise HTTPException(status_code=400, detail="files list must not be empty")
    files = _sanitize_cloud_worker_files(
        {f["path"]: f["content"] for f in files_list if "path" in f and "content" in f}
    )

    try:
        import yaml as _yaml
        manifest = _yaml.safe_load(files.get("worker.yml", ""))
        if not isinstance(manifest, dict):
            raise ValueError("worker.yml did not parse to a dict")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid worker.yml: {exc}") from exc

    repos = engine_main.get_repositories()
    from auth.context import AuthContext as _AuthContext
    engine_auth = _AuthContext(
        user_id=auth.user_id,
        email=getattr(auth, "email", None),
        scopes=getattr(auth, "scopes", ()),
        # SECURITY (A-03): carry the verified role/auth_method. The engine
        # AuthContext.role defaults to "admin", so rebuilding it from only
        # user_id/email/scopes would silently re-grant admin to a member and
        # defeat the SupabaseAuthProvider role fix. Fail closed to "member".
        role=getattr(auth, "role", None) or "member",
        auth_method=getattr(auth, "auth_method", "secret"),
    )
    payload = engine_main.WorkerFilesUpdateRequest(
        files=[
            engine_main.WorkerFilePatch(path=path, content=content)
            for path, content in files.items()
        ]
    )

    # Engine writes the files atomically AND commits a git version (so
    # /versions reflects the edit), with owner-gated authz.
    result = await _asyncio.to_thread(
        engine_main.update_worker_files, worker_id, payload, request, engine_auth, repos
    )

    # Persist file contents to Supabase — source of truth in cloud.
    _cloud_persist_worker_files(worker_id, files, repos)
    return result


@app.get("/workers/{worker_id}")
@app.get("/api/workers/{worker_id}")
async def cloud_get_worker(worker_id: str, request: Request) -> Any:
    """Cloud override for GET /workers/{id}.

    Delegates to the engine's _build_worker_detail then augments the response
    with cloud-only fields: visibility and published_at (from Supabase).
    """
    import asyncio as _asyncio

    from apps.api.auth.supabase_provider import SupabaseAuthProvider
    from auth.context import AuthContext as _AuthContext

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    repos = engine_main.get_repositories()
    engine_auth = _AuthContext(
        user_id=auth.user_id,
        email=getattr(auth, "email", None),
        scopes=getattr(auth, "scopes", ()),
        # SECURITY (A-03): carry the verified role/auth_method. The engine
        # AuthContext.role defaults to "admin", so rebuilding it from only
        # user_id/email/scopes would silently re-grant admin to a member and
        # defeat the SupabaseAuthProvider role fix. Fail closed to "member".
        role=getattr(auth, "role", None) or "member",
        auth_method=getattr(auth, "auth_method", "secret"),
    )
    try:
        result = await _asyncio.to_thread(
            engine_main._build_worker_detail, worker_id,
            user_id=auth.user_id, repos=repos
        )
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        raw_worker = repos.workers.get_any(worker_id=worker_id) or {}
        owner_id = raw_worker.get("owner_id") or raw_worker.get("user_id") or ""
        actual_workspace_id = str(raw_worker.get("workspace_id") or "")
        if str(owner_id) != str(auth.user_id) or not actual_workspace_id:
            raise
        from apps.api.auth.workspace_context import active_workspace

        with active_workspace(actual_workspace_id, "admin"):
            result = await _asyncio.to_thread(
                engine_main._build_worker_detail, worker_id,
                user_id=auth.user_id, repos=repos
            )
    if result is None:
        raise HTTPException(status_code=404, detail="worker not found")

    result_dict = result.model_dump() if hasattr(result, "model_dump") else dict(result)
    raw = repos.workers.get_any(worker_id=worker_id) or {}
    result_dict["visibility"] = raw.get("visibility") or "private"
    result_dict["published_at"] = raw.get("published_at")
    return result_dict


@app.get("/runs/{run_id}")
@app.get("/api/runs/{run_id}")
async def cloud_get_run(run_id: str, request: Request) -> Any:
    """Cloud override for exact run detail deep links.

    Lists stay scoped to the active workspace. Exact owned deep links can be
    opened from activity cards and notifications even when the browser still has
    an older workspace cookie, so recover the row's workspace before delegating
    to the engine run-detail builder.
    """
    import asyncio as _asyncio

    from apps.api.auth.supabase_provider import SupabaseAuthProvider
    from auth.context import AuthContext as _AuthContext

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    repos = engine_main.get_repositories()
    engine_auth = _AuthContext(
        user_id=auth.user_id,
        email=getattr(auth, "email", None),
        scopes=getattr(auth, "scopes", ()),
        # SECURITY (A-03): carry the verified role/auth_method. The engine
        # AuthContext.role defaults to "admin", so rebuilding it from only
        # user_id/email/scopes would silently re-grant admin to a member and
        # defeat the SupabaseAuthProvider role fix. Fail closed to "member".
        role=getattr(auth, "role", None) or "member",
        auth_method=getattr(auth, "auth_method", "secret"),
    )
    try:
        return await _asyncio.to_thread(
            engine_main.get_run, run_id,
            auth=engine_auth, repos=repos
        )
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        raw_run = repos.runs.get_any(run_id=run_id) or {}
        owner_id = raw_run.get("owner_id") or raw_run.get("user_id") or ""
        actual_workspace_id = str(raw_run.get("workspace_id") or "")
        if str(owner_id) != str(auth.user_id) or not actual_workspace_id:
            raise
        from apps.api.auth.workspace_context import active_workspace

        with active_workspace(actual_workspace_id, "admin"):
            return await _asyncio.to_thread(
                engine_main.get_run, run_id,
                auth=engine_auth, repos=repos
            )


@app.patch("/workers/{worker_id}/visibility")
@app.patch("/api/workers/{worker_id}/visibility")
async def cloud_set_worker_visibility(worker_id: str, request: Request) -> Any:
    """Cloud override: PATCH /workers/{id}/visibility.

    Sets visibility to 'private' or 'shared'. Stamps published_at once on
    first share — it is immutable thereafter (cycling shared→private→shared
    keeps the original timestamp so member run-history is preserved).
    """
    import secrets as _secrets

    from apps.api.auth.supabase_provider import SupabaseAuthProvider

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    visibility = body.get("visibility")
    if visibility not in ("private", "shared"):
        raise HTTPException(status_code=422, detail="visibility must be 'private' or 'shared'")

    repos = engine_main.get_repositories()
    worker = repos.workers.get_any(worker_id=worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="worker not found")
    owner_id = worker.get("owner_id") or worker.get("user_id") or ""
    if str(owner_id) != str(auth.user_id):
        raise HTTPException(status_code=403, detail="forbidden")

    repos.workers.set_visibility(worker_id=worker_id, visibility=visibility)
    updated = repos.workers.get_any(worker_id=worker_id) or {}
    return {
        "visibility": updated.get("visibility") or "private",
        "published_at": updated.get("published_at"),
    }


async def _cloud_set_worker_archived(worker_id: str, request: Request, *, archived: bool) -> Any:
    """Cloud-native archive/restore for DB-backed workers.

    The engine archive route edits worker.yml first, but Cloud-created workers
    can be DB-only because Supabase manifest_json is the source of truth.
    """
    import asyncio as _asyncio
    from datetime import datetime, timezone

    from apps.api.auth.supabase_provider import SupabaseAuthProvider

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    engine_main._raise_if_protected_worker_mutation(worker_id)
    repos = engine_main.get_repositories()
    worker = repos.workers.get(user_id=auth.user_id, worker_id=worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    manifest = dict(worker.get("manifest") or worker.get("manifest_json") or {})
    if archived:
        manifest["archived"] = True
        manifest.setdefault("archive_reason", f"Archived {datetime.now(timezone.utc).date().isoformat()}")
    else:
        manifest.pop("archived", None)
        manifest.pop("archive_reason", None)
    repos.workers.update(user_id=auth.user_id, worker_id=worker_id, manifest_json=manifest)

    return await _asyncio.to_thread(
        engine_main._build_worker_detail,
        worker_id,
        user_id=auth.user_id,
        repos=repos,
    )


@app.post("/workers/{worker_id}/archive")
@app.post("/api/workers/{worker_id}/archive")
async def cloud_archive_worker(worker_id: str, request: Request) -> Any:
    return await _cloud_set_worker_archived(worker_id, request, archived=True)


@app.post("/workers/{worker_id}/restore")
@app.post("/api/workers/{worker_id}/restore")
async def cloud_restore_worker(worker_id: str, request: Request) -> Any:
    return await _cloud_set_worker_archived(worker_id, request, archived=False)


@app.post("/workers/{worker_id}/clone-link")
@app.post("/api/workers/{worker_id}/clone-link")
async def cloud_generate_clone_link(worker_id: str, request: Request) -> Any:
    """Cloud override: POST /workers/{id}/clone-link.

    Generates a one-time wct_* token (7-day expiry), stores its SHA-256 hash,
    returns the raw token once. Secrets, run history, and brain data are NOT
    copied when the link is used.
    """
    import hashlib as _hashlib
    import secrets as _secrets
    from datetime import datetime, timedelta, timezone

    from apps.api.auth.supabase_provider import SupabaseAuthProvider

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    repos = engine_main.get_repositories()
    worker = repos.workers.get_any(worker_id=worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="worker not found")
    owner_id = worker.get("owner_id") or worker.get("user_id") or ""
    if str(owner_id) != str(auth.user_id):
        raise HTTPException(status_code=403, detail="forbidden")

    raw_token = "wct_" + _secrets.token_urlsafe(32)
    token_hash = _hashlib.sha256(raw_token.encode()).hexdigest()
    expires_at = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    repos.workers.set_clone_token(worker_id=worker_id, token_hash=token_hash, expires_at=expires_at)
    return {"token": raw_token, "expires_at": expires_at}


@app.post("/workers/{worker_id}/share-to-workspace", status_code=201)
@app.post("/api/workers/{worker_id}/share-to-workspace", status_code=201)
async def cloud_share_worker_to_workspace(worker_id: str, request: Request) -> Any:
    """Share a worker to the workspace by creating an admin-owned clone.

    The clone is owned by the workspace owner (admin), has visibility='shared'
    so all members see it, and starts with no brain, no run history, and no
    secrets. The admin's personal secrets power it on execution since the clone
    runs as the admin's identity.

    Only workspace admins can call this endpoint.
    """
    import asyncio as _asyncio
    import json as _json

    from apps.api.auth.supabase_provider import SupabaseAuthProvider
    from apps.api.auth.workspace_context import get_active_member_role, get_active_workspace_id
    from apps.api.config import get_supabase_service_client
    from apps.api.db import workspaces as workspace_repo
    from auth.context import AuthContext as _AuthContext

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    # Only admins can share to workspace.
    workspace_id = get_active_workspace_id()
    if not workspace_id:
        raise HTTPException(status_code=400, detail="active workspace required")

    ws = workspace_repo.get(workspace_id=workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail="workspace not found")

    is_owner = str(ws.get("owner_user_id", "")) == str(auth.user_id)
    role = get_active_member_role()
    if not is_owner and role != "admin":
        raise HTTPException(status_code=403, detail="admin access required")

    # The workspace copy is always owned by the workspace owner (admin).
    admin_user_id = str(ws["owner_user_id"])

    # Read source worker. get_any() is a GLOBAL, UNSCOPED lookup by id, so the
    # source worker MUST be authz-checked against the caller's active workspace
    # before any of its files are read. Worker ids are guessable (slugified
    # names); without this gate an admin could clone another tenant's
    # worker.yml/run.py into their own workspace (cross-tenant IDOR).
    repos = engine_main.get_repositories()
    source = repos.workers.get_any(worker_id=worker_id)
    if not source:
        raise HTTPException(status_code=404, detail="worker not found")

    # Source-workspace scoping: the worker being shared must belong to the
    # caller's active workspace. Mirrors the owner/workspace check that
    # clone-link and the visibility endpoint enforce. Treat a missing/mismatched
    # source workspace as not-found so we don't leak existence of other tenants'
    # workers.
    source_workspace_id = workspace_repo.workspace_id_for_worker(worker_id=worker_id)
    if not source_workspace_id or str(source_workspace_id) != str(workspace_id):
        raise HTTPException(status_code=404, detail="worker not found")

    sv_id = (source.get("skill_version_id") or "").strip()
    files: dict = {}
    if sv_id:
        svc = get_supabase_service_client()
        sv_resp = svc.table("skill_versions").select("manifest_json").eq("id", sv_id).limit(1).execute()
        sv_rows = sv_resp.data or []
        if sv_rows:
            raw_mj = sv_rows[0].get("manifest_json") or {}
            mj = raw_mj if isinstance(raw_mj, dict) else (_json.loads(raw_mj) if isinstance(raw_mj, str) else {})
            files = mj.get("_files") or {}

    if not files:
        files = _read_worker_files_from_disk(worker_id)

    if not files or "worker.yml" not in files:
        raise HTTPException(status_code=422, detail="source worker has no files to clone")

    DraftFile = engine_main.DraftFile
    draft_files = [DraftFile(path=name, content=content) for name, content in files.items()]

    # Create the clone as the admin user — this makes the workspace copy
    # admin-owned so it runs with admin's secrets.
    admin_auth = _AuthContext(user_id=admin_user_id, email=None, scopes=())
    # engine_main._register_worker_from_files(files, *, user_id, repos=None,
    # dedupe_id=False) -> str. The args after `files` are keyword-only and the
    # return is the registered worker id (a str), not a worker dict.
    new_worker_id = await _asyncio.to_thread(
        engine_main._register_worker_from_files,
        draft_files,
        user_id=admin_user_id,
        repos=repos,
        dedupe_id=True,
    )
    new_worker_id = str(new_worker_id or "")
    if not new_worker_id:
        raise HTTPException(status_code=500, detail="failed to create workspace worker")

    # Mark as shared — visible to all workspace members.
    repos.workers.set_visibility(worker_id=new_worker_id, visibility="shared")

    # Persist files to Supabase (Railway disk is ephemeral).
    _cloud_persist_worker_files(new_worker_id, files, repos)

    detail = repos.workers.get_any(worker_id=new_worker_id) or {}
    result_dict = dict(detail)
    result_dict["id"] = new_worker_id
    result_dict["visibility"] = "shared"
    result_dict["workspace_worker"] = True
    return result_dict


@app.post("/workers/clone/{token}", status_code=201)
@app.post("/api/workers/clone/{token}", status_code=201)
async def cloud_clone_worker(token: str, request: Request) -> Any:
    """Cloud override for POST /workers/clone/{token}.

    In cloud mode, worker files live in Supabase (skill_versions.manifest_json._files),
    not on disk. This override reads them from Supabase and writes the clone back.
    """
    import hashlib as _hashlib
    import json as _json
    from datetime import datetime, timezone

    from apps.api.auth.supabase_provider import SupabaseAuthProvider
    from apps.api.config import get_supabase_service_client
    from auth.context import AuthContext as _AuthContext

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    token_hash = _hashlib.sha256(token.encode()).hexdigest()
    repos = engine_main.get_repositories()
    source = repos.workers.get_by_clone_token(token_hash=token_hash)
    if not source:
        raise HTTPException(status_code=404, detail="clone token not found")
    expires_at_str = source.get("clone_token_expires_at") or ""
    if expires_at_str:
        try:
            exp = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > exp:
                raise HTTPException(status_code=410, detail="clone token expired")
        except HTTPException:
            raise
        except Exception:
            pass

    # Read files from Supabase manifest_json._files.
    source_worker_id = str(source["id"])
    svc = get_supabase_service_client()
    sv_id = (source.get("skill_version_id") or "").strip()
    files: dict = {}
    if sv_id:
        sv_resp = svc.table("skill_versions").select("manifest_json").eq("id", sv_id).limit(1).execute()
        sv_rows = sv_resp.data or []
        if sv_rows:
            raw_mj = sv_rows[0].get("manifest_json") or {}
            mj = raw_mj if isinstance(raw_mj, dict) else (_json.loads(raw_mj) if isinstance(raw_mj, str) else {})
            files = mj.get("_files") or {}

    if not files:
        # Fall back to disk materialisation if Supabase files are missing.
        files = _read_worker_files_from_disk(source_worker_id)

    if not files or "worker.yml" not in files:
        raise HTTPException(status_code=422, detail="source worker has no files to clone")

    DraftFile = engine_main.DraftFile
    draft_files = [DraftFile(path=name, content=content) for name, content in files.items()]

    engine_auth = _AuthContext(
        user_id=auth.user_id,
        email=getattr(auth, "email", None),
        scopes=getattr(auth, "scopes", ()),
        # SECURITY (A-03): carry the verified role/auth_method. The engine
        # AuthContext.role defaults to "admin", so rebuilding it from only
        # user_id/email/scopes would silently re-grant admin to a member and
        # defeat the SupabaseAuthProvider role fix. Fail closed to "member".
        role=getattr(auth, "role", None) or "member",
        auth_method=getattr(auth, "auth_method", "secret"),
    )

    # _register_worker_from_files(files, *, user_id, repos=None, dedupe_id=False)
    # -> str. Keyword-only args; returns the new worker id. dedupe_id avoids a
    # 409 when the cloned worker reuses the source's (globally-unique) id.
    new_id = str(
        engine_main._register_worker_from_files(
            draft_files,
            user_id=engine_auth.user_id,
            repos=repos,
            dedupe_id=True,
        )
        or ""
    )

    # Persist cloned files to Supabase so they survive Railway restarts.
    if new_id:
        _cloud_persist_worker_files(new_id, files, repos)

    return {
        "worker_id": new_id,
        "cloned_from": source_worker_id,
        "disclaimer": (
            "Connections are auto-wired by app name. "
            "Secrets, run history, and brain data are NOT copied. "
            "Review and test before using in production."
        ),
    }


@app.post("/mcp/{workspace_id}")
async def cloud_mcp_endpoint(
    workspace_id: str,
    request: Request,
) -> Any:
    """Workspace-scoped HTTP MCP server.

    Auth: PAT Bearer token in Authorization header (or x-floom-token).
    The PAT must belong to workspace_id — validated by SupabaseAuthProvider,
    which sets the active workspace contextvar before this handler runs.
    """
    from apps.api.auth.supabase_provider import SupabaseAuthProvider
    from apps.api.auth.workspace_context import get_active_workspace_id
    from fastapi.responses import JSONResponse as _JSONResponse

    provider = SupabaseAuthProvider()
    try:
        auth = await provider.verify(request)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication failed")

    # Confirm the workspace in the URL matches the authenticated workspace.
    active_ws = get_active_workspace_id()
    if active_ws and active_ws != workspace_id:
        raise HTTPException(status_code=403, detail="token is not valid for this workspace")

    try:
        body = await request.json()
    except Exception:
        return _JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}, status_code=400)

    repos = engine_main.get_repositories()
    result = await engine_main._mcp_handle_request(body, auth, repos, request)
    return _JSONResponse(result)


@app.post("/api/webhooks/{worker_id}", response_model=engine_main.ActionResponse)
async def cloud_webhook_trigger(
    worker_id: str,
    request: Request,
    token: str | None = Query(None),
) -> Any:
    repos = engine_main.get_repositories()
    client_ip = request.client.host if request.client else "unknown"
    rate_limit_key = f"{worker_id}:{client_ip}"
    if not engine_main._check_webhook_rate_limit(rate_limit_key):
        raise HTTPException(status_code=429, detail="Too many webhook requests")

    if token is None or not token.strip():
        raise HTTPException(status_code=401, detail="Missing webhook token")
    if not verify_webhook_token(worker_id, token, repos=repos):
        raise HTTPException(status_code=401, detail="Invalid webhook token")

    worker = repos.workers.get_any(worker_id=worker_id) or engine_main.get_worker(worker_id)
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    user_id = worker.get("owner_id")
    config = engine_main.get_worker_config_for_run(worker_id)
    if not engine_main._worker_has_webhook_trigger(worker, config):
        raise HTTPException(
            status_code=400,
            detail=f"Worker {worker_id!r} does not have a webhook trigger",
        )

    body = await request.body()
    inputs: dict[str, Any] = {}
    if body:
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                inputs = parsed
            else:
                inputs = {"payload": parsed}
        except Exception:
            inputs = {"raw": body.decode("utf-8", errors="replace")}

    run_id = engine_main.create_run(
        worker_id,
        inputs,
        trigger_source="webhook",
        user_id=user_id,
        repos=repos,
    )
    engine_main.start_run(
        run_id,
        worker_id,
        inputs,
        user_id=user_id,
        repos=repos,
    )
    return engine_main.ActionResponse(status="queued", run_id=run_id)


# The engine creates its OWN FastAPI app with docs enabled (Floom API). Mounted
# under /api it would expose /api/docs, /api/redoc and /api/openapi.json
# unauthenticated. We can't edit engine/ (pinned submodule), so disable the
# engine sub-app's docs at the cloud layer: blank the docs URLs and drop the
# already-registered Swagger/ReDoc/OpenAPI routes from its router before mount.
# Gated by the same WORKEROS_ENABLE_DOCS flag as the cloud app.
if not _docs_enabled:
    _engine_app = engine_main.app
    _engine_app.docs_url = None
    _engine_app.redoc_url = None
    _engine_app.openapi_url = None
    _docs_paths = {"/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"}
    _engine_app.router.routes = [
        route
        for route in _engine_app.router.routes
        if getattr(route, "path", None) not in _docs_paths
    ]

# Keep versioned API prefixes as compatibility aliases for clients that expect
# a conventional /v1 shape. They must be registered before /api, otherwise the
# broader /api mount consumes /api/v1/* and returns the engine's 404.
app.mount("/api/v1", engine_main.app)
app.mount("/v1", engine_main.app)
app.mount("/api", engine_main.app)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "deploy": "cloud"}


app.include_router(slack_events_router)


# Compatibility alias: OSS Workeros exposes engine routes at the domain root
# (`/workers`, `/contexts`, `/workspace`, ...), while Cloud historically mounted
# the engine under `/api`. Mounting the same engine at `/` after all cloud-owned
# routes lets API clients use the same path shape on both backends without
# breaking existing `/api/*` callers.
app.mount("/", engine_main.app)
