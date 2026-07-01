"""Run cost accounting + monthly spend caps.

Extracted verbatim from run_service.py: per-run cost persistence, worker /
workspace month-to-date spend lookups, and spend-cap resolution. run_service
re-imports these names for backward compatibility. The workspace-setting
accessor is lazy-imported from run_service.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger("floom.run_service")


class SpendCapExceeded(ValueError):
    """#793: the worker's month-to-date cost has reached its monthly spend cap."""


def _default_spend_cap_usd(env_var: str, default: str) -> Optional[float]:
    raw = (os.environ.get(env_var, default) or "").strip()
    if not raw:
        return None
    try:
        cap = float(raw)
        return cap if cap >= 0 else None
    except ValueError:
        return float(default)


def _persist_run_cost(
    run_id: str,
    *,
    user_id: Optional[str] = None,
    repos: Any = None,
) -> None:
    """Compute + store total_tokens/total_cost_usd for a terminal run (#793/#795).

    Routes the write through the run repository (``repos.runs.update``) when a
    repo + user_id are supplied. This is REQUIRED for the cloud: its data lives
    in Supabase, and the old raw ``get_db()`` write went to the engine's local
    sqlite file, so total_tokens/total_cost_usd never reached the cloud's runs
    table (every cloud run showed null tokens/cost). The repo path writes to
    whichever backend the deployment uses. Falls back to the direct sqlite write
    only when called without a repo (single-tenant / legacy callers / tests).
    """
    from cost import resolved_cost_usd_from_transcript, total_tokens_from_transcript

    tokens = total_tokens_from_transcript(run_id)
    # Prefer the trace-derived (model-aware, summed-per-generation) cost from
    # Track A; fall back to the blended estimate when the run wasn't
    # AI-instrumented (pure-script, or analytics disabled at run time).
    cost = resolved_cost_usd_from_transcript(run_id)

    if repos is not None and user_id is not None:
        repos.runs.update(
            user_id=user_id,
            run_id=run_id,
            total_tokens=tokens,
            total_cost_usd=cost,
        )
        return

    from db import get_db

    with get_db() as conn:
        conn.execute(
            "UPDATE runs SET total_tokens = ?, total_cost_usd = ? WHERE id = ?",
            (tokens, cost, run_id),
        )


def _worker_month_to_date_cost_usd(worker_id: str) -> float:
    """Sum of total_cost_usd for this worker's runs in the current UTC month."""
    from db import get_db

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(total_cost_usd), 0.0) AS spent FROM runs "
                "WHERE worker_id = ? "
                "AND created_at >= strftime('%Y-%m-01T00:00:00+00:00', 'now')",
                (worker_id,),
            ).fetchone()
        return float(row["spent"] or 0.0) if row else 0.0
    except Exception:
        logger.debug("month-to-date cost lookup failed for %s", worker_id, exc_info=True)
        return 0.0


def _spend_cap_for_config(config: Any) -> Optional[float]:
    try:
        cap = config.runtime.limits.max_monthly_cost_usd if config and config.runtime and config.runtime.limits else None
    except Exception:
        return None
    return float(cap) if cap is not None else None


def _workspace_monthly_spend_cap_usd() -> Optional[float]:
    """#797: the workspace-level monthly spend cap from settings, then env default."""
    from run_service import _workspace_setting
    raw = (_workspace_setting("monthly_spend_cap_usd") or "").strip()
    if not raw:
        return _default_spend_cap_usd("WORKEROS_DEFAULT_MONTHLY_SPEND_CAP_USD", "25")
    try:
        cap = float(raw)
        return cap if cap >= 0 else None
    except ValueError:
        return _default_spend_cap_usd("WORKEROS_DEFAULT_MONTHLY_SPEND_CAP_USD", "25")


def _workspace_daily_spend_cap_usd() -> Optional[float]:
    """Workspace-level daily spend cap from settings, then env default."""
    from run_service import _workspace_setting
    raw = (_workspace_setting("daily_spend_cap_usd") or "").strip()
    if not raw:
        return _default_spend_cap_usd("WORKEROS_DEFAULT_DAILY_SPEND_CAP_USD", "5")
    try:
        cap = float(raw)
        return cap if cap >= 0 else None
    except ValueError:
        return _default_spend_cap_usd("WORKEROS_DEFAULT_DAILY_SPEND_CAP_USD", "5")


def _user_monthly_spend_cap_usd() -> Optional[float]:
    """User-level monthly spend cap across all workspaces."""
    return _default_spend_cap_usd("WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD", "25")


def _user_daily_spend_cap_usd() -> Optional[float]:
    """User-level daily spend cap across all workspaces."""
    return _default_spend_cap_usd("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "5")


def _workspace_month_to_date_cost_usd() -> float:
    """#797: sum of total_cost_usd across ALL runs in the current UTC month."""
    from db import get_db

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(total_cost_usd), 0.0) AS spent FROM runs "
                "WHERE created_at >= strftime('%Y-%m-01T00:00:00+00:00', 'now')"
            ).fetchone()
        return float(row["spent"] or 0.0) if row else 0.0
    except Exception:
        logger.debug("workspace month-to-date cost lookup failed", exc_info=True)
        return 0.0


def _workspace_day_to_date_cost_usd() -> float:
    """Sum of total_cost_usd across ALL runs since UTC midnight."""
    from db import get_db

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(total_cost_usd), 0.0) AS spent FROM runs "
                "WHERE created_at >= strftime('%Y-%m-%dT00:00:00+00:00', 'now')"
            ).fetchone()
        return float(row["spent"] or 0.0) if row else 0.0
    except Exception:
        logger.debug("workspace day-to-date cost lookup failed", exc_info=True)
        return 0.0


def _user_month_to_date_cost_usd(user_id: str) -> float:
    """Sum total_cost_usd for runs triggered by this user in the current UTC month."""
    if not user_id:
        return 0.0
    from db import get_db

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(r.total_cost_usd), 0.0) AS spent "
                "FROM runs r JOIN workers w ON w.id = r.worker_id "
                "WHERE COALESCE(r.actor_user_id, w.owner_id) = ? "
                "AND r.created_at >= strftime('%Y-%m-01T00:00:00+00:00', 'now')",
                (user_id,),
            ).fetchone()
        return float(row["spent"] or 0.0) if row else 0.0
    except Exception:
        logger.debug("user month-to-date cost lookup failed for %s", user_id, exc_info=True)
        return 0.0


def _user_day_to_date_cost_usd(user_id: str) -> float:
    """Sum total_cost_usd for runs triggered by this user since UTC midnight."""
    if not user_id:
        return 0.0
    from db import get_db

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(r.total_cost_usd), 0.0) AS spent "
                "FROM runs r JOIN workers w ON w.id = r.worker_id "
                "WHERE COALESCE(r.actor_user_id, w.owner_id) = ? "
                "AND r.created_at >= strftime('%Y-%m-%dT00:00:00+00:00', 'now')",
                (user_id,),
            ).fetchone()
        return float(row["spent"] or 0.0) if row else 0.0
    except Exception:
        logger.debug("user day-to-date cost lookup failed for %s", user_id, exc_info=True)
        return 0.0

