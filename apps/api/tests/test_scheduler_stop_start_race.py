"""Regression: a stop() immediately followed by a start() must leave a scheduler.

Incident 2026-08-02: the cloud wrapper calls stop_scheduler() and, milliseconds
later, start_scheduler() again whenever its Postgres advisory-lock connection
blips. With a single module-global stop event, start_scheduler() early-returned
because the old thread was still sleeping in wait(POLL_INTERVAL_SECONDS), the
stop flag stayed set, and the old thread then woke, saw the flag and exited.
Result: no scheduler thread and a stop flag nothing ever cleared, so scheduled
runs stopped firing until the process was restarted.
"""

from __future__ import annotations

import importlib
import sys
import threading
import time
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _fresh_scheduler():
    """Import the real scheduler module.

    Other tests in the suite replace ``sys.modules['scheduler']`` with a stub
    namespace; pop it so we always load the genuine module.
    """
    sys.modules.pop("scheduler", None)
    return importlib.import_module("scheduler")


@pytest.fixture
def scheduler():
    module = _fresh_scheduler()
    try:
        yield module
    finally:
        module.stop_scheduler()
        thread = module._scheduler_thread
        if thread is not None:
            thread.join(timeout=5)
        module._scheduler_thread = None
        module._scheduler_started_once = False


class _Ticks:
    """Counts scheduler ticks and lets a test wait for the next one."""

    def __init__(self) -> None:
        self.count = 0
        self.seen = threading.Event()

    def __call__(self) -> None:
        self.count += 1
        self.seen.set()

    def wait_for_next(self, timeout: float = 5.0) -> bool:
        self.seen.clear()
        return self.seen.wait(timeout)

    def wait_for_first(self, timeout: float = 5.0) -> bool:
        return self.seen.wait(timeout)


def test_start_after_stop_leaves_a_live_ticking_scheduler(scheduler, monkeypatch):
    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    # Long enough that the running generation is provably asleep in wait() when
    # the stop/start pair lands, which is the exact race from the incident.
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first(), "the scheduler must tick once after starting"
    first_thread = scheduler._scheduler_thread
    assert first_thread is not None and first_thread.is_alive()

    ticks.seen.clear()
    scheduler.stop_scheduler()
    scheduler.start_scheduler()

    assert ticks.wait_for_first(), "a fresh generation must tick after a stop/start race"
    thread = scheduler._scheduler_thread
    assert thread is not None
    assert thread.is_alive(), "the stop/start race must not leave the process without a scheduler"
    assert scheduler._stop_event.is_set() is False, "the new generation's stop flag must be clear"

    status = scheduler.scheduler_heartbeat_status()
    assert status["running"] is True
    assert status["stopping"] is False


def test_stop_only_stops_the_generation_it_targeted(scheduler, monkeypatch):
    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()
    retired_stop_event = scheduler._stop_event
    retired_thread = scheduler._scheduler_thread

    scheduler.stop_scheduler()
    scheduler.start_scheduler()
    assert ticks.wait_for_first()

    retired_thread.join(timeout=5)
    assert retired_thread.is_alive() is False, "the stopped generation must exit"
    assert retired_stop_event is not scheduler._stop_event, "each generation owns its stop event"
    assert retired_stop_event.is_set() is True
    assert scheduler._scheduler_thread.is_alive() is True


def test_start_is_a_no_op_while_a_healthy_generation_runs(scheduler, monkeypatch):
    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()
    thread = scheduler._scheduler_thread
    stop_event = scheduler._stop_event

    scheduler.start_scheduler()
    scheduler.start_scheduler()

    assert scheduler._scheduler_thread is thread, "a healthy scheduler must not be replaced"
    assert scheduler._stop_event is stop_event


def test_loop_survives_a_broken_logging_handler(scheduler, monkeypatch):
    """A closed stdout pipe must not end the scheduler for the whole process."""
    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 0.01)

    def broken_log(*args, **kwargs):
        raise ValueError("I/O operation on closed file")

    monkeypatch.setattr(scheduler.logger, "log", broken_log)
    monkeypatch.setattr(scheduler.logger, "info", broken_log)
    monkeypatch.setattr(scheduler.logger, "error", broken_log)
    monkeypatch.setattr(scheduler.logger, "exception", broken_log)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()
    assert ticks.wait_for_next(), "the loop must keep ticking with a broken log handler"
    assert scheduler._scheduler_thread.is_alive() is True


def test_ensure_scheduler_running_restarts_a_dead_thread(scheduler, monkeypatch):
    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()

    # Kill the generation the way the incident did: stop it and let it exit,
    # without anything starting a successor.
    dead_thread = scheduler._scheduler_thread
    scheduler.stop_scheduler()
    dead_thread.join(timeout=5)
    assert dead_thread.is_alive() is False

    ticks.seen.clear()
    assert scheduler.ensure_scheduler_running() is True
    assert ticks.wait_for_first(), "the healed scheduler must tick"
    healed = scheduler._scheduler_thread
    assert healed is not dead_thread
    assert healed.is_alive() is True


