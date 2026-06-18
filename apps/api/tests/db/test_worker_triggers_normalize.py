"""Tests for normalized multi-trigger support (worker_triggers).

Regression coverage for the bug where a worker could declare N triggers in the
UI (persisted in workers.triggers_json) but only the PRIMARY one ever fired,
because the scheduler/registration read only the scalar cron_expr/trigger_type.

The fix normalizes triggers into a worker_triggers table (one row per declared
trigger) that the scheduler iterates and the webhook/composio resolvers map back
to a specific trigger row. These tests assert:

- [schedule-daily, schedule-weekly] -> BOTH fire, 2 distinct runs, distinct refs
- [webhook, composio] -> both resolvable to their own trigger rows
- redelivery dedupe: same delivery id -> one run
- single-trigger worker unaffected (one trigger -> one row)
- reconciliation from triggers_json: add/remove a trigger updates the rows
"""

from __future__ import annotations

import importlib
import json
import sys
from datetime import datetime, timezone


def _fresh_scheduler():
    """Import the real scheduler module.

    Other tests in the suite replace ``sys.modules['scheduler']`` with a stub
    namespace; pop it so we load the genuine module bound to the current db
    modules the ``repo_bundle`` fixture just reloaded.
    """
    sys.modules.pop("scheduler", None)
    return importlib.import_module("scheduler")


def _make_worker(repos, manifest, worker_id="w1", user_id="federico"):
    repos.workers.create(
        user_id=user_id,
        worker_id=worker_id,
        name=worker_id,
        manifest_json=manifest(worker_id, worker_id),
        bundle_path=f"workers/{worker_id}",
    )


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------

def test_single_trigger_reconciles_to_one_row(repo_bundle):
    repos, _db, manifest = repo_bundle
    _make_worker(repos, manifest)

    rows = repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[{"type": "schedule", "cron": "0 9 * * *"}],
    )
    assert len(rows) == 1
    assert rows[0]["type"] == "schedule"
    assert json.loads(rows[0]["config_json"])["cron"] == "0 9 * * *"


def test_multi_trigger_reconciles_to_n_rows(repo_bundle):
    repos, _db, manifest = repo_bundle
    _make_worker(repos, manifest)

    rows = repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[
            {"type": "schedule", "cron": "0 9 * * *"},
            {"type": "schedule", "cron": "0 9 * * 1"},
            {"type": "webhook"},
        ],
    )
    assert len(rows) == 3
    assert [r["type"] for r in rows] == ["schedule", "schedule", "webhook"]
    # Distinct stable ids per position.
    assert len({r["id"] for r in rows}) == 3


def test_reconcile_is_idempotent_and_handles_add_remove(repo_bundle):
    repos, _db, manifest = repo_bundle
    _make_worker(repos, manifest)

    first = repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[{"type": "schedule", "cron": "0 9 * * *"}],
    )
    # Initialize a schedule slot so we can prove it survives an unrelated re-reconcile.
    repos.workers.set_trigger_next_run_at(
        trigger_id=first[0]["id"], next_run_at="2030-01-01T00:00:00+00:00"
    )

    # ADD a second trigger -> 2 rows, original row's next_run_at preserved.
    second = repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[
            {"type": "schedule", "cron": "0 9 * * *"},
            {"type": "webhook"},
        ],
    )
    assert len(second) == 2
    sched_row = next(r for r in second if r["type"] == "schedule")
    assert sched_row["next_run_at"] == "2030-01-01T00:00:00+00:00"

    # REMOVE the webhook trigger -> back to 1 row.
    third = repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[{"type": "schedule", "cron": "0 9 * * *"}],
    )
    assert len(third) == 1
    assert third[0]["type"] == "schedule"


