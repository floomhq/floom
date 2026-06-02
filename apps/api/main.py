from __future__ import annotations

import json
import os
import sys
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

from fastapi import FastAPI, HTTPException, Query, Request

from apps.api.cloud_scheduler import start_cloud_scheduler, stop_cloud_scheduler
from apps.api.cloud_webhooks import verify_webhook_token
from apps.api._engine import import_engine_module
from apps.api.routes.auth import router as auth_router
from apps.api.routes.cli_auth_devices import router as cli_auth_devices_router
from apps.api.routes.novasearch import router as novasearch_router
from apps.api.routes.slack_events import router as slack_events_router
from apps.api.routes.telemetry import router as telemetry_router
from apps.api.routes.workspace_agent import router as workspace_agent_router
from apps.api.routes.workspaces import router as workspaces_router

import apps.api.startup  # noqa: F401


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
        dev_mode = (os.environ.get("WORKEROS_DEV") or "").strip()
        db_host = (os.environ.get("WORKEROS_CLOUD_DB_HOST") or "").strip()
        if dev_mode and not db_host:
            pass  # Skip scheduler in dev mode when DB creds are absent
        elif not start_cloud_scheduler():
            raise RuntimeError("Cloud scheduler advisory lock is already held.")
    try:
        yield
    finally:
        if (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
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
app.include_router(cli_auth_devices_router, prefix="/api")
app.include_router(telemetry_router, prefix="/api")
app.include_router(novasearch_router, prefix="/api")
app.include_router(workspace_agent_router, prefix="/api")
app.include_router(slack_events_router, prefix="/api")


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
    result = await engine_main._mcp_handle_request(body, auth, repos)
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
