"""Spend cap read + per-user override routes.

Two distinct surfaces, deliberately split by privilege:

``GET /account/spend``
    SELF ONLY. Returns the calling user's effective caps, month/day-to-date spend,
    which cap is an override vs the env default, and whether they are in the warn
    band. There is no ``user_id`` parameter: the scope is always ``auth.user_id``,
    so mounting this on a multi-tenant deployment cannot leak another user's spend.

``GET|PUT /admin/users/{user_id}/spend-caps``
    ADMIN ONLY, and admin here means "the person who pays the bill". That is true
    in single-tenant/OSS, where the admin IS the account owner. It is NOT true on
    the cloud, where ``AuthContext.role`` carries the caller's WORKSPACE member
    role, so every workspace owner would be able to raise their own platform spend
    cap. The cloud overlay therefore blocks this route and exposes an equivalent
    behind its staff allowlist. Do not relax ``_require_admin`` here.

Why a per-user override exists at all: before 2026-07-30 the user caps read only
``WORKEROS_DEFAULT_USER_*_SPEND_CAP_USD``, so giving one customer headroom meant
raising the ceiling for everybody. A $0.69 overage on a $25 cap then silently
killed every scheduled worker on the account for four days.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from auth import AuthContext, get_auth_context
from auth.guards import _require_admin
from db import Repositories, get_repos

spend_router = APIRouter()


class SpendScope(BaseModel):
    scope: str
    spent_usd: float
    cap_usd: Optional[float] = None
    cap_source: str
    used_ratio: Optional[float] = None
    warn_ratio: float
    warning: bool
    exceeded: bool
    # A cap is an ADMISSION threshold, not a ceiling: the run that crosses it still
    # completes and is billed, so spend can legitimately exceed the cap. Reporting
    # the gap is how that stays honest instead of looking like a bug.
    overshoot_usd: float


class AccountSpendResponse(BaseModel):
    user_id: str
    warn_ratio: float
    scopes: List[SpendScope]
    warnings: List[str] = []


class UserSpendCaps(BaseModel):
    user_id: str
    monthly_spend_cap_usd: Optional[float] = None
    daily_spend_cap_usd: Optional[float] = None
    effective_monthly_spend_cap_usd: Optional[float] = None
    effective_daily_spend_cap_usd: Optional[float] = None
    monthly_cap_source: str
    daily_cap_source: str


class UserSpendCapsUpdate(BaseModel):
    """``null`` clears an override so the env default applies again.

    There is no "unlimited" value on purpose: set a large number instead, so the
    effective ceiling is always an auditable figure.
    """

    model_config = ConfigDict(extra="forbid")
    monthly_spend_cap_usd: Optional[float] = None
    daily_spend_cap_usd: Optional[float] = None


def _caps_view(user_id: str) -> UserSpendCaps:
    from services.run_cost import (
        _user_daily_spend_cap_usd,
        _user_monthly_spend_cap_usd,
        user_spend_cap_overrides,
    )

    overrides = user_spend_cap_overrides(user_id)
    return UserSpendCaps(
        user_id=user_id,
        monthly_spend_cap_usd=overrides.get("monthly_spend_cap_usd"),
        daily_spend_cap_usd=overrides.get("daily_spend_cap_usd"),
        effective_monthly_spend_cap_usd=_user_monthly_spend_cap_usd(user_id),
        effective_daily_spend_cap_usd=_user_daily_spend_cap_usd(user_id),
        monthly_cap_source="override" if "monthly_spend_cap_usd" in overrides else "env_default",
        daily_cap_source="override" if "daily_spend_cap_usd" in overrides else "env_default",
    )


@spend_router.get("/account/spend", response_model=AccountSpendResponse)
def get_account_spend(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> AccountSpendResponse:
    """The caller's own spend against their own caps. No cross-user parameter."""
    from services.run_cost import spend_cap_warnings, user_spend_snapshot

    user_id = str(auth.user_id or "")
    if not user_id:
        raise HTTPException(status_code=401, detail="authentication required")
    snapshot: Dict[str, Any] = user_spend_snapshot(
        user_id,
        repos=repos,
        scope_user_id=user_id,
    )
    warnings = spend_cap_warnings(user_id, repos=repos, scope_user_id=user_id)
    return AccountSpendResponse(
        user_id=user_id,
        warn_ratio=snapshot["warn_ratio"],
        scopes=[SpendScope(**scope) for scope in snapshot["scopes"]],
        warnings=[str(item.get("message") or "") for item in warnings],
    )


@spend_router.get("/admin/users/{user_id}/spend-caps", response_model=UserSpendCaps)
def get_user_spend_caps(
    user_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> UserSpendCaps:
    _require_admin(auth)
    return _caps_view(str(user_id))


@spend_router.put("/admin/users/{user_id}/spend-caps", response_model=UserSpendCaps)
def put_user_spend_caps(
    user_id: str,
    payload: UserSpendCapsUpdate,
    auth: AuthContext = Depends(get_auth_context),
) -> UserSpendCaps:
    """Full replace: an omitted field is ``null`` and therefore CLEARS the override.

    Full replace rather than patch so "what is this user's override" always has one
    answer, and so clearing back to the platform default is expressible.
    """
    _require_admin(auth)
    from services.run_cost import set_user_spend_caps

    try:
        set_user_spend_caps(
            str(user_id),
            monthly_spend_cap_usd=payload.monthly_spend_cap_usd,
            daily_spend_cap_usd=payload.daily_spend_cap_usd,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return _caps_view(str(user_id))
