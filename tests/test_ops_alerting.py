"""Real-time, PII-free platform OPS alerting."""
from __future__ import annotations

import sys
import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import alerting
import pytest


class _Throttle:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, str]] = []

    def count_since(
        self,
        *,
        since_iso,
        workspace_id=None,
        worker_id=None,
        signature=None,
    ) -> int:
        return sum(
            1
            for ws, worker, sig, sent_at in self.rows
            if sent_at >= since_iso
            and (workspace_id is None or ws == workspace_id)
            and (worker_id is None or worker == worker_id)
            and (signature is None or sig == signature)
        )

    def record(self, *, workspace_id, worker_id, signature, sent_at_iso) -> None:
        self.rows.append((workspace_id, worker_id, signature, sent_at_iso))

    def release(self, *, workspace_id, worker_id, signature, sent_at_iso) -> None:
        target = (workspace_id, worker_id, signature, sent_at_iso)
        self.rows = [row for row in self.rows if row != target]


class _Runs:
    def __init__(self) -> None:
        self.stats: dict[str, tuple[int, bool]] = {}

    def ops_error_code_stats(self, *, error_code, since_iso, exclude_run_id=None):
        count, seen_before = self.stats.get(error_code, (1, False))
        return {"count_since": count, "seen_before": seen_before}


def _repos() -> SimpleNamespace:
    return SimpleNamespace(
        alert_throttle=_Throttle(),
        runs=_Runs(),
        workers=SimpleNamespace(
            get_any=lambda *, worker_id: {
                "id": worker_id,
                "workspace_id": "ws_platform_1",
                "owner_email": "must-not-leak@example.com",
            }
        ),
    )


@pytest.fixture(autouse=True)
def _reset_ops_state(monkeypatch):
    monkeypatch.delenv("WORKEROS_OPS_ALERT_WEBHOOK", raising=False)
    monkeypatch.delenv("WORKEROS_OPS_SLACK_WEBHOOK", raising=False)
    alerting._ops_seen_unknown_codes.clear()
    alerting._ops_fallback_last_sent.clear()
    alerting._ops_suppressed_counts.clear()
    alerting._ops_queued_codes.clear()


def test_platform_failure_posts_compact_payload_once(monkeypatch):
    repos = _repos()
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(
        alerting,
        "_post_ops_webhook",
        lambda *, url, payload, slack: posted.append(
            {"url": url, "payload": payload, "slack": slack}
        ),
    )
    now = datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc)

    result = alerting.alert_ops_run_failure(
        run_id="run_123",
        worker_id="worker_123",
        error_code="llm_provider_capacity_retry_exhausted",
        user_id="owner@example.com",
        repos=repos,
        now=now,
    )

    assert result["sent"] is True
    assert len(posted) == 1
    assert posted[0]["url"] == "https://hooks.example.com/ops"
    assert posted[0]["slack"] is False
    assert posted[0]["payload"] == {
        "error_code": "llm_provider_capacity_retry_exhausted",
        "worker_id": "worker_123",
        "workspace_id": "ws_platform_1",
        "run_id": "run_123",
        "ts": "2026-07-20T16:00:00+00:00",
        "count_same_code_last_15m": 1,
    }
    assert "owner@example.com" not in str(posted)
    assert "must-not-leak@example.com" not in str(posted)


def test_second_same_code_inside_ten_minutes_is_suppressed(monkeypatch):
    repos = _repos()
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(
        alerting,
        "_post_ops_webhook",
        lambda **kwargs: posted.append(kwargs["payload"]),
    )
    now = datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc)

    first = alerting.alert_ops_run_failure(
        run_id="run_1",
        worker_id="worker_1",
        error_code="e2b_sandbox_error",
        user_id="owner_1",
        repos=repos,
        now=now,
    )
    second = alerting.alert_ops_run_failure(
        run_id="run_2",
        worker_id="worker_2",
        error_code="e2b_sandbox_error",
        user_id="owner_2",
        repos=repos,
        now=now + timedelta(minutes=9),
    )

    assert first["sent"] is True
    assert second == {
        "sent": False,
        "suppressed": True,
        "error_code": "e2b_sandbox_error",
    }
    assert len(posted) == 1