def test_ensure_scheduler_running_is_idempotent(scheduler, monkeypatch):
    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()
    thread = scheduler._scheduler_thread

    before = _scheduler_thread_count()
    assert scheduler.ensure_scheduler_running() is False
    assert scheduler.ensure_scheduler_running() is False
    assert scheduler.ensure_scheduler_running() is False

    assert scheduler._scheduler_thread is thread, "a healthy scheduler must not be replaced"
    assert _scheduler_thread_count() == before, "no duplicate scheduler threads"


def test_ensure_scheduler_running_never_replaces_a_live_stale_thread(scheduler, monkeypatch):
    """Python cannot kill a thread, so a wedged generation is left alone.

    Replacing a live-but-stale scheduler would leave TWO schedulers firing the
    same triggers and duplicating side effects, which is worse than the delay.
    A stale heartbeat is also not proof of death: a recovery tick working
    through many overdue triggers legitimately runs long.
    """
    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()
    wedged = scheduler._scheduler_thread

    stale_now = (
        scheduler._scheduler_last_heartbeat_monotonic
        + scheduler._SCHEDULER_HEARTBEAT_STALE_AFTER_SECONDS
        + 1.0
    )
    status = scheduler.scheduler_heartbeat_status(now_monotonic=stale_now)
    assert status["ok"] is False and status["stale"] is True

    assert scheduler.ensure_scheduler_running(now_monotonic=stale_now) is False
    assert scheduler.ensure_scheduler_running(now_monotonic=stale_now) is False

    assert scheduler._scheduler_thread is wedged
    assert wedged.is_alive() is True
    assert scheduler._stop_event.is_set() is False
    assert _scheduler_thread_count() == 1, "a wedged scheduler must never be doubled"


def test_ensure_scheduler_running_restarts_a_stopping_generation(scheduler, monkeypatch):
    """A generation whose stop flag is set is dead, not wedged: replace it."""
    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()
    outgoing = scheduler._scheduler_thread

    scheduler.stop_scheduler()
    ticks.seen.clear()

    assert scheduler.ensure_scheduler_running() is True
    assert ticks.wait_for_first()
    outgoing.join(timeout=5)
    assert outgoing.is_alive() is False
    assert scheduler._scheduler_thread is not outgoing
    assert scheduler._scheduler_thread.is_alive() is True
    assert _scheduler_thread_count() == 1


def test_ensure_scheduler_running_never_cold_starts_a_scheduler(scheduler):
    """A web-role process that never started a scheduler must not grow one."""
    assert scheduler._scheduler_started_once is False
    assert scheduler.ensure_scheduler_running() is False
    assert scheduler._scheduler_thread is None
    assert _scheduler_thread_count() == 0


def test_health_surfaces_heartbeat_staleness_additively(scheduler, monkeypatch):
    """/health gains the staleness fields without changing what `ok` means."""
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    from services import health_ops

    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()

    healthy = health_ops._health_check_scheduler()
    # Backward compatible: still a superset of the scheduler_status() keys.
    for key in ("ok", "running", "thread", "stopping"):
        assert key in healthy
    assert healthy["ok"] is True
    assert healthy["running"] is True
    assert healthy["stale"] is False
    assert healthy["heartbeat_age_seconds"] is not None

    # The thread stays alive but stops ticking, which is what is_alive() alone
    # could never see. It is now visible, and `ok` is deliberately unchanged so
    # no consumer's health semantics shift in this PR.
    scheduler._scheduler_last_heartbeat_monotonic = (
        time.monotonic() - scheduler._SCHEDULER_HEARTBEAT_STALE_AFTER_SECONDS - 1.0
    )

    wedged = health_ops._health_check_scheduler()
    assert wedged["stale"] is True
    assert wedged["running"] is True
    assert wedged["ok"] is True


def test_health_still_reports_a_dead_scheduler_as_not_ok(scheduler, monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    from services import health_ops

    ticks = _Ticks()
    monkeypatch.setattr(scheduler, "_tick", ticks)
    monkeypatch.setattr(scheduler, "POLL_INTERVAL_SECONDS", 30)

    scheduler.start_scheduler()
    assert ticks.wait_for_first()
    thread = scheduler._scheduler_thread
    scheduler.stop_scheduler()
    thread.join(timeout=5)

    dead = health_ops._health_check_scheduler()
    assert dead["ok"] is False
    assert dead["running"] is False


def _scheduler_thread_count() -> int:
    return len([t for t in threading.enumerate() if t.name == "workeros-scheduler" and t.is_alive()])
