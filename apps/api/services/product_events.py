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
