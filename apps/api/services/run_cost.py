"""Run cost accounting + monthly spend caps.

Extracted verbatim from run_service.py: per-run cost persistence, worker /
workspace month-to-date spend lookups, and spend-cap resolution. run_service
re-imports these names for backward compatibility. The workspace-setting
accessor is lazy-imported from run_service.

SEMANTICS OF A SPEND CAP (read this before changing anything here)
-----------------------------------------------------------------
A spend cap is an ADMISSION THRESHOLD, not a hard ceiling. ``_enforce_run_spend_caps``
refuses to admit a NEW run once *already finalized* cost has reached the cap. A run's
cost is only finalized after it terminates (``_persist_run_cost``), so:

  * the run that crosses the cap always completes and is billed in full, and
  * runs already in flight are invisible to the check, so several concurrent runs
    can each be admitted just below the cap.

Therefore the guaranteed bound is:

    final spend <= cap + (total cost of the runs in flight when the cap was crossed)

which is itself bounded by ``WORKEROS_MAX_CONCURRENT_RUNS`` (or the injected
distributed limiter) times the cost of the most expensive single run. Observed in
production 2026-07-25: $25.69 against a $25 cap, i.e. 2.8% overshoot from a single
run.

This is deliberate. A pre-run reservation would need a pre-run cost ESTIMATE, which
does not exist for agentic runs (real spend varies by ~100x for the same recipe), plus
hold/release/reconcile on every terminal path and a reaper for reservations leaked by
crashed executors: a new distributed-state surface in the money path to remove a
few-percent error. If overshoot ever becomes material the cheap correct lever is to
lower the admission threshold (or the cap), not to build a ledger.

What the code DOES owe you is visibility: the exceeded message and
``user_spend_snapshot`` both report ``overshoot_usd``, and ``spend_cap_warnings``
surfaces the approach to the cap BEFORE runs start failing.
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("floom.run_service")

# Fraction of a cap at which a scope is reported as "warning". Crossing it changes
# nothing about admission; it only makes the approach visible (overview inbox +
# logs + GET /account/spend) so a user finds out BEFORE their automations stop.
DEFAULT_SPEND_CAP_WARN_RATIO = 0.8


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
        existing = repos.runs.get_any(run_id=run_id) or {}
        proxy_tokens = existing.get("proxy_total_tokens")
        proxy_cost = existing.get("proxy_total_cost_usd")
        combined_tokens = (
            sum(value for value in (proxy_tokens, tokens) if value is not None)
            if proxy_tokens is not None or tokens is not None else None
        )
        combined_cost = (
            sum(value for value in (proxy_cost, cost) if value is not None)
            if proxy_cost is not None or cost is not None else None
        )
        repos.runs.update(
            user_id=user_id,
            run_id=run_id,
            total_tokens=combined_tokens,
            total_cost_usd=combined_cost,
        )
        return

    from db import get_db

    with get_db() as conn:
        existing = conn.execute(
            "SELECT proxy_total_tokens, proxy_total_cost_usd FROM runs WHERE id = ?",
            (run_id,),
        ).fetchone()
        proxy_tokens = existing["proxy_total_tokens"] if existing is not None else None
        proxy_cost = existing["proxy_total_cost_usd"] if existing is not None else None
        combined_tokens = sum(v for v in (proxy_tokens, tokens) if v is not None) if proxy_tokens is not None or tokens is not None else None
        combined_cost = sum(v for v in (proxy_cost, cost) if v is not None) if proxy_cost is not None or cost is not None else None
        conn.execute(
            "UPDATE runs SET total_tokens = ?, total_cost_usd = ? WHERE id = ?",
            (combined_tokens, combined_cost, run_id),
        )


def _worker_month_to_date_cost_usd(
    worker_id: str,
    *,
    repos: Any = None,
    user_id: str | None = None,
) -> float:
    """Sum of total_cost_usd for this worker's runs in the current UTC month."""
    if repos is not None and user_id:
        repo_total = _repo_cost_total_usd(
            repos,
            user_id=user_id,
            since=_utc_period_start_iso("month"),
            worker_id=worker_id,
        )
        if repo_total is not None:
            return repo_total

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


def _utc_period_start_iso(period: str) -> str:
    now = datetime.now(timezone.utc)
    if period == "month":
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
    return now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()


def _repo_cost_total_usd(
    repos: Any,
    *,
    user_id: str,
    since: str,
    worker_id: str | None = None,
    actor_user_id: str | None = None,
    workspace_scoped: bool = False,
) -> float | None:
    runs = getattr(repos, "runs", None)
    cost_total = getattr(runs, "cost_total_usd", None)
    if not callable(cost_total):
        return None
    try:
        return float(
            cost_total(
                user_id=user_id,
                since=since,
                worker_id=worker_id,
                actor_user_id=actor_user_id,
                workspace_scoped=workspace_scoped,
            )
            or 0.0
        )
    except Exception:
        logger.debug("repo cost_total_usd lookup failed", exc_info=True)
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


