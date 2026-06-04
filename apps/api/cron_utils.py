"""Shared cron-expression validation.

Single source of truth for "is this a valid cron expression" so the
create path (worker.yml → WorkerTrigger / WorkerContractTrigger),
the schedule-PATCH endpoint, and the scheduler thread all agree.

Uses croniter when available (authoritative), and falls back to a
5-field regex when croniter is not installed so validation never
silently disappears.
"""

from __future__ import annotations

import re

# Standard cron has exactly 5 space-separated fields, each made of
# digits, '*', '-', ',', '/'. Used only as a fallback when croniter
# is unavailable.
_CRON_FALLBACK_RE = re.compile(r"[\d\*\-\,\/]+(?: [\d\*\-\,\/]+){4}")


def is_valid_cron_expr(cron_expr: str) -> bool:
    """Return True if ``cron_expr`` is a usable cron expression.

    Authoritative path uses croniter (the same library the scheduler
    fires on). If croniter is not importable, fall back to a 5-field
    structural regex so an obviously-invalid string (e.g. "invalid")
    is still rejected.
    """
    if not isinstance(cron_expr, str) or not cron_expr.strip():
        return False
    try:
        from croniter import croniter

        return croniter.is_valid(cron_expr.strip())
    except ImportError:
        return bool(_CRON_FALLBACK_RE.fullmatch(cron_expr.strip()))
    except Exception:
        return False