def test_next_post_includes_suppressed_count(monkeypatch):
    repos = _repos()
    repos.runs.stats["executor_lost_mid_run"] = (3, True)
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(
        alerting,
        "_post_ops_webhook",
        lambda **kwargs: posted.append(kwargs["payload"]),
    )
    now = datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc)

    for minute, run_id in ((0, "run_1"), (5, "run_2"), (11, "run_3")):
        alerting.alert_ops_run_failure(
            run_id=run_id,
            worker_id="worker_1",
            error_code="executor_lost_mid_run",
            user_id="owner_1",
            repos=repos,
            now=now + timedelta(minutes=minute),
        )

    assert len(posted) == 2
    assert posted[-1]["count_same_code_last_15m"] == 3


def test_first_unknown_error_code_fires(monkeypatch):
    repos = _repos()
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(
        alerting,
        "_post_ops_webhook",
        lambda **kwargs: posted.append(kwargs["payload"]),
    )

    result = alerting.alert_ops_run_failure(
        run_id="run_new",
        worker_id="worker_1",
        error_code="brand_new_platform_failure",
        user_id="owner_1",
        repos=repos,
        now=datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc),
    )

    assert result["sent"] is True
    assert posted[0]["error_code"] == "brand_new_platform_failure"


def test_unknown_code_race_preserves_earliest_persisted_run(monkeypatch):
    code = "brand_new_concurrent_failure"
    started = threading.Event()
    release = threading.Event()
    posted: list[dict] = []
    original_alert = alerting.alert_ops_run_failure

    class _ConcurrentRuns(_Runs):
        def ops_error_code_stats(self, *, error_code, since_iso, exclude_run_id=None):
            return {
                "count_since": 2,
                "seen_before": exclude_run_id == "run_later",
            }

    repos = _repos()
    repos.runs = _ConcurrentRuns()
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    monkeypatch.setattr(
        alerting,
        "_post_ops_webhook",
        lambda **kwargs: posted.append(kwargs["payload"]),
    )

    def _gated_alert(**kwargs):
        if kwargs["run_id"] == "run_later":
            started.set()
            assert release.wait(timeout=5)
        return original_alert(**kwargs)

    monkeypatch.setattr(alerting, "alert_ops_run_failure", _gated_alert)
    common = {
        "worker_id": "worker_1",
        "error_code": code,
        "user_id": "owner_1",
        "repos": repos,
    }
    alerting.dispatch_ops_run_failure(run_id="run_later", **common)
    assert started.wait(timeout=2)
    alerting.dispatch_ops_run_failure(run_id="run_earlier", **common)
    release.set()
    alerting._ops_dispatch_queue.join()

    assert [payload["run_id"] for payload in posted] == ["run_earlier"]


def test_historical_unknown_error_code_does_not_refire(monkeypatch):
    repos = _repos()
    repos.runs.stats["historical_custom_failure"] = (1, True)
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(alerting, "_post_ops_webhook", lambda **kwargs: posted.append(kwargs))

    result = alerting.alert_ops_run_failure(
        run_id="run_repeat",
        worker_id="worker_1",
        error_code="historical_custom_failure",
        user_id="owner_1",
        repos=repos,
        now=datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc),
    )

    assert result["eligible"] is False
    assert posted == []


def test_missing_secret_user_configuration_error_does_not_alert(monkeypatch):
    repos = _repos()
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(alerting, "_post_ops_webhook", lambda **kwargs: posted.append(kwargs))

    result = alerting.alert_ops_run_failure(
        run_id="run_user_config",
        worker_id="worker_1",
        error_code="missing_secret",
        user_id="owner_1",
        repos=repos,
        now=datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc),
    )

    assert result == {"sent": False, "eligible": False, "error_code": "missing_secret"}
    assert posted == []


