"""Worker listing route: GET /workers (the worker-cards list).

The operator worker list — visible workers projected into WorkerListSummary cards
(triggers, connections, required secrets, recent stats/timeseries, last run, star
state, public link, permissions). Extracted verbatim from main.py.

All projection logic is in the worker services (worker_access / worker_serialize /
run_serialize / secrets_env / public_view); the run-config resolver comes from
run_service; db via Depends(get_repos). Purged in lockstep with main.
"""

from __future__ import annotations

from typing import Annotated, List, Optional

import logging
import os
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from auth import AuthContext, get_auth_context
from core import hot_cache
from db import Repositories, get_repos
from models import WorkerInput, WorkerListSummary, WorkerSummaryInput
from run_service import get_worker_config_for_run
from services.public_view import _sanitize_operator_text
from services.run_serialize import _make_run_summary
from services.secrets_env import _available_secret_names_for_user
from services.worker_access import (
    _available_connection_slugs_for_user,
    _list_visible_workers,
    _worker_access_user_id,
    _worker_connection_slugs,
    _worker_permissions,
    _worker_repo_role,
    _worker_required_secret_names,
)
from services.worker_serialize import (
    _build_triggers_list,
    _build_triggers_spec,
    _connection_slug_for_worker_card,
    _get_last_run_for_worker,
    _get_stats_batch,
    _get_timeseries_batch,
    _resolve_worker_status,
    _starred_worker_ids,
    _worker_public_link,
)

worker_listing_router = APIRouter()
logger = logging.getLogger("floom.api")


def _hot_cache_scope() -> tuple[str, str]:
    return (
        os.environ.get("WORKEROS_DB") or os.environ.get("FLOOM_DB") or "",
        os.environ.get("FLOOM_WORKERS_DIR") or "",
    )


def _safe_worker_config_for_listing(worker_id: str):
    try:
        return get_worker_config_for_run(worker_id)
    except Exception:
        logger.warning("workers list: ignoring invalid config for worker %s", worker_id, exc_info=True)
        return None