# --- per-user spend cap overrides -------------------------------------------
# Until 2026-07-30 the user caps read ONLY the env defaults, so the only way to
# give ONE customer headroom was to raise the cap for EVERYONE. That is what turned
# a $0.69 overage into 4 days of silently dead schedules.
#
# The override is NOT modelled on the workspace-cap settings path
# (`_workspace_setting` -> sqlite `workspace_settings`). That path does not work on
# the cloud: the cloud's sqlite is a container-local file with no volume, so writes
# are wiped on every redeploy and are invisible to the separate executor service,
# and the reader hardcodes workspace_id="local-default" while the writer keys rows
# by the real `ws_...` id. Instead this uses the same injection seam the cloud
# already uses for repositories and the run limiter: the deployment registers a
# durable store, and the engine falls back to sqlite for single-node/OSS.
_USER_SPEND_CAP_STORE: Any = None
_user_spend_cap_store_lock = threading.Lock()


def register_user_spend_cap_store(store: Any) -> None:
    """Inject a durable per-user spend-cap store.

    ``store`` must expose::

        get(user_id: str) -> Mapping with optional float keys
                             "monthly_spend_cap_usd" / "daily_spend_cap_usd"
        set(user_id: str, *, monthly_spend_cap_usd: float | None,
            daily_spend_cap_usd: float | None) -> None

    Unset (the default) = the sqlite-backed store below, so OSS/single-node
    behaviour is unchanged. The cloud overlay registers a Supabase-backed store in
    startup, mirroring ``register_repositories`` / ``register_run_limiter``.
    """
    global _USER_SPEND_CAP_STORE
    with _user_spend_cap_store_lock:
        _USER_SPEND_CAP_STORE = store


def clear_user_spend_cap_store() -> None:
    """Drop the injected store (revert to sqlite). For tests."""
    global _USER_SPEND_CAP_STORE
    with _user_spend_cap_store_lock:
        _USER_SPEND_CAP_STORE = None