def test_reconcile_resets_next_run_at_when_cron_changes(repo_bundle):
    repos, _db, manifest = repo_bundle
    _make_worker(repos, manifest)

    rows = repos.workers.reconcile_triggers(
        worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}]
    )
    repos.workers.set_trigger_next_run_at(
        trigger_id=rows[0]["id"], next_run_at="2030-01-01T00:00:00+00:00"
    )
    # Changing the cron must clear the stale slot.
    rows2 = repos.workers.reconcile_triggers(
        worker_id="w1", triggers=[{"type": "schedule", "cron": "0 10 * * *"}]
    )
    assert rows2[0]["next_run_at"] is None


def test_schedule_trigger_claim_is_atomic_and_cleared_on_advance(repo_bundle):
    repos, db, manifest = repo_bundle
    _make_worker(repos, manifest)

    rows = repos.workers.reconcile_triggers(
        worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}]
    )
    trigger_id = rows[0]["id"]
    repos.workers.set_trigger_next_run_at(
        trigger_id=trigger_id, next_run_at="2000-01-01T00:00:00+00:00"
    )

    assert repos.workers.claim_schedule_trigger(
        trigger_id=trigger_id,
        now_iso="2026-06-18T00:00:00+00:00",
        locked_until="2026-06-18T00:03:00+00:00",
    ) is True
    assert repos.workers.claim_schedule_trigger(
        trigger_id=trigger_id,
        now_iso="2026-06-18T00:00:01+00:00",
        locked_until="2026-06-18T00:04:00+00:00",
    ) is False

    repos.workers.set_trigger_next_run_at(
        trigger_id=trigger_id, next_run_at="2026-06-19T00:00:00+00:00"
    )
    with db.get_db() as conn:
        locked_until = conn.execute(
            "SELECT locked_until FROM worker_triggers WHERE id = ?",
            (trigger_id,),
        ).fetchone()[0]

    assert locked_until is None


def test_schedule_trigger_mark_fired_clears_claim(repo_bundle):
    repos, db, manifest = repo_bundle
    _make_worker(repos, manifest)

    rows = repos.workers.reconcile_triggers(
        worker_id="w1", triggers=[{"type": "schedule", "cron": "0 9 * * *"}]
    )
    trigger_id = rows[0]["id"]
    assert repos.workers.claim_schedule_trigger(
        trigger_id=trigger_id,
        now_iso="2026-06-18T00:00:00+00:00",
        locked_until="2026-06-18T00:03:00+00:00",
    )

    repos.workers.mark_trigger_fired(
        trigger_id=trigger_id,
        last_fired_at="2026-06-18T00:00:00+00:00",
        next_run_at="2026-06-19T00:00:00+00:00",
    )
    with db.get_db() as conn:
        locked_until = conn.execute(
            "SELECT locked_until FROM worker_triggers WHERE id = ?",
            (trigger_id,),
        ).fetchone()[0]

    assert locked_until is None


# ---------------------------------------------------------------------------
# Scheduler: two schedule triggers both fire
# ---------------------------------------------------------------------------

def test_two_schedule_triggers_both_fire_distinct_runs(repo_bundle, monkeypatch):
    repos, db, manifest = repo_bundle
    scheduler = _fresh_scheduler()

    _make_worker(repos, manifest)
    rows = repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[
            {"type": "schedule", "cron": "*/5 * * * *"},
            {"type": "schedule", "cron": "0 9 * * *"},
        ],
    )
    assert len(rows) == 2

    # Force both rows due in the past so a single tick fires both.
    past = "2000-01-01T00:00:00+00:00"
    for r in rows:
        repos.workers.set_trigger_next_run_at(trigger_id=r["id"], next_run_at=past)

    fired: list[tuple[str, str]] = []

    def fake_create_run(worker_id, inputs, trigger_source="manual", **kwargs):
        rid = f"run_{len(fired)}"
        fired.append((rid, kwargs.get("trigger_ref")))
        return rid

    monkeypatch.setattr(scheduler, "create_run", fake_create_run)
    monkeypatch.setattr(scheduler, "start_run", lambda *a, **k: None)
    monkeypatch.setattr(scheduler, "get_repositories", lambda: repos)
    monkeypatch.setattr(scheduler, "alerting_tick", lambda: None)
    # No running runs for this worker.
    monkeypatch.setattr(
        repos.runs, "count_running_for_worker", lambda **k: 0
    )

    scheduler._tick()

    assert len(fired) == 2, f"expected both triggers to fire, got {fired}"
    refs = {ref for _rid, ref in fired}
    assert refs == {rows[0]["id"], rows[1]["id"]}, f"distinct trigger refs expected: {refs}"


