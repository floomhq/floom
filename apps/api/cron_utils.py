"""Shared cron-expression validation.

Single source of truth for "is this a valid cron expression" so the
create path (worker.yml → WorkerTrigger / WorkerContractTrigger),
the schedule-PATCH endpoint, and the scheduler thread all agree.

Uses croniter when available (authoritative), and falls back to a
5-field regex when croniter is not installed so validation never
silently disappears.
"""

from __future__ import annotations

import os
import re

# Standard cron has exactly 5 space-separated fields, each made of
# digits, '*', '-', ',', '/'. Used only as a fallback when croniter
# is unavailable.
_CRON_FALLBACK_RE = re.compile(r"[\d\*\-\,\/]+(?: [\d\*\-\,\/]+){4}")

# #1067 — every scheduled run spins an e2b sandbox + LLM calls, so an
# every-minute (or 6-field sub-minute) cron is a cost/availability abuse vector.
# Enforce a minimum interval between fires. Operator-overridable.
_DEFAULT_MIN_CRON_INTERVAL_SECONDS = 300


def _min_cron_interval_seconds() -> int:
    raw = os.environ.get("FLOOM_MIN_CRON_INTERVAL_SECONDS")
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    return _DEFAULT_MIN_CRON_INTERVAL_SECONDS


def is_valid_cron_expr(cron_expr: str) -> bool:
    """Return True if ``cron_expr`` is a usable cron expression.

    Authoritative path uses croniter (the same library the scheduler
    fires on). If croniter is not importable, fall back to a 5-field
    structural regex so an obviously-invalid string (e.g. "invalid")
    is still rejected.

    #1067: rejects 6-field (sub-minute / seconds) crons and any expression
    whose fire interval is below the operator minimum (default 5 minutes).
    """
    if not isinstance(cron_expr, str) or not cron_expr.strip():
        return False
    expr = cron_expr.strip()
    # Reject non-5-field crons (a 6th field adds seconds -> sub-minute).
    if len(expr.split()) != 5:
        return False
    try:
        from croniter import croniter
    except ImportError:
        return bool(_CRON_FALLBACK_RE.fullmatch(expr))
    except Exception:
        return False

    try:
        if not croniter.is_valid(expr):
            return False
        min_interval = _min_cron_interval_seconds()
        if min_interval > 0:
            # Deterministic base (avoid now()/DST edges); sample consecutive
            # fires and require the smallest gap to meet the floor.
            from datetime import datetime

            base = datetime(2024, 1, 1, 0, 0, 0)
            itr = croniter(expr, base)
            prev = itr.get_next(datetime)
            for _ in range(4):
                nxt = itr.get_next(datetime)
                if (nxt - prev).total_seconds() < min_interval:
                    return False
                prev = nxt
        return True
    except Exception:
        return False