@worker_listing_router.get("/workers", response_model=List[WorkerListSummary])
def list_workers(
    request: Request = None,
    response: Response = None,
    include_system: bool = False,
    include_archived: bool = False,
    shape: str = "full",
    visibility: Optional[str] = None,
    q: Optional[str] = None,
    starred: Optional[bool] = None,
    # Annotated form (not `= Query(...)`) so the defaults are REAL values (None/0)
    # when list_workers is called directly in-process (e.g. the MCP workers.list
    # handler), while HTTP requests still get the ge/le validation. A bare
    # `= Query(0, ...)` default leaks the FieldInfo object into direct callers
    # and breaks the slice below (#1077 follow-up).
    limit: Annotated[Optional[int], Query(ge=1, le=500)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> List[WorkerListSummary]:
    """List workers.

    ?shape=list           — trimmed payload (~15 KB for 18 workers) for the web UI list view.
                            Drops: long_description, use_cases, example_input, example_output,
                            how_it_works, timeseries. Keeps all fields needed to render the card.
    ?shape=full           — full payload (default, backwards-compat for CLI + MCP consumers).
    ?include_archived=true — include archived workers (archived:true in worker.yml).
                             Default: excluded from All/Starred/Recent; shown only in Archived view.
    """
    started = time.perf_counter()
    workspace_key = None
    if request is not None:
        workspace_key = (
            request.headers.get("x-workeros-workspace")
            or request.query_params.get("workspace_id")
        )
    cache_key = (
        "workers",
        _hot_cache_scope(),
        auth.user_id,
        auth.role,
        workspace_key,
        include_system,
        include_archived,
        shape,
        visibility,
        q,
        starred,
        limit,
        offset,
    )
    cached = hot_cache.get(cache_key)
    if cached is not None:
        duration_ms = (time.perf_counter() - started) * 1000
        if response is not None:
            response.headers["Server-Timing"] = f"workers;dur={duration_ms:.1f};desc=\"hit\""
        logger.info(
            "workers list cache=hit user_id=%s count=%s duration_ms=%.1f",
            auth.user_id,
            len(cached),
            duration_ms,
        )
        return cached

    worker_user_id = _worker_access_user_id(auth)
    workers = _list_visible_workers(
        user_id=worker_user_id,
        repos=repos,
        use_cache=True,
        role=_worker_repo_role(auth),
    )
    # Filter out system_worker: true workers unless explicitly requested.
    if not include_system:
        workers = [
            w for w in workers
            if not (w.get("manifest") or {}).get("system_worker", False)
        ]
    # Filter out archived workers unless explicitly requested.
    # NOTE: when include_system and include_archived are both False this matches
    # _list_operator_workers exactly (shared filter, see 1.5.4).
    if not include_archived:
        workers = [w for w in workers if not w.get("archived", False)]
    # #771: optional visibility-tier filter. Does NOT change access control —
    # only shapes the already-authorized list. "all" is the default no-op.
    if visibility and visibility != "all":
        if visibility not in ("private", "workspace", "public"):
            raise HTTPException(status_code=422, detail="visibility must be private, workspace, public, or all")
        workers = [
            w for w in workers
            if str(w.get("visibility") or "private") == visibility
        ]
    # #779: server-side substring search on name + description (case-insensitive),
    # so large workspaces don't ship the full list to the client to filter.
    if q and q.strip():
        needle = q.strip().lower()
        workers = [
            w for w in workers
            if needle in str(w.get("name") or "").lower()
            or needle in str(w.get("description") or "").lower()
        ]
    # #782: per-user star set; optional ?starred=true filter feeds the
    # "starred" tag tab.
    _starred_ids = _starred_worker_ids(auth.user_id)
    if starred:
        workers = [w for w in workers if w["id"] in _starred_ids]
    # #1077: honor limit/offset like /runs. Default (limit=None) stays
    # return-all for CLI/MCP back-compat; bad values are rejected with 422 by
    # the Query() constraints above. Slice here — after all filters, before the
    # expensive per-worker stats/timeseries fan-out — so a paged request only
    # pays for the page it returns.
    if offset:
        workers = workers[offset:]
    if limit is not None:
        workers = workers[:limit]
    worker_ids = [w["id"] for w in workers]
    stats_by_id = _get_stats_batch(worker_ids, user_id=worker_user_id, repos=repos)
    # S44 Win 3: skip expensive timeseries fetch when list shape requested.
    list_shape = shape == "list"
    timeseries_by_id = (
        {} if list_shape
        else _get_timeseries_batch(worker_ids, user_id=worker_user_id, repos=repos, days=14)
    )
    available_secret_names = _available_secret_names_for_user(worker_user_id, repos)
    available_conn_slugs = _available_connection_slugs_for_user(worker_user_id, repos)
    result: List[WorkerListSummary] = []
    for w in workers:
        last_run_row = _get_last_run_for_worker(w["id"], user_id=worker_user_id, repos=repos)
        last_run = _make_run_summary(last_run_row) if last_run_row else None

        # Resolve status via the SHARED resolver so LIST and DETAIL agree
        # exactly for the same worker (full honesty ladder: missing-secret /
        # failed-run / disabled / never-run, see _resolve_worker_status).
        config = _safe_worker_config_for_listing(w["id"])
        status_worker = w
        if config is None and w.get("status") in (None, "healthy", "ready"):
            status_worker = {**w, "status": "error"}
        is_archived = w.get("archived", False)
        status = _resolve_worker_status(
            status_worker,
            config=config,
            available_secret_names=available_secret_names,
            last_run_status=last_run.status if last_run else None,
            has_run=last_run is not None,
        )

        triggers = _build_triggers_list(w)
        triggers_spec = _build_triggers_spec(w)
        recent_stats = stats_by_id.get(w["id"])
        timeseries = timeseries_by_id.get(w["id"])

        # #556: compute which required secrets/connections are not yet configured.
        _secret_set = set(available_secret_names)
        _req_secrets = _worker_required_secret_names(w) if config else []
        _missing_secrets = [s for s in _req_secrets if s not in _secret_set]
        _req_conn_slugs = _worker_connection_slugs(w)
        _missing_connections = [c for c in _req_conn_slugs if c.lower() not in available_conn_slugs]

        # Extract connection slugs and runtime from worker config dict.
        # These are lightweight and needed for the worker card tool-logo strip.
        _worker_config_dict = w.get("config") or {}
        _raw_connections = _worker_config_dict.get("connections") or w.get("connections") or []
        _conn_slugs = [
            slug
            for c in _raw_connections
            if (slug := _connection_slug_for_worker_card(c))
        ]
        _raw_runtime = _worker_config_dict.get("runtime") or {}
        _runtime_type = (
            _raw_runtime.get("type") if isinstance(_raw_runtime, dict)
            else (str(_raw_runtime) if _raw_runtime else None)
        )
        _inputs = []
        for _raw_input in _worker_config_dict.get("inputs") or []:
            if isinstance(_raw_input, dict):
                try:
                    if list_shape:
                        _inputs.append(
                            WorkerSummaryInput(
                                name=str(_raw_input["name"]),
                                type=str(_raw_input["type"]),
                            )
                        )
                    else:
                        _inputs.append(WorkerInput(**_raw_input))
                except Exception:
                    continue

        result.append(
            WorkerListSummary(
                id=w["id"],
                name=w["name"],
                created_at=w.get("created_at"),
                updated_at=w.get("updated_at"),
                description=w.get("description"),
                # S44 Win 3: omit detail-only fields in list shape.
                long_description=None if list_shape else w.get("long_description"),
                use_cases=None if list_shape else w.get("use_cases"),
                example_input=None if list_shape else w.get("example_input"),
                example_output=None if list_shape else w.get("example_output"),
                how_it_works=None if list_shape else w.get("how_it_works"),
                is_example=w.get("is_example"),
                system=bool((w.get("manifest") or {}).get("system_worker", False)),
                archived=is_archived,
                archive_reason=_sanitize_operator_text(w.get("archive_reason")),
                tags=w.get("tags") or [],
                folder=w.get("folder"),
                status=status,
                trigger_type=w["trigger_type"],
                runner=w["runner"],
                last_run=last_run,
                triggers=triggers,
                triggers_spec=triggers_spec,
                recent_stats=recent_stats,
                timeseries=None if list_shape else timeseries,
                # B7: always include connection slugs and runtime for worker card tool strip.
                connections=_conn_slugs,
                missing_secrets=_missing_secrets,
                missing_connections=_missing_connections,
                inputs=_inputs,
                runtime=_runtime_type,
                public_link=_worker_public_link(w) if str(w.get("visibility") or "private") == "public" else None,
                owner_id=w.get("owner_id"),
                visibility=str(w.get("visibility") or "private"),
                starred=w["id"] in _starred_ids,  # #782
                permissions=_worker_permissions(
                    w,
                    user_id=worker_user_id,
                    repos=repos,
                    owner_aliases={auth.user_id, auth.username or ""},
                ),
            )
        )
    hot_cache.set(cache_key, result)
    duration_ms = (time.perf_counter() - started) * 1000
    if response is not None:
        response.headers["Server-Timing"] = f"workers;dur={duration_ms:.1f};desc=\"miss\""
    logger.info(
        "workers list cache=miss user_id=%s count=%s duration_ms=%.1f",
        auth.user_id,
        len(result),
        duration_ms,
    )
    return result