def test_scheduler_initializes_trigger_next_run_at_in_declared_timezone(repo_bundle, monkeypatch):
    repos, db, manifest = repo_bundle
    scheduler = _fresh_scheduler()

    _make_worker(repos, manifest)
    rows = repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[{"type": "schedule", "cron": "0 9 * * *", "timezone": "America/Los_Angeles"}],
    )

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            value = datetime(2026, 6, 9, 7, 0, tzinfo=timezone.utc)
            return value.astimezone(tz) if tz else value.replace(tzinfo=None)

    monkeypatch.setattr(scheduler, "datetime", FixedDateTime)
    monkeypatch.setattr(scheduler, "get_repositories", lambda: repos)
    monkeypatch.setattr(scheduler, "alerting_tick", lambda: None)

    scheduler._tick()

    with db.get_db() as conn:
        next_run_at = conn.execute(
            "SELECT next_run_at FROM worker_triggers WHERE id = ?",
            (rows[0]["id"],),
        ).fetchone()[0]

    assert next_run_at == "2026-06-09T16:00:00+00:00"


def test_scheduler_initializes_legacy_next_run_at_in_declared_timezone(repo_bundle, monkeypatch):
    repos, _db, manifest = repo_bundle
    scheduler = _fresh_scheduler()

    worker_id = "legacy-timezone-worker"
    repos.workers.create(
        user_id="federico",
        worker_id=worker_id,
        name=worker_id,
        manifest_json={
            **manifest(worker_id, worker_id),
            "trigger": {"type": "schedule", "cron": "0 9 * * *", "timezone": "America/Los_Angeles"},
        },
        bundle_path=f"workers/{worker_id}",
        trigger_type="schedule",
        cron_expr="0 9 * * *",
        cron_timezone="America/Los_Angeles",
    )

    class FixedDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            value = datetime(2026, 6, 9, 7, 0, tzinfo=timezone.utc)
            return value.astimezone(tz) if tz else value.replace(tzinfo=None)

    monkeypatch.setattr(scheduler, "datetime", FixedDateTime)
    monkeypatch.setattr(scheduler, "get_repositories", lambda: repos)
    monkeypatch.setattr(scheduler, "alerting_tick", lambda: None)
    monkeypatch.setattr(repos.workers, "count_schedule_trigger_rows", lambda: 0)

    scheduler._tick()

    state = repos.workers.get_schedule_state(worker_id=worker_id)
    assert state is not None
    assert state["next_run_at"] == "2026-06-09T16:00:00+00:00"


def test_scheduler_respects_running_worker_concurrency(repo_bundle, monkeypatch):
    repos, db, manifest = repo_bundle
    scheduler = _fresh_scheduler()

    _make_worker(repos, manifest)
    rows = repos.workers.reconcile_triggers(
        worker_id="w1", triggers=[{"type": "schedule", "cron": "*/5 * * * *"}]
    )
    repos.workers.set_trigger_next_run_at(
        trigger_id=rows[0]["id"], next_run_at="2000-01-01T00:00:00+00:00"
    )

    fired: list[str] = []
    monkeypatch.setattr(
        scheduler, "create_run", lambda *a, **k: fired.append(1) or "run_x"
    )
    monkeypatch.setattr(scheduler, "start_run", lambda *a, **k: None)
    monkeypatch.setattr(scheduler, "get_repositories", lambda: repos)
    monkeypatch.setattr(scheduler, "alerting_tick", lambda: None)
    monkeypatch.setattr(repos.runs, "count_running_for_worker", lambda **k: 1)

    scheduler._tick()
    assert fired == [], "must not fire while a run is in flight"