def test_existing_user_configuration_code_does_not_alert(monkeypatch):
    repos = _repos()
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(alerting, "_post_ops_webhook", lambda **kwargs: posted.append(kwargs))

    result = alerting.alert_ops_run_failure(
        run_id="run_user_config",
        worker_id="worker_1",
        error_code="approval_proposal_config_error",
        user_id="owner_1",
        repos=repos,
        now=datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc),
    )

    assert result["eligible"] is False
    assert posted == []


def test_existing_platform_code_alerts_even_with_history(monkeypatch):
    repos = _repos()
    repos.runs.stats["e2b_quota_exhausted"] = (4, True)
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(
        alerting,
        "_post_ops_webhook",
        lambda **kwargs: posted.append(kwargs["payload"]),
    )

    result = alerting.alert_ops_run_failure(
        run_id="run_platform",
        worker_id="worker_1",
        error_code="e2b_quota_exhausted",
        user_id="owner_1",
        repos=repos,
        now=datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc),
    )

    assert result["sent"] is True
    assert posted[0]["count_same_code_last_15m"] == 4


def test_platform_burst_uses_one_bounded_dispatch_worker(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    calls: list[str] = []

    def _blocked_alert(**kwargs):
        calls.append(kwargs["run_id"])
        started.set()
        assert release.wait(timeout=5)

    monkeypatch.setattr(alerting, "alert_ops_run_failure", _blocked_alert)

    for index in range(200):
        alerting.dispatch_ops_run_failure(
            run_id=f"run_{index}",
            worker_id="worker_1",
            error_code="e2b_sandbox_error",
            user_id="owner_1",
            repos=_repos(),
        )

    assert started.wait(timeout=2)
    workers = [
        thread
        for thread in threading.enumerate()
        if thread.name == "floom-ops-alert-dispatch"
    ]
    assert len(workers) == 1
    assert calls == ["run_0"]
    assert alerting._ops_suppressed_counts["e2b_sandbox_error"] == 199

    release.set()
    alerting._ops_dispatch_queue.join()


def test_worker_watchdog_trip_alerts_once(monkeypatch):
    repos = _repos()
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    posted: list[dict] = []
    monkeypatch.setattr(
        alerting,
        "_post_ops_webhook",
        lambda **kwargs: posted.append(kwargs["payload"]),
    )
    now = datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc)

    first = alerting.alert_ops_watchdog_trip(repos=repos, now=now)
    second = alerting.alert_ops_watchdog_trip(
        repos=repos,
        now=now + timedelta(minutes=1),
    )

    assert first["sent"] is True
    assert second["suppressed"] is True
    assert posted == [
        {
            "error_code": "worker_service_self_watchdog",
            "worker_id": "floom-worker-service",
            "workspace_id": "platform",
            "run_id": "",
            "ts": "2026-07-20T16:00:00+00:00",
            "count_same_code_last_15m": 1,
        }
    ]


def test_general_webhook_transport_posts_exact_compact_json(monkeypatch):
    payload = {
        "error_code": "scheduler_missed",
        "worker_id": "worker_1",
        "workspace_id": "ws_1",
        "run_id": "run_1",
        "ts": "2026-07-20T16:00:00+00:00",
        "count_same_code_last_15m": 2,
    }
    captured: dict = {}

    def _open(request, *, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return MagicMock(__enter__=lambda value: value, __exit__=lambda *args: False)

    monkeypatch.setattr(alerting, "assert_safe_outbound_url", lambda *args, **kwargs: None)
    monkeypatch.setattr(alerting, "_open_pinned_webhook", _open)

    alerting._post_ops_webhook(
        url="https://hooks.example.com/ops",
        payload=payload,
        slack=False,
    )

    assert captured["timeout"] == 5
    assert captured["request"].full_url == "https://hooks.example.com/ops"
    assert json.loads(captured["request"].data.decode("utf-8")) == payload
    assert captured["request"].data.decode("utf-8") == json.dumps(
        payload,
        separators=(",", ":"),
        ensure_ascii=True,
    )


def test_delivery_failure_logs_no_webhook_token(monkeypatch, caplog):
    repos = _repos()
    token = "secret-webhook-token-must-not-leak"
    monkeypatch.setenv(
        "WORKEROS_OPS_ALERT_WEBHOOK",
        f"https://hooks.example.com/{token}",
    )
    monkeypatch.setattr(
        alerting,
        "_post_ops_webhook",
        lambda **kwargs: (_ for _ in ()).throw(OSError(kwargs["url"])),
    )

    result = alerting.alert_ops_run_failure(
        run_id="run_1",
        worker_id="worker_1",
        error_code="scheduler_missed",
        user_id="owner_1",
        repos=repos,
        now=datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc),
    )

    assert result["delivery_failed"] is True
    assert token not in caplog.text