class _SqliteUserSpendCapStore:
    """Default store: the engine's `user_spend_caps` table (migration 96)."""

    def get(self, user_id: str) -> Dict[str, Optional[float]]:
        from db import get_db

        with get_db() as conn:
            row = conn.execute(
                "SELECT monthly_spend_cap_usd, daily_spend_cap_usd "
                "FROM user_spend_caps WHERE user_id = ? LIMIT 1",
                (user_id,),
            ).fetchone()
        if row is None:
            return {}
        return {
            "monthly_spend_cap_usd": row["monthly_spend_cap_usd"],
            "daily_spend_cap_usd": row["daily_spend_cap_usd"],
        }

    def set(
        self,
        user_id: str,
        *,
        monthly_spend_cap_usd: Optional[float],
        daily_spend_cap_usd: Optional[float],
    ) -> None:
        from db import get_db, now_iso

        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO user_spend_caps
                    (user_id, monthly_spend_cap_usd, daily_spend_cap_usd, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    monthly_spend_cap_usd = excluded.monthly_spend_cap_usd,
                    daily_spend_cap_usd = excluded.daily_spend_cap_usd,
                    updated_at = excluded.updated_at
                """,
                (user_id, monthly_spend_cap_usd, daily_spend_cap_usd, now_iso()),
            )


def _active_user_spend_cap_store() -> Any:
    store = _USER_SPEND_CAP_STORE
    return store if store is not None else _SqliteUserSpendCapStore()


def _coerce_cap_override(value: Any) -> Optional[float]:
    """A usable override is a finite number >= 0. Anything else = no override."""
    if value is None:
        return None
    try:
        cap = float(value)
    except (TypeError, ValueError):
        return None
    if cap != cap or cap in (float("inf"), float("-inf")) or cap < 0:
        return None
    return cap


def user_spend_cap_overrides(user_id: str) -> Dict[str, Optional[float]]:
    """Per-user cap overrides, or {} when none are set / the store is unreachable.

    FAIL-CLOSED: a store error resolves to "no override", i.e. the env default cap
    still applies. It must never resolve to "no cap" — a store outage would then
    silently remove the platform's cost control.
    """
    if not user_id:
        return {}
    try:
        raw = _active_user_spend_cap_store().get(user_id) or {}
    except Exception:
        logger.warning(
            "user spend cap override lookup failed for %s; falling back to env defaults",
            user_id,
            exc_info=True,
        )
        return {}
    out: Dict[str, Optional[float]] = {}
    for key in ("monthly_spend_cap_usd", "daily_spend_cap_usd"):
        cap = _coerce_cap_override(raw.get(key) if hasattr(raw, "get") else None)
        if cap is not None:
            out[key] = cap
    return out


def set_user_spend_caps(
    user_id: str,
    *,
    monthly_spend_cap_usd: Optional[float],
    daily_spend_cap_usd: Optional[float],
) -> None:
    """Write the per-user overrides. ``None`` clears an override (env default wins).

    There is no "unlimited" sentinel on purpose: pass a large number instead, so the
    effective ceiling is always an auditable figure rather than an absent one.
    """
    if not str(user_id or "").strip():
        raise ValueError("user_id is required")
    for label, value in (
        ("monthly_spend_cap_usd", monthly_spend_cap_usd),
        ("daily_spend_cap_usd", daily_spend_cap_usd),
    ):
        if value is None:
            continue
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError(f"{label} must be a finite number")
        if value < 0:
            raise ValueError(f"{label} must be >= 0")
        if value > 1_000_000:
            raise ValueError(f"{label} must be <= 1000000")
    _active_user_spend_cap_store().set(
        str(user_id),
        monthly_spend_cap_usd=monthly_spend_cap_usd,
        daily_spend_cap_usd=daily_spend_cap_usd,
    )


def _user_monthly_spend_cap_usd(user_id: str) -> Optional[float]:
    """User-level monthly spend cap across all workspaces.

    Per-user override first, then ``WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD``.
    ``user_id`` is REQUIRED: a caller in the money path that does not know which
    principal it is billing must fail loudly rather than silently bill an anonymous
    env default.
    """
    override = user_spend_cap_overrides(user_id).get("monthly_spend_cap_usd")
    if override is not None:
        return override
    return _default_spend_cap_usd("WORKEROS_DEFAULT_USER_MONTHLY_SPEND_CAP_USD", "25")


def _user_daily_spend_cap_usd(user_id: str) -> Optional[float]:
    """User-level daily spend cap across all workspaces (override, then env)."""
    override = user_spend_cap_overrides(user_id).get("daily_spend_cap_usd")
    if override is not None:
        return override
    return _default_spend_cap_usd("WORKEROS_DEFAULT_USER_DAILY_SPEND_CAP_USD", "5")


def _spend_cap_warn_ratio() -> float:
    raw = (os.environ.get("WORKEROS_SPEND_CAP_WARN_RATIO", "") or "").strip()
    if not raw:
        return DEFAULT_SPEND_CAP_WARN_RATIO
    try:
        ratio = float(raw)
    except ValueError:
        return DEFAULT_SPEND_CAP_WARN_RATIO
    if not 0 < ratio <= 1:
        return DEFAULT_SPEND_CAP_WARN_RATIO
    return ratio


def _spend_scope(scope: str, spent: float, cap: Optional[float], source: str) -> Dict[str, Any]:
    ratio = _spend_cap_warn_ratio()
    pct = (spent / cap) if cap else None
    return {
        "scope": scope,
        "spent_usd": round(float(spent), 4),
        "cap_usd": cap,
        "cap_source": source,
        "used_ratio": round(pct, 4) if pct is not None else None,
        "warn_ratio": ratio,
        "warning": bool(cap is not None and cap > 0 and spent >= cap * ratio and spent < cap),
        "exceeded": bool(cap is not None and spent >= cap),
        # See the module docstring: a cap is an admission threshold, so spend can
        # legitimately land above it. Report the gap instead of hiding it.
        "overshoot_usd": round(max(0.0, float(spent) - float(cap)), 4) if cap is not None else 0.0,
    }


def user_spend_snapshot(
    user_id: str,
    *,
    repos: Any = None,
    scope_user_id: str | None = None,
) -> Dict[str, Any]:
    """Effective caps + month/day-to-date spend for every scope that can refuse
    this caller's runs.

    ALL FOUR admission scopes are reported, not just the user pair. The workspace
    caps are the same kind of silent wall (they sit in the same ladder in
    ``_enforce_run_spend_caps``, and on cloud their settings override does not
    work at all), so a user who is fine on their own budget but about to be cut off
    by the workspace budget has to be able to see that too.

    Powers ``GET /account/spend`` and the ``spend_cap_warning`` overview items.
    """
    overrides = user_spend_cap_overrides(user_id)
    scopes = [
        _spend_scope(
            "user_monthly",
            _user_month_to_date_cost_usd(user_id, repos=repos, scope_user_id=scope_user_id),
            _user_monthly_spend_cap_usd(user_id),
            "override" if "monthly_spend_cap_usd" in overrides else "env_default",
        ),
        _spend_scope(
            "user_daily",
            _user_day_to_date_cost_usd(user_id, repos=repos, scope_user_id=scope_user_id),
            _user_daily_spend_cap_usd(user_id),
            "override" if "daily_spend_cap_usd" in overrides else "env_default",
        ),
        _spend_scope(
            "workspace_monthly",
            _workspace_month_to_date_cost_usd(repos=repos, user_id=scope_user_id),
            _workspace_monthly_spend_cap_usd(),
            "workspace_setting_or_env_default",
        ),
        _spend_scope(
            "workspace_daily",
            _workspace_day_to_date_cost_usd(repos=repos, user_id=scope_user_id),
            _workspace_daily_spend_cap_usd(),
            "workspace_setting_or_env_default",
        ),
    ]
    return {
        "user_id": user_id,
        "warn_ratio": _spend_cap_warn_ratio(),
        "scopes": scopes,
    }


_SPEND_SCOPE_LABELS = {
    "user_monthly": ("your monthly", "next month"),
    "user_daily": ("your daily", "tomorrow"),
    "workspace_monthly": ("this workspace's monthly", "next month"),
    "workspace_daily": ("this workspace's daily", "tomorrow"),
}


def spend_cap_warnings(
    user_id: str,
    *,
    repos: Any = None,
    scope_user_id: str | None = None,
) -> List[Dict[str, Any]]:
    """Scopes in the warn band OR already exceeded, worst first.

    EXCEEDED scopes are included deliberately. Reporting only the 80-99% band would
    make the notice disappear at exactly the moment it starts costing the user
    something, which is a smaller version of the original bug: the only remaining
    signal would be a failed run on a worker that happens to be scheduled soon.

    Never raises: a warning surface that can break its caller is a warning surface
    that ends up wrapped in a bare except and forgotten.
    """
    try:
        snapshot = user_spend_snapshot(user_id, repos=repos, scope_user_id=scope_user_id)
    except Exception:
        logger.warning("spend cap warning computation failed for %s", user_id, exc_info=True)
        return []
    warnings = [
        scope for scope in snapshot["scopes"] if scope.get("warning") or scope.get("exceeded")
    ]
    warnings.sort(key=lambda scope: scope.get("used_ratio") or 0.0, reverse=True)
    for scope in warnings:
        period, reset = _SPEND_SCOPE_LABELS.get(scope["scope"], ("the", "later"))
        if scope.get("exceeded"):
            over = (
                f" (${scope['overshoot_usd']:.2f} over)" if scope.get("overshoot_usd") else ""
            )
            scope["message"] = (
                f"Runs are being refused: ${scope['spent_usd']:.2f} of the "
                f"${scope['cap_usd']:.2f} {period} spend cap is used{over}. "
                f"Raise the cap or wait until {reset}."
            )
        else:
            scope["message"] = (
                f"${scope['spent_usd']:.2f} of the ${scope['cap_usd']:.2f} {period} spend cap "
                f"is used ({(scope['used_ratio'] or 0) * 100:.0f}%). "
                f"Runs stop being accepted at 100% until {reset}."
            )
    return warnings


def _workspace_month_to_date_cost_usd(
    *,
    repos: Any = None,
    user_id: str | None = None,
) -> float:
    """#797: sum of total_cost_usd across ALL runs in the current UTC month."""
    if repos is not None and user_id:
        repo_total = _repo_cost_total_usd(
            repos,
            user_id=user_id,
            since=_utc_period_start_iso("month"),
            workspace_scoped=True,
        )
        if repo_total is not None:
            return repo_total

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


def _workspace_day_to_date_cost_usd(
    *,
    repos: Any = None,
    user_id: str | None = None,
) -> float:
    """Sum of total_cost_usd across ALL runs since UTC midnight."""
    if repos is not None and user_id:
        repo_total = _repo_cost_total_usd(
            repos,
            user_id=user_id,
            since=_utc_period_start_iso("day"),
            workspace_scoped=True,
        )
        if repo_total is not None:
            return repo_total

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


def _user_month_to_date_cost_usd(
    user_id: str,
    *,
    repos: Any = None,
    scope_user_id: str | None = None,
) -> float:
    """Sum total_cost_usd for runs triggered by this user in the current UTC month."""
    if not user_id:
        return 0.0
    if repos is not None and scope_user_id:
        repo_total = _repo_cost_total_usd(
            repos,
            user_id=scope_user_id,
            since=_utc_period_start_iso("month"),
            actor_user_id=user_id,
        )
        if repo_total is not None:
            return repo_total

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


def _user_day_to_date_cost_usd(
    user_id: str,
    *,
    repos: Any = None,
    scope_user_id: str | None = None,
) -> float:
    """Sum total_cost_usd for runs triggered by this user since UTC midnight."""
    if not user_id:
        return 0.0
    if repos is not None and scope_user_id:
        repo_total = _repo_cost_total_usd(
            repos,
            user_id=scope_user_id,
            since=_utc_period_start_iso("day"),
            actor_user_id=user_id,
        )
        if repo_total is not None:
            return repo_total

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