def test_scheduler_advances_trigger_next_run_at_on_fire_failure(repo_bundle, monkeypatch):
    repos, db, manifest = repo_bundle
    scheduler = _fresh_scheduler()

    worker_id = "trigger-failure-worker"
    repos.workers.create(
        user_id="federico",
        worker_id=worker_id,
        name=worker_id,
        manifest_json={**manifest(worker_id, worker_id), "trigger": {"type": "schedule", "cron": "*/5 * * * *"}},
        bundle_path=f"workers/{worker_id}",
        trigger_type="schedule",
        cron_expr="*/5 * * * *",
    )
    rows = repos.workers.reconcile_triggers(
        worker_id=worker_id,
        triggers=[{"type": "schedule", "cron": "*/5 * * * *"}],
    )
    trigger_id = rows[0]["id"]
    repos.workers.set_trigger_next_run_at(
        trigger_id=trigger_id, next_run_at="2000-01-01T00:00:00+00:00"
    )

    monkeypatch.setattr(scheduler, "compute_next_run_at", lambda *a, **k: "2030-01-01T00:00:00+00:00")
    monkeypatch.setattr(scheduler, "create_run", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(scheduler, "start_run", lambda *a, **k: None)
    monkeypatch.setattr(scheduler, "get_repositories", lambda: repos)
    monkeypatch.setattr(scheduler, "alerting_tick", lambda: None)
    monkeypatch.setattr(repos.runs, "count_running_for_worker", lambda **k: 0)

    scheduler._tick()

    with db.get_db() as conn:
        next_run_at = conn.execute(
            "SELECT next_run_at FROM worker_triggers WHERE id = ?",
            (trigger_id,),
        ).fetchone()[0]

    assert next_run_at == "2030-01-01T00:00:00+00:00"


def test_scheduler_advances_legacy_next_run_at_on_fire_failure(repo_bundle, monkeypatch):
    repos, _db, manifest = repo_bundle
    scheduler = _fresh_scheduler()

    worker_id = "legacy-failure-worker"
    repos.workers.create(
        user_id="federico",
        worker_id=worker_id,
        name=worker_id,
        manifest_json={**manifest(worker_id, worker_id), "trigger": {"type": "schedule", "cron": "*/5 * * * *"}},
        bundle_path=f"workers/{worker_id}",
        trigger_type="schedule",
        cron_expr="*/5 * * * *",
    )
    repos.workers.set_next_run_at(
        worker_id=worker_id, next_run_at="2000-01-01T00:00:00+00:00"
    )

    monkeypatch.setattr(scheduler, "compute_next_run_at", lambda *a, **k: "2030-01-01T00:00:00+00:00")
    monkeypatch.setattr(scheduler, "create_run", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(scheduler, "start_run", lambda *a, **k: None)
    monkeypatch.setattr(scheduler, "get_repositories", lambda: repos)
    monkeypatch.setattr(scheduler, "alerting_tick", lambda: None)
    monkeypatch.setattr(repos.workers, "count_schedule_trigger_rows", lambda: 0)
    monkeypatch.setattr(repos.runs, "count_running_for_worker", lambda **k: 0)

    scheduler._tick()

    state = repos.workers.get_schedule_state(worker_id=worker_id)
    assert state is not None
    assert state["next_run_at"] == "2030-01-01T00:00:00+00:00"


def test_start_scheduler_clears_stop_event_before_launch(monkeypatch):
    scheduler = _fresh_scheduler()
    started: list[str] = []

    def fake_start(self):
        started.append(self.name)

    monkeypatch.setattr(scheduler.threading.Thread, "start", fake_start)
    scheduler._stop_event.set()

    scheduler.start_scheduler()

    assert scheduler._stop_event.is_set() is False
    assert started == ["workeros-scheduler"]


def test_scheduler_status_reports_dead_thread():
    scheduler = _fresh_scheduler()

    assert scheduler.scheduler_status()["ok"] is False

    class DeadThread:
        name = "workeros-scheduler"

        def is_alive(self):
            return False

    scheduler._scheduler_thread = DeadThread()

    assert scheduler.scheduler_status() == {
        "ok": False,
        "running": False,
        "thread": "workeros-scheduler",
        "stopping": False,
    }


def test_scheduler_status_reports_running_thread():
    scheduler = _fresh_scheduler()

    class LiveThread:
        name = "workeros-scheduler"

        def is_alive(self):
            return True

    scheduler._scheduler_thread = LiveThread()
    scheduler._stop_event.clear()

    assert scheduler.scheduler_status() == {
        "ok": True,
        "running": True,
        "thread": "workeros-scheduler",
        "stopping": False,
    }


# ---------------------------------------------------------------------------
# Webhook + composio resolution to specific rows
# ---------------------------------------------------------------------------

def test_webhook_and_composio_triggers_both_resolvable(repo_bundle):
    repos, _db, manifest = repo_bundle
    _make_worker(repos, manifest)

    repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[
            {"type": "webhook"},
            {"type": "composio", "composio": {"event": "gmail.new_email"}},
        ],
        external_trigger_id="ext_trig_123",
    )

    webhook_row = repos.workers.find_trigger_for_webhook(worker_id="w1")
    assert webhook_row is not None
    assert webhook_row["type"] == "webhook"

    composio_row = repos.workers.find_trigger_by_external_id(external_trigger_id="ext_trig_123")
    assert composio_row is not None
    assert composio_row["type"] == "composio_event"
    assert composio_row["worker_id"] == "w1"
    # The two are distinct rows.
    assert webhook_row["id"] != composio_row["id"]


def test_composio_external_id_only_on_composio_row(repo_bundle):
    repos, _db, manifest = repo_bundle
    _make_worker(repos, manifest)

    rows = repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[
            {"type": "schedule", "cron": "0 9 * * *"},
            {"type": "composio", "composio": {"event": "gmail.new_email"}},
        ],
        external_trigger_id="ext_abc",
    )
    by_type = {r["type"]: r for r in rows}
    assert by_type["schedule"]["external_trigger_id"] is None
    assert by_type["composio_event"]["external_trigger_id"] == "ext_abc"


