"""Per-user appearance settings routes.

``GET/PUT /user/settings`` — the caller's theme/accent prefs (#773), scoped to
the authenticated user. Extracted verbatim from main.py into an APIRouter.

Following the channels/* convention, db helpers are imported lazily inside the
handlers (the test suite purges ``db``/``auth`` and re-imports them between
cases). ``AuthContext``/``get_auth_context`` appear in route signatures, so
they are real module-level imports; the user-settings test fixture purges
``routers.*`` alongside ``main``/``auth`` so this router rebuilds with fresh
deps.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from auth import AuthContext, get_auth_context

user_settings_router = APIRouter()


class _UserSettings(BaseModel):
    theme: Literal["day", "dark", "system"] = "system"
    accent: Optional[str] = None


class _UserSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    theme: Optional[Literal["day", "dark", "system"]] = None
    accent: Optional[str] = None


@user_settings_router.get("/user/settings", response_model=_UserSettings)
def get_user_settings(auth: AuthContext = Depends(get_auth_context)) -> _UserSettings:
    """#773: per-user appearance prefs (theme/accent), scoped to the caller."""
    from db import get_db

    with get_db() as conn:
        row = conn.execute(
            "SELECT theme, accent FROM user_settings WHERE user_id = ?",
            (auth.user_id,),
        ).fetchone()
    if row is None:
        return _UserSettings()
    return _UserSettings(theme=row["theme"] or "system", accent=row["accent"])


@user_settings_router.put("/user/settings", response_model=_UserSettings)
def put_user_settings(
    payload: _UserSettingsUpdate,
    auth: AuthContext = Depends(get_auth_context),
) -> _UserSettings:
    """#773: upsert the caller's appearance prefs. Partial — only provided
    fields change."""
    from db import get_db, now_iso

    with get_db() as conn:
        existing = conn.execute(
            "SELECT theme, accent FROM user_settings WHERE user_id = ?",
            (auth.user_id,),
        ).fetchone()
        theme = payload.theme if payload.theme is not None else (existing["theme"] if existing else "system")
        accent = payload.accent if payload.accent is not None else (existing["accent"] if existing else None)
        conn.execute(
            """
            INSERT INTO user_settings (user_id, theme, accent, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme,
                accent = excluded.accent, updated_at = excluded.updated_at
            """,
            (auth.user_id, theme, accent, now_iso()),
        )
    return _UserSettings(theme=theme, accent=accent)
