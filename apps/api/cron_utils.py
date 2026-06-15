"""Shared cron-expression and timezone validation.

Single source of truth for "is this a valid cron expression" and
"is this a valid IANA timezone name" so the create path
(worker.yml → WorkerTrigger / WorkerContractTrigger), the
schedule-PATCH endpoint, and the scheduler thread all agree.

Uses croniter when available (authoritative), and falls back to a
5-field regex when croniter is not installed so validation never
silently disappears. Timezone validation uses zoneinfo (stdlib ≥3.9)
with a pytz fallback and a small built-in list as last resort.
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


def is_valid_timezone(tz: str) -> bool:
    """Return True if ``tz`` is a recognised IANA timezone identifier.

    #1296: cron workers accepted an invalid ``cron_timezone`` at create/update
    time without validation; the scheduler then fell back to UTC silently.
    Validate at the API boundary so the caller gets a clean 400 instead of a
    quiet wrong-timezone run.

    Precedence:
      1. ``zoneinfo.ZoneInfo`` (stdlib ≥3.9, covers tzdata if installed).
      2. ``pytz.timezone`` fallback (older envs / some containers).
      3. Hardcoded small allow-list (UTC + major zones) as a last resort
         so the validator never accidentally rejects valid timezones due to a
         missing tzdata package.
    """
    if not isinstance(tz, str) or not tz.strip():
        return False
    clean = tz.strip()
    # Fast path for the most common values.
    if clean in {"UTC", "utc", "GMT", "gmt"}:
        return True
    try:
        import zoneinfo
        try:
            zoneinfo.ZoneInfo(clean)
            return True
        except (KeyError, zoneinfo.ZoneInfoNotFoundError):
            return False
        except Exception:
            return False
    except ImportError:
        pass
    try:
        import pytz  # type: ignore[import-untyped]
        pytz.timezone(clean)
        return True
    except Exception:
        pass
    # Minimal hardcoded list as an absolute fallback when neither zoneinfo nor
    # pytz are available.
    _COMMON_TZ = {
        "UTC", "GMT",
        "US/Eastern", "US/Central", "US/Mountain", "US/Pacific",
        "America/New_York", "America/Chicago", "America/Denver",
        "America/Los_Angeles", "America/Toronto", "America/Vancouver",
        "America/Sao_Paulo", "America/Buenos_Aires", "America/Mexico_City",
        "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome",
        "Europe/Amsterdam", "Europe/Madrid", "Europe/Warsaw", "Europe/Zurich",
        "Europe/Stockholm", "Europe/Copenhagen", "Europe/Helsinki",
        "Europe/Moscow", "Europe/Kyiv", "Europe/Athens", "Europe/Istanbul",
        "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Asia/Dubai",
        "Asia/Singapore", "Asia/Seoul", "Asia/Hong_Kong", "Asia/Bangkok",
        "Asia/Karachi", "Asia/Baghdad", "Asia/Jerusalem", "Asia/Riyadh",
        "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
        "Pacific/Auckland", "Pacific/Honolulu",
        "Africa/Cairo", "Africa/Nairobi", "Africa/Johannesburg",
    }
    return clean in _COMMON_TZ