# ---------------------------------------------------------------------------
# Redelivery dedupe (trigger + delivery id)
# ---------------------------------------------------------------------------

def test_redelivery_dedupe_same_delivery_id_claims_once(repo_bundle):
    """The shared delivery-receipt claim fires at most once per (source, id)."""
    repos, db, manifest = repo_bundle
    import main

    main.init_db()  # ensure webhook_delivery_receipts exists in this DB
    source = "composio:trg_w1_0"
    assert main._claim_webhook_delivery(source, "delivery-1") is True
    # Redelivery of the SAME id to the SAME trigger -> rejected (one run).
    assert main._claim_webhook_delivery(source, "delivery-1") is False
    # A different delivery id still goes through.
    assert main._claim_webhook_delivery(source, "delivery-2") is True
    # A different trigger with the same delivery id is independent.
    assert main._claim_webhook_delivery("composio:trg_w1_1", "delivery-1") is True


# ---------------------------------------------------------------------------
# count_schedule_trigger_rows drives the scheduler path selection
# ---------------------------------------------------------------------------

def test_count_schedule_trigger_rows(repo_bundle):
    repos, _db, manifest = repo_bundle
    assert repos.workers.count_schedule_trigger_rows() == 0
    _make_worker(repos, manifest)
    repos.workers.reconcile_triggers(
        worker_id="w1",
        triggers=[
            {"type": "schedule", "cron": "0 9 * * *"},
            {"type": "webhook"},
        ],
    )
    # Only the schedule row counts.
    assert repos.workers.count_schedule_trigger_rows() == 1
