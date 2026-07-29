"""A dead scheduler must stop reporting its workers as healthy (part 2).

Part 1 covers a LIVE scheduler whose fire is refused: it now records a synthetic
FAILED run, so ``last_run_status`` goes red and the existing ladder downgrades
the worker. This covers the other half of the same production incident, where
the scheduler process is entirely dead and writes NOTHING at all: no run row, no
log line, no last_run_status change. Seventeen workers reported "healthy" while
they had not fired for four days.

The only durable fingerprint is ``worker_triggers.next_run_at``, which the
scheduler rewrites to the next cron slot on BOTH its success and its failure
path. Nothing alive means nothing advances it, so it drifts into the past.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from services.worker_serialize import (  # noqa: E402
    _resolve_worker_status,
    _schedule_stale_grace_seconds,
    _schedule_stale_worker_ids,
)

WORKER_ID = "cron-worker"
USER_ID = "local-user"

# Well past the 900s default grace: the shape of the real outage.
FOUR_DAYS_SECONDS = 4 * 24 * 3600


def _iso(offset_seconds: float) -> str:
    """An ISO-8601 UTC timestamp *offset_seconds* from now, as the scheduler writes it."""
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat()


class _StalenessRepos:
    """Repos double whose worker repo implements the optional batch hook."""

    def __init__(self, next_run_at_by_id: dict[str, object], *, error: Exception | None = None):
        self.calls: list[dict] = []
        self._rows = next_run_at_by_id
        self._error = error
        self.workers = SimpleNamespace(schedule_staleness_batch=self._batch)

    def _batch(self, *, user_id: str, worker_ids: list[str]) -> dict[str, object]:
        self.calls.append({"user_id": user_id, "worker_ids": list(worker_ids)})
        if self._error is not None:
            raise self._error
        return {worker_id: self._rows.get(worker_id) for worker_id in worker_ids}


def _worker(**overrides) -> dict:
    worker = {"id": WORKER_ID, "status": "healthy", "archived": False, "enabled": True}
    worker.update(overrides)
    return worker


def _status(
    worker: dict,
    *,
    repos,
    config=None,
    available_secret_names=(),
    last_run_status=None,
    has_run: bool = True,
):
    """Resolve exactly as the LIST and DETAIL paths do: batch, then downgrade."""
    stale_ids = _schedule_stale_worker_ids([worker["id"]], user_id=USER_ID, repos=repos)
    return _resolve_worker_status(
        worker,
        config=config,
        available_secret_names=available_secret_names,
        last_run_status=last_run_status,
        has_run=has_run,
        schedule_stale=worker["id"] in stale_ids,
    )


def test_dead_scheduler_downgrades_a_green_cron_worker():
    """THE production bug: last run completed days ago, cron never fired since."""
    from models import RunStatus, WorkerStatus

    repos = _StalenessRepos({WORKER_ID: _iso(-FOUR_DAYS_SECONDS)})
    assert _status(
        _worker(),
        repos=repos,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.NEEDS_ATTENTION


def test_future_next_run_at_stays_healthy():
    from models import RunStatus, WorkerStatus

    repos = _StalenessRepos({WORKER_ID: _iso(600)})
    assert _status(
        _worker(),
        repos=repos,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.HEALTHY


def test_grace_window_boundary():
    """Inside the 900s grace is healthy; past it is needs_attention.

    The grace absorbs the poll interval, a slow fire and clock skew so a healthy
    deployment never flickers into needs_attention.
    """
    from models import RunStatus, WorkerStatus

    just_inside = _StalenessRepos({WORKER_ID: _iso(-600)})
    assert _status(
        _worker(),
        repos=just_inside,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.HEALTHY

    just_outside = _StalenessRepos({WORKER_ID: _iso(-1200)})
    assert _status(
        _worker(),
        repos=just_outside,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.NEEDS_ATTENTION


def test_grace_boundary_is_exact_against_a_pinned_now():
    """Exactly at the grace edge is still healthy; one second past it is stale.

    Pinning *now* is also what the request paths do: one instant for the whole
    response, so two workers with the same slot can never disagree.
    """
    now = datetime(2026, 7, 29, 12, 0, 0, tzinfo=timezone.utc)
    at_edge = (now - timedelta(seconds=900)).isoformat()
    past_edge = (now - timedelta(seconds=901)).isoformat()
    repos = _StalenessRepos({"at-edge": at_edge, "past-edge": past_edge})

    assert _schedule_stale_worker_ids(
        ["at-edge", "past-edge"], user_id=USER_ID, repos=repos, now=now
    ) == {"past-edge"}


def test_archived_and_disabled_workers_are_unaffected():
    """Archived and disabled workers resolve identically stale or not.

    Archived workers are intentionally inactive (their trigger legitimately
    stops advancing) and a disabled worker already carries the more specific
    "paused" reason.
    """
    from models import RunStatus, WorkerStatus

    archived = _worker(archived=True)
    disabled = _worker(enabled=False)
    for worker in (archived, disabled):
        fresh = _resolve_worker_status(
            worker,
            config=None,
            available_secret_names=[],
            last_run_status=RunStatus.COMPLETED,
            has_run=True,
            schedule_stale=False,
        )
        stale = _resolve_worker_status(
            worker,
            config=None,
            available_secret_names=[],
            last_run_status=RunStatus.COMPLETED,
            has_run=True,
            schedule_stale=True,
        )
        assert stale == fresh, worker

    assert _resolve_worker_status(
        archived,
        config=None,
        available_secret_names=[],
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
        schedule_stale=True,
    ) == WorkerStatus.HEALTHY


def test_missing_secret_and_ready_are_not_overwritten():
    """Downgrade only: never override a more specific status, never fabricate one."""
    from models import RunStatus, WorkerStatus

    repos = _StalenessRepos({WORKER_ID: _iso(-FOUR_DAYS_SECONDS)})

    # Only ``config.secrets`` is read by the resolver.
    config = SimpleNamespace(secrets=["OPENAI_API_KEY"])
    assert _status(
        _worker(),
        repos=repos,
        config=config,
        available_secret_names=[],
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.MISSING_SECRET

    # Never run: "healthy" was never earned, so READY is the honest answer.
    assert _status(
        _worker(),
        repos=repos,
        last_run_status=None,
        has_run=False,
    ) == WorkerStatus.READY

    # An already-broken raw state keeps its own reason.
    assert _status(
        _worker(status="error"),
        repos=repos,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.ERROR


def test_backend_without_the_batch_hook_behaves_exactly_as_before():
    """The cloud repository lives in another repo and has no such method yet."""
    from models import RunStatus, WorkerStatus

    no_hook = SimpleNamespace(workers=SimpleNamespace())
    assert _schedule_stale_worker_ids([WORKER_ID], user_id=USER_ID, repos=no_hook) == set()
    assert _status(
        _worker(),
        repos=no_hook,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.HEALTHY

    # A hook that throws must never escape into GET /workers either.
    throwing = _StalenessRepos({}, error=RuntimeError("backend down"))
    assert _schedule_stale_worker_ids([WORKER_ID], user_id=USER_ID, repos=throwing) == set()
    assert _status(
        _worker(),
        repos=throwing,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.HEALTHY


def test_unusable_next_run_at_values_are_never_stale():
    from models import WorkerStatus

    repos = _StalenessRepos(
        {
            "worker-null": None,
            "worker-blank": "   ",
            "worker-garbage": "not-a-timestamp",
            "worker-number": 1751500000,
        }
    )
    assert _schedule_stale_worker_ids(
        ["worker-null", "worker-blank", "worker-garbage", "worker-number"],
        user_id=USER_ID,
        repos=repos,
    ) == set()

    # A naive (offset-less) timestamp is read as UTC, not discarded.
    naive = _StalenessRepos(
        {WORKER_ID: (datetime.now(timezone.utc) - timedelta(days=4)).replace(tzinfo=None).isoformat()}
    )
    assert _schedule_stale_worker_ids([WORKER_ID], user_id=USER_ID, repos=naive) == {WORKER_ID}
    assert _status(_worker(), repos=naive, has_run=True) == WorkerStatus.NEEDS_ATTENTION


def test_one_batched_call_for_the_whole_page():
    """No N+1: GET /workers resolves staleness for every card in one query."""
    worker_ids = [f"worker-{index}" for index in range(25)]
    repos = _StalenessRepos({worker_ids[3]: _iso(-FOUR_DAYS_SECONDS)})

    assert _schedule_stale_worker_ids(worker_ids, user_id=USER_ID, repos=repos) == {worker_ids[3]}
    assert len(repos.calls) == 1
    assert repos.calls[0] == {"user_id": USER_ID, "worker_ids": worker_ids}

    # An empty page never touches the repository at all.
    assert _schedule_stale_worker_ids([], user_id=USER_ID, repos=repos) == set()
    assert len(repos.calls) == 1


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("60", 60.0),
        ("1800.5", 1800.5),
        ("not-a-number", 900.0),
        ("0", 900.0),
        ("-5", 900.0),
        ("", 900.0),
        ("inf", 900.0),
    ],
)
def test_grace_env_var_parsing(monkeypatch, raw, expected):
    monkeypatch.setenv("WORKEROS_SCHEDULE_STALE_GRACE_SECONDS", raw)
    assert _schedule_stale_grace_seconds() == expected


def test_grace_env_var_changes_the_verdict(monkeypatch):
    from models import RunStatus, WorkerStatus

    repos = _StalenessRepos({WORKER_ID: _iso(-600)})
    monkeypatch.setenv("WORKEROS_SCHEDULE_STALE_GRACE_SECONDS", "60")
    assert _status(
        _worker(),
        repos=repos,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.NEEDS_ATTENTION


@pytest.fixture
def workers_repo(monkeypatch, tmp_path):
    monkeypatch.delenv("WORKEROS_DB", raising=False)
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "schedule-staleness.db"))
    import db as db_module

    db_module.init_db()
    from db.sqlite import SqliteWorkerRepository

    return SqliteWorkerRepository()


def _make_scheduled_worker(repo, worker_id: str, *, user_id: str = USER_ID) -> None:
    repo.create(
        user_id=user_id,
        worker_id=worker_id,
        name=worker_id,
        trigger_type="schedule",
        manifest_json={"name": worker_id, "version": "0.1.0"},
    )


def test_schedule_staleness_batch_returns_the_oldest_enabled_slot(workers_repo):
    _make_scheduled_worker(workers_repo, "two-crons")
    rows = workers_repo.reconcile_triggers(
        worker_id="two-crons",
        triggers=[
            {"type": "schedule", "cron": "*/15 * * * *"},
            {"type": "schedule", "cron": "0 9 * * *"},
            {"type": "webhook"},
        ],
    )
    schedule_ids = [row["id"] for row in rows if row["type"] == "schedule"]
    assert len(schedule_ids) == 2
    workers_repo.set_trigger_next_run_at(
        trigger_id=schedule_ids[0], next_run_at="2026-07-25T09:00:00+00:00"
    )
    workers_repo.set_trigger_next_run_at(
        trigger_id=schedule_ids[1], next_run_at="2026-07-24T09:00:00+00:00"
    )

    batch = workers_repo.schedule_staleness_batch(user_id=USER_ID, worker_ids=["two-crons"])
    assert batch == {"two-crons": "2026-07-24T09:00:00+00:00"}


def test_schedule_staleness_batch_ignores_disabled_trigger_rows(workers_repo):
    from db import get_db

    _make_scheduled_worker(workers_repo, "paused-cron")
    rows = workers_repo.reconcile_triggers(
        worker_id="paused-cron",
        triggers=[{"type": "schedule", "cron": "*/15 * * * *"}],
    )
    trigger_id = rows[0]["id"]
    workers_repo.set_trigger_next_run_at(
        trigger_id=trigger_id, next_run_at="2026-07-24T09:00:00+00:00"
    )
    assert workers_repo.schedule_staleness_batch(
        user_id=USER_ID, worker_ids=["paused-cron"]
    ) == {"paused-cron": "2026-07-24T09:00:00+00:00"}

    with get_db() as conn:
        conn.execute("UPDATE worker_triggers SET enabled = 0 WHERE id = ?", (trigger_id,))

    assert workers_repo.schedule_staleness_batch(
        user_id=USER_ID, worker_ids=["paused-cron"]
    ) == {"paused-cron": None}


def test_schedule_staleness_batch_covers_every_requested_id(workers_repo):
    _make_scheduled_worker(workers_repo, "manual-only")
    workers_repo.reconcile_triggers(
        worker_id="manual-only",
        triggers=[{"type": "manual"}],
    )

    assert workers_repo.schedule_staleness_batch(user_id=USER_ID, worker_ids=[]) == {}
    assert workers_repo.schedule_staleness_batch(
        user_id=USER_ID, worker_ids=["manual-only", "does-not-exist"]
    ) == {"manual-only": None, "does-not-exist": None}


def test_sqlite_batch_feeds_the_status_downgrade_end_to_end(workers_repo):
    """The real repository, the real helper, the real resolver: one dead cron."""
    from models import RunStatus, WorkerStatus

    _make_scheduled_worker(workers_repo, WORKER_ID)
    rows = workers_repo.reconcile_triggers(
        worker_id=WORKER_ID,
        triggers=[{"type": "schedule", "cron": "*/15 * * * *"}],
    )
    workers_repo.set_trigger_next_run_at(
        trigger_id=rows[0]["id"], next_run_at=_iso(-FOUR_DAYS_SECONDS)
    )

    repos = SimpleNamespace(workers=workers_repo)
    assert _status(
        _worker(),
        repos=repos,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.NEEDS_ATTENTION

    workers_repo.set_trigger_next_run_at(trigger_id=rows[0]["id"], next_run_at=_iso(600))
    assert _status(
        _worker(),
        repos=repos,
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.HEALTHY
