"""Shared Composio integration helpers.

Small cross-route-group helpers for the Composio backend, kept in one service so
both the integrations catalog routes and the connections routes depend on it
rather than on each other. ``composio_client`` is imported lazily (purged + re-
imported by fixtures).
"""

from __future__ import annotations

from fastapi import HTTPException


def _raise_composio_unavailable(exc: Exception) -> None:
    from composio_client import ComposioConfigurationError

    if isinstance(exc, ComposioConfigurationError):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    raise HTTPException(
        status_code=503,
        detail=(
            "Unable to reach the integration provider right now. "
            "Try again later or use an API-key connection if this app does not support OAuth."
        ),
    ) from exc
