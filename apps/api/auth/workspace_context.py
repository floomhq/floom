"""Per-request active-workspace context for cloud repositories.

The cloud's SupabaseAuthProvider reads the ``workeros_active_workspace``
cookie on every authenticated HTTP request and stashes the resolved
workspace_id here. The cloud repositories (``apps.api.db.supabase_repos``)
read it via ``get_active_workspace_id`` and scope every list / get /
upsert / delete by ``workspace_id`` instead of ``user_id``.

Outside an HTTP request (cron scheduler, webhook handler, background
task), the contextvar is unset. Repos fall back to filtering by
``user_id`` in that case, which preserves the engine's pre-workspace
behavior — those code paths look up rows owned by a specific user_id
that was derived from the worker's row, so the result set is still
correct.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator


_active_workspace_id: ContextVar[str | None] = ContextVar(
    "workeros_active_workspace_id",
    default=None,
)


def get_active_workspace_id() -> str | None:
    """Return the workspace_id active for the current request, or None."""
    return _active_workspace_id.get()


def set_active_workspace_id(workspace_id: str | None) -> None:
    """Set the workspace_id for the current request/task.

    Called once per request by SupabaseAuthProvider.verify after the
    JWT is decoded and the cookie is consulted. Tests may set it
    directly to simulate a scoped request.
    """
    _active_workspace_id.set(workspace_id)


@contextmanager
def active_workspace(workspace_id: str | None) -> Iterator[None]:
    """Context manager for tests / scheduler code that wants to scope a
    block to a specific workspace_id without leaking into the parent.
    """
    token = _active_workspace_id.set(workspace_id)
    try:
        yield
    finally:
        _active_workspace_id.reset(token)