def test_delivery_failure_releases_throttle_reservation(monkeypatch):
    repos = _repos()
    monkeypatch.setenv("WORKEROS_OPS_ALERT_WEBHOOK", "https://hooks.example.com/ops")
    attempts: list[str] = []

    def _post(**kwargs):
        attempts.append(kwargs["payload"]["run_id"])
        if len(attempts) == 1:
            raise OSError("temporary network failure")

    monkeypatch.setattr(alerting, "_post_ops_webhook", _post)
    now = datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc)

    first = alerting.alert_ops_run_failure(
        run_id="run_1",
        worker_id="worker_1",
        error_code="e2b_sandbox_error",
        user_id="owner_1",
        repos=repos,
        now=now,
    )
    second = alerting.alert_ops_run_failure(
        run_id="run_2",
        worker_id="worker_1",
        error_code="e2b_sandbox_error",
        user_id="owner_1",
        repos=repos,
        now=now + timedelta(minutes=1),
    )

    assert first["delivery_failed"] is True
    assert second["sent"] is True
    assert attempts == ["run_1", "run_2"]


def test_dispatch_orphan_reaper_fires_ops_evaluation(monkeypatch):
    import run_service

    dispatched: list[dict] = []
    repos = SimpleNamespace(
        runs=SimpleNamespace(
            fail_stale_running_without_sandbox_logs=lambda **kwargs: [
                {
                    "run_id": "run_orphan",
                    "user_id": "owner_1",
                    "worker_id": "worker_1",
                }
            ],
            add_log=lambda **kwargs: None,
        )
    )
    monkeypatch.setattr(
        alerting,
        "dispatch_ops_run_failure",
        lambda **kwargs: dispatched.append(kwargs),
    )

    failed = run_service._fail_dispatch_orphan_rows(
        repos,
        now_dt=datetime(2026, 7, 20, 16, 0, tzinfo=timezone.utc),
        timeout_seconds=0,
    )

    assert len(failed) == 1
    assert dispatched[0]["error_code"] == "run_claimed_without_dispatch"
    assert dispatched[0]["run_id"] == "run_orphan"


def test_synthetic_scheduler_failure_dispatches_ops_evaluation(monkeypatch):
    import scheduler

    created: list[dict] = []
    dispatched: list[dict] = []
    repos = SimpleNamespace(
        runs=SimpleNamespace(create=lambda **kwargs: created.append(kwargs)),
    )
    monkeypatch.setattr(
        scheduler,
        "_maybe_pause_scheduled_worker_after_setup_failure",
        lambda **kwargs: False,
    )
    monkeypatch.setattr(
        alerting,
        "dispatch_ops_run_failure",
        lambda **kwargs: dispatched.append(kwargs),
    )

    run_id = scheduler._create_synthetic_failed_schedule_run(
        repos,
        worker_id="worker-scheduled",
        user_id="user-a",
        now_iso="2026-07-20T16:00:00+00:00",
        error="scheduled fire missed",
        error_code="scheduler_missed",
    )

    assert run_id
    assert created[0]["status"] == "failed"
    assert dispatched == [
        {
            "run_id": run_id,
            "worker_id": "worker-scheduled",
            "error_code": "scheduler_missed",
            "user_id": "user-a",
            "repos": repos,
        }
    ]
