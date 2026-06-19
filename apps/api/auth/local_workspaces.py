from __future__ import annotations

import os
import re
import sqlite3
import uuid
from typing import Any

from fastapi import Request

from db import get_db, now_iso

from .context import AuthContext


ACTIVE_WORKSPACE_HEADER = "x-workeros-workspace"
DEFAULT_WORKSPACE_ID = "local-default"
_WORKSPACE_ID_RE = re.compile(r"^(?:local-default|ws_[a-f0-9]{14})$")
_DERIVED_USER_RE = re.compile(r"^(?P<base>.+)__ws_[a-f0-9]{14}$")
# Matches any HTML/XML tag (opening, closing, self-closing, or comments).
_HTML_TAG_RE = re.compile(r"<[^>]*>")


def _strip_html_tags(text: str) -> str:
    """Remove HTML tags from a display-string field (defense-in-depth).

    Workspace/worker names are plain text — angle-bracket markup is never
    valid content. Stripping at the input layer means the stored value can
    never reach any render path (JSX, markdown, email) with raw HTML in it.
    """
    return _HTML_TAG_RE.sub("", text)


def local_workspace_base_user_id(user_id: str) -> str:
    match = _DERIVED_USER_RE.fullmatch(user_id)
    return match.group("base") if match else user_id


def local_workspace_user_id(base_user_id: str, workspace_id: str) -> str:
    if workspace_id == DEFAULT_WORKSPACE_ID:
        return base_user_id
    return f"{base_user_id}__{workspace_id}"


def _valid_workspace_id(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    return text if _WORKSPACE_ID_RE.fullmatch(text) else None


def _default_name(base_user_id: str) -> str:
    configured = (os.environ.get("WORKEROS_DEFAULT_WORKSPACE_NAME") or "").strip()
    if configured:
        return configured
    return base_user_id or "Local"


def ensure_default_workspace(owner_user_id: str) -> dict[str, Any]:
    created_at = now_iso()
    try:
        with get_db() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO local_workspaces
                    (id, owner_user_id, name, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (DEFAULT_WORKSPACE_ID, owner_user_id, _default_name(owner_user_id), created_at),
            )
            row = conn.execute(
                """
                SELECT id, owner_user_id, name, created_at, region, timezone
                FROM local_workspaces
                WHERE owner_user_id = ? AND id = ?
                LIMIT 1
                """,
                (owner_user_id, DEFAULT_WORKSPACE_ID),
            ).fetchone()
    except sqlite3.OperationalError as exc:
        if "no such table: local_workspaces" not in str(exc).lower():
            raise
        return {
            "id": DEFAULT_WORKSPACE_ID,
            "owner_user_id": owner_user_id,
            "name": _default_name(owner_user_id),
            "created_at": created_at,
            "region": None,
            "timezone": None,
        }
    if row is None:
        raise RuntimeError("failed to create default local workspace")
    return dict(row)


def list_local_workspaces(owner_user_id: str) -> list[dict[str, Any]]:
    ensure_default_workspace(owner_user_id)
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, owner_user_id, name, created_at, region, timezone
            FROM local_workspaces
            WHERE owner_user_id = ?
            ORDER BY created_at, id
            """,
            (owner_user_id,),
        ).fetchall()
    return [dict(row) for row in rows]


def get_local_workspace(owner_user_id: str, workspace_id: str) -> dict[str, Any] | None:
    ensure_default_workspace(owner_user_id)
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT id, owner_user_id, name, created_at, region, timezone
            FROM local_workspaces
            WHERE owner_user_id = ? AND id = ?
            LIMIT 1
            """,
            (owner_user_id, workspace_id),
        ).fetchone()
    return dict(row) if row else None


def create_local_workspace(owner_user_id: str, name: str) -> dict[str, Any]:
    ensure_default_workspace(owner_user_id)
    workspace_id = "ws_" + uuid.uuid4().hex[:14]
    clean_name = _strip_html_tags((name or "").strip()) or "Untitled"
    created_at = now_iso()
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO local_workspaces
                (id, owner_user_id, name, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (workspace_id, owner_user_id, clean_name, created_at),
        )
    created = get_local_workspace(owner_user_id, workspace_id)
    if created is None:
        raise RuntimeError(f"failed to create local workspace {workspace_id}")
    return created


def delete_local_workspace(owner_user_id: str, workspace_id: str) -> bool:
    """#805: delete an owner's local workspace row. Returns False if it does
    not exist for this owner. The default workspace is not deletable (guarded
    by the caller)."""
    with get_db() as conn:
        cursor = conn.execute(
            "DELETE FROM local_workspaces WHERE owner_user_id = ? AND id = ?",
            (owner_user_id, workspace_id),
        )
    return cursor.rowcount > 0


def update_local_workspace(
    owner_user_id: str,
    workspace_id: str,
    *,
    name: str | None = None,
    region: str | None = None,
    timezone: str | None = None,
) -> dict[str, Any] | None:
    """#791: update a workspace's name/region/timezone. Only provided fields
    change. Returns the updated row, or None if not found."""
    sets: list[str] = []
    params: list[Any] = []
    if name is not None:
        clean_name = _strip_html_tags(name.strip())
        if not clean_name:
            raise ValueError("workspace name required")
        sets.append("name = ?")
        params.append(clean_name)
    if region is not None:
        sets.append("region = ?")
        params.append(region.strip() or None)
    if timezone is not None:
        sets.append("timezone = ?")
        params.append(timezone.strip() or None)
    if not sets:
        return get_local_workspace(owner_user_id, workspace_id)
    params += [owner_user_id, workspace_id]
    with get_db() as conn:
        cur = conn.execute(
            f"UPDATE local_workspaces SET {', '.join(sets)} WHERE owner_user_id = ? AND id = ?",
            tuple(params),
        )
        if cur.rowcount == 0:
            return None
    return get_local_workspace(owner_user_id, workspace_id)


def rename_local_workspace(owner_user_id: str, workspace_id: str, name: str) -> dict[str, Any] | None:
    """#791: rename a workspace (back-compat shim over update_local_workspace)."""
    return update_local_workspace(owner_user_id, workspace_id, name=name)


def requested_local_workspace_id(request: Request) -> str | None:
    header_value = request.headers.get(ACTIVE_WORKSPACE_HEADER)
    query_value = request.query_params.get("workspace_id")
    return _valid_workspace_id(header_value) or _valid_workspace_id(query_value)


def resolve_local_workspace(owner_user_id: str, requested_id: str | None) -> dict[str, Any]:
    requested = _valid_workspace_id(requested_id)
    if requested:
        found = get_local_workspace(owner_user_id, requested)
        if found:
            return found
    return ensure_default_workspace(owner_user_id)


def scope_local_auth_context(request: Request, ctx: AuthContext) -> AuthContext:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy != "local":
        return ctx
    base_user_id = local_workspace_base_user_id(ctx.user_id)
    workspace = resolve_local_workspace(base_user_id, requested_local_workspace_id(request))
    scoped_user_id = local_workspace_user_id(base_user_id, str(workspace["id"]))
    if scoped_user_id == ctx.user_id:
        return ctx
    return AuthContext(
        user_id=scoped_user_id,
        email=ctx.email,
        scopes=ctx.scopes,
        role=ctx.role,
        auth_method=ctx.auth_method,
        username=ctx.username,
        run_token_payload=ctx.run_token_payload,
    )
