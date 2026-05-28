from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request

from apps.api.cloud_scheduler import start_cloud_scheduler, stop_cloud_scheduler
from apps.api.cloud_webhooks import verify_webhook_token
from apps.api._engine import import_engine_module
from apps.api.routes.auth import router as auth_router

import apps.api.startup  # noqa: F401


engine_main = import_engine_module("main")

# The engine's main.py auto-loads /root/.config/workeros/api.env via load_dotenv()
# on import. That file is the OSS single-tenant local-mode prod env and contains
# FLOOM_SECRET. When loaded into our cloud process, the engine's auth_middleware
# (which gates every request behind x-floom-secret when FLOOM_SECRET is set)
# rejects all our JWT-authed cloud traffic with 401. Strip it in cloud mode.
if (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
    os.environ.pop("FLOOM_SECRET", None)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
        if not start_cloud_scheduler():
            raise RuntimeError("Cloud scheduler advisory lock is already held.")
    try:
        yield
    finally:
        if (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud":
            stop_cloud_scheduler()


app = FastAPI(
    title="workeros-cloud API",
    version="0.1.0",
    description="Supabase-backed wrapper around the workeros OSS API engine.",
    lifespan=lifespan,
)
app.include_router(auth_router)


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


app.mount("/api", engine_main.app)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "deploy": "cloud"}
