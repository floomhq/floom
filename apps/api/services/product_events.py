"""Small fail-soft PostHog product-event helpers."""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("floom.api")


def emit_product_event(
    *,
    owner_id: str,
    event: str,
    properties: Dict[str, Any],
    workspace_id: Optional[str] = None,
) -> None:
    try:
        from db import derive_workspace_id
        from services import analytics_posthog
    except Exception:  # pragma: no cover
        return
    if not analytics_posthog.is_enabled():
        return
    try:
        analytics_posthog.capture_event(
            distinct_id=owner_id or "",
            event=event,
            properties=properties,
            groups={"workspace": workspace_id or derive_workspace_id(owner_id)},
        )
    except Exception:  # pragma: no cover
        logger.debug("PostHog %s emit failed", event, exc_info=True)


def emit_approval_decided(
    *,
    owner_id: str,
    approval_id: str,
    run_id: str,
    worker_id: Optional[str],
    decision: str,
    approval_kind: Optional[str] = None,
) -> None:
    emit_product_event(
        owner_id=owner_id,
        event=f"approval_{decision}",
        properties={
            "approval_id": approval_id,
            "run_id": run_id,
            "worker_id": worker_id,
            "decision": decision,
            "approval_kind": approval_kind,
        },
    )


def emit_worker_lifecycle_event(
    *,
    owner_id: str,
    worker_id: str,
    event: str,
    source: str,
) -> None:
    emit_product_event(
        owner_id=owner_id,
        event=event,
        properties={
            "worker_id": worker_id,
            "source": source,
        },
    )


def emit_mcp_tool_called(
    *,
    owner_id: str,
    tool_name: str,
    success: bool,
    duration_ms: int,
    auth_method: Optional[str] = None,
    worker_id: Optional[str] = None,
    run_id: Optional[str] = None,
    status_code: Optional[int] = None,
    error_category: Optional[str] = None,
    is_custom_tool: bool = False,
) -> None:
    emit_product_event(
        owner_id=owner_id,
        event="mcp_tool_called",
        properties={
            "tool_name": tool_name,
            "success": bool(success),
            "duration_ms": max(0, int(duration_ms)),
            "auth_method": auth_method,
            "worker_id": worker_id,
            "run_id": run_id,
            "status_code": status_code,
            "error_category": error_category,
            "is_custom_tool": bool(is_custom_tool),
        },
    )


def emit_cli_command_invoked(
    *,
    owner_id: str,
    command: str,
    success: bool,
    duration_ms: int,
    exit_code: int,
    api_base_kind: str,
    worker_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> None:
    emit_product_event(
        owner_id=owner_id,
        event="cli_command_invoked",
        properties={
            "command": command,
            "success": bool(success),
            "duration_ms": max(0, int(duration_ms)),
            "exit_code": int(exit_code),
            "api_base_kind": api_base_kind,
            "worker_id": worker_id,
            "run_id": run_id,
        },
    )


def emit_api_request_completed(
    *,
    owner_id: str,
    method: str,
    route: str,
    status_code: int,
    duration_ms: int,
    auth_method: Optional[str] = None,
    deploy: Optional[str] = None,
    workspace_id: Optional[str] = None,
) -> None:
    emit_product_event(
        owner_id=owner_id,
        event="api_request_completed",
        workspace_id=workspace_id,
        properties={
            "method": method.upper(),
            "route": route,
            "status_code": int(status_code),
            "duration_ms": max(0, int(duration_ms)),
            "auth_method": auth_method,
            "deploy": deploy,
        },
    )
