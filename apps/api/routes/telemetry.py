from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Literal

import httpcore
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api import telemetry

ensure_engine_api_path()

from auth import AuthContext, get_auth_context  # noqa: E402

logger = logging.getLogger(__name__)

# Transient connection-drop family. Telemetry ingest fail-softs (returns 200,
# stored=0) ONLY for these — a Supabase pooled connection terminated mid-flight
# must not surface as a 500 to the caller. Genuinely-unexpected exceptions
# (schema/TypeError/KeyError) are NOT swallowed: they are logged at error and
# re-raised so persistent breakage is visible instead of silently returning 200.
_CONNECTION_DROP_ERRORS: tuple[type[BaseException], ...] = (
    httpx.RemoteProtocolError,
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpcore.RemoteProtocolError,
    httpcore.ConnectError,
    httpcore.ConnectTimeout,
    httpcore.ReadError,
)

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


class TelemetryEventIn(BaseModel):
    event_name: str = Field(..., min_length=2, max_length=96)
    event_version: int = Field(default=1, ge=1, le=100)
    source: Literal["web", "api", "cli", "worker", "system"] = "web"
    session_id: str | None = Field(default=None, max_length=160)
    properties: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime | None = None

    @field_validator("event_name")
    @classmethod
    def _valid_event_name(cls, value: str) -> str:
        try:
            return telemetry.validate_event_name(value)
        except telemetry.TelemetryError as exc:
            raise ValueError(str(exc)) from exc


class TelemetryIngestRequest(BaseModel):
    events: list[TelemetryEventIn] = Field(..., min_length=1, max_length=telemetry.MAX_EVENTS_PER_REQUEST)


class TelemetryIngestResponse(BaseModel):
    accepted: int
    stored: int
    telemetry_enabled: bool


class TelemetryPreferenceRequest(BaseModel):
    product_telemetry_enabled: bool


class TelemetryPreferenceResponse(BaseModel):
    product_telemetry_enabled: bool


class TelemetryExportResponse(BaseModel):
    events: list[dict[str, Any]]


def _workspace_id_or_500() -> str:
    workspace_id = get_active_workspace_id()
    if not workspace_id:
        raise HTTPException(status_code=500, detail="active workspace is not available")
    return workspace_id


@router.post("/events", response_model=TelemetryIngestResponse)
async def ingest_events(
    payload: TelemetryIngestRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> TelemetryIngestResponse:
    workspace_id = _workspace_id_or_500()
    raw_events = [event.model_dump() for event in payload.events]
    try:
        stored = telemetry.record_events(
            user_id=auth.user_id,
            workspace_id=workspace_id,
            events=raw_events,
        )
    except telemetry.TelemetryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except _CONNECTION_DROP_ERRORS as exc:
        # Telemetry is fire-and-forget analytics: a Supabase connection drop
        # (httpcore.RemoteProtocolError / httpx.ConnectError / etc.) MUST NOT
        # surface as a 500 to the client. Log a warning so ops can detect
        # persistent connectivity loss, but return accepted=N / stored=0 so the
        # caller is not blocked. Scoped to the connection-drop family ONLY — a
        # genuine bug (schema/TypeError/KeyError) must NOT be hidden here.
        logger.warning(
            "telemetry write failed on connection drop (stored=0, returning "
            "success): %s: %s",
            type(exc).__name__,
            exc,
        )
        return TelemetryIngestResponse(
            accepted=len(payload.events),
            stored=0,
            telemetry_enabled=True,
        )
    except Exception as exc:
        # Anything that is NOT a transient connection drop is a real bug
        # (schema mismatch, TypeError, KeyError, programming error). Surface it:
        # log at error so persistent breakage is visible, then re-raise so it is
        # not silently masked as a 200. Fail-soft is reserved for the drop case.
        logger.error(
            "telemetry write failed with unexpected error (re-raising): %s: %s",
            type(exc).__name__,
            exc,
        )
        raise
    return TelemetryIngestResponse(
        accepted=len(payload.events),
        stored=stored,
        telemetry_enabled=stored > 0 or telemetry.telemetry_enabled(workspace_id=workspace_id),
    )


@router.get("/preferences", response_model=TelemetryPreferenceResponse)
async def get_preferences(
    _auth: AuthContext = Depends(get_auth_context),
) -> TelemetryPreferenceResponse:
    workspace_id = _workspace_id_or_500()
    return TelemetryPreferenceResponse(
        product_telemetry_enabled=telemetry.telemetry_enabled(workspace_id=workspace_id)
    )


@router.put("/preferences", response_model=TelemetryPreferenceResponse)
async def update_preferences(
    payload: TelemetryPreferenceRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> TelemetryPreferenceResponse:
    workspace_id = _workspace_id_or_500()
    row = telemetry.set_telemetry_enabled(
        user_id=auth.user_id,
        workspace_id=workspace_id,
        enabled=payload.product_telemetry_enabled,
    )
    return TelemetryPreferenceResponse(
        product_telemetry_enabled=bool(row.get("product_telemetry_enabled"))
    )


@router.get("/export", response_model=TelemetryExportResponse)
async def export_telemetry(
    _auth: AuthContext = Depends(get_auth_context),
    limit: int = Query(default=500, ge=1, le=1000),
) -> TelemetryExportResponse:
    workspace_id = _workspace_id_or_500()
    return TelemetryExportResponse(events=telemetry.export_events(workspace_id=workspace_id, limit=limit))


@router.delete("/workspace")
async def delete_workspace_telemetry(
    _auth: AuthContext = Depends(get_auth_context),
) -> dict[str, int]:
    workspace_id = _workspace_id_or_500()
    return {"deleted": telemetry.delete_workspace_events(workspace_id=workspace_id)}
