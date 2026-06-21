"""Run cost accounting + monthly spend caps.

Extracted verbatim from run_service.py: per-run cost persistence, worker /
workspace month-to-date spend lookups, and spend-cap resolution. run_service
re-imports these names for backward compatibility. The workspace-setting
accessor is lazy-imported from run_service.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("floom.run_service")


class SpendCapExceeded(ValueError):
    """#793: the worker's month-to-date cost has reached its monthly spend cap."""


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
    """#797: the workspace-level monthly spend cap from settings, or None."""
    from run_service import _workspace_setting
    raw = (_workspace_setting("monthly_spend_cap_usd") or "").strip()
    if not raw:
        return None
    try:
        cap = float(raw)
        return cap if cap >= 0 else None
    except ValueError:
        return None


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


