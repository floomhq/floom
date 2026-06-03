"""Per-request active-workspace context for cloud repositories.

The cloud's SupabaseAuthProvider reads the ``workeros_active_workspace``
cookie on every authenticated HTTP request and stashes the resolved
workspace_id here. The cloud repositories (``apps.api.db.supabase_repos``)
read it via ``get_active_workspace_id`` and scope every list / get /
upsert / delete by ``workspace_id`` instead of ``user_id``.

``_active_member_role`` is set in the same request lifecycle: 'admin' for
the workspace owner or any member with role='admin', 'member' for ordinary
members. Routes and repositories use ``get_active_member_role`` to enforce
visibility rules and trigger admin-access logging.

Outside an HTTP request (cron scheduler, webhook handler, background
task), the contextvars are unset. Repos fall back to filtering by
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

_active_member_role: ContextVar[str | None] = ContextVar(
    "workeros_active_member_role",
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


def get_active_member_role() -> str | None:
    """Return the caller's role in the active workspace, or None.

    'admin' — workspace owner or promoted member.
    'member' — ordinary workspace member.
    None — outside a request, or no workspace selected.
    """
    return _active_member_role.get()


def set_active_member_role(role: str | None) -> None:
    """Set the caller's role for the current request.

    Called alongside set_active_workspace_id by SupabaseAuthProvider.verify.
    Owner always resolves to 'admin'; other callers are looked up in
    workspace_members.
    """
    _active_member_role.set(role)


@contextmanager
def active_workspace(workspace_id: str | None, role: str | None = None) -> Iterator[None]:
    """Context manager for tests / scheduler code that wants to scope a
    block to a specific workspace without leaking into the parent.
    """
    tok_ws = _active_workspace_id.set(workspace_id)
    tok_role = _active_member_role.set(role)
    try:
        yield
    finally:
        _active_workspace_id.reset(tok_ws)
        _active_member_role.reset(tok_role)
