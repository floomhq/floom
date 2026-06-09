from __future__ import annotations

from datetime import datetime, timedelta, timezone
import sys
import types

from fastapi.testclient import TestClient

from test_s35_runtime_hardening import AUTH_HEADER, _insert_minimal_worker, _load_api


def _sqlite_time(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M:%S")


def _insert_run(main, run_id: str, worker_id: str, status: str, days_ago: int, duration_ms: int | None = None):
    with main.get_db() as conn:
        conn.execute(
            """
            INSERT INTO runs
                (id, worker_id, status, trigger_source, runner, created_at,
                 completed_at, duration_ms)
            VALUES (?, ?, ?, 'manual', 'e2b', ?, ?, ?)
            """,
            (
                run_id,
                worker_id,
                status,
                _sqlite_time(days_ago),
                _sqlite_time(days_ago),
                duration_ms,
            ),
        )


def test_recent_stats_include_success_rate_change_7d(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    worker_id = "s35-observability-stats"
    _insert_minimal_worker(main, worker_id)

    _insert_run(main, "prev-ok-1", worker_id, "completed", 10)
    _insert_run(main, "prev-ok-2", worker_id, "completed", 9)
    _insert_run(main, "current-ok", worker_id, "completed", 2)
    _insert_run(main, "current-failed", worker_id, "failed", 1)

    client = TestClient(main.app)
    response = client.get("/workers", headers=AUTH_HEADER)

    assert response.status_code == 200, response.text
    worker = next(item for item in response.json() if item["id"] == worker_id)
    stats = worker["recent_stats"]
    assert stats["runs_7d"] == 2
    assert stats["success_rate_7d"] == 0.5
    assert stats["success_rate_change_7d"] == -0.5


def test_health_runs_dependency_checks_and_uses_cache(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    calls: list[str] = []

    main._HEALTH_CACHE["checked_at"] = 0.0
    main._HEALTH_CACHE["payload"] = None
    monkeypatch.setattr(main, "_health_check_db", lambda: calls.append("db") or {"ok": True})
    monkeypatch.setattr(main, "_health_check_disk", lambda: calls.append("disk") or {"ok": True})
    monkeypatch.setattr(main, "_health_check_e2b", lambda: calls.append("e2b") or {"ok": True})
    monkeypatch.setattr(main, "_health_check_openai", lambda: calls.append("openai") or {"ok": True})
    monkeypatch.setattr(main, "_health_check_composio", lambda: calls.append("composio") or {"ok": True})

    client = TestClient(main.app)
    first = client.get("/health")
    second = client.get("/health")

    assert first.status_code == 200, first.text
    assert first.json()["status"] == "ok"
    assert set(first.json()["checks"]) == {"db", "disk", "e2b", "openai", "composio", "scheduler"}
    assert first.json()["checks"]["scheduler"]["ok"] is True
    assert second.status_code == 200, second.text
    assert calls == ["db", "disk", "e2b", "openai", "composio"]


def test_health_check_e2b_bounds_sdk_call_without_unsupported_kwargs(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    captured: dict[str, object] = {}

    class FakeListing:
        def next_items(self):
            return []

    class FakeSandbox:
        @staticmethod
        def list(*args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return FakeListing()

    monkeypatch.setitem(sys.modules, "e2b", types.SimpleNamespace(Sandbox=FakeSandbox))
    monkeypatch.setenv("E2B_API_KEY", "e2b-test-key")

    assert main._health_check_e2b() == {"ok": True}
    assert captured["kwargs"] == {"limit": 1}


def test_prometheus_metrics_expose_run_counters_duration_and_active_runs(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    worker_id = "s35-observability-metrics"
    _insert_minimal_worker(main, worker_id)
    _insert_run(main, "metrics-ok", worker_id, "completed", 0, duration_ms=2500)
    _insert_run(main, "metrics-failed", worker_id, "failed", 0, duration_ms=5000)
    _insert_run(main, "metrics-running", worker_id, "running", 0)

    client = TestClient(main.app)
    response = client.get("/metrics", headers=AUTH_HEADER)

    assert response.status_code == 200, response.text
    body = response.text
    assert 'workeros_runs_total{worker_id="s35-observability-metrics",status="completed"} 1' in body
    assert 'workeros_runs_total{worker_id="s35-observability-metrics",status="failed"} 1' in body
    assert 'workeros_run_duration_seconds_count{worker_id="s35-observability-metrics"} 2' in body
    assert "workeros_sandbox_spawn_errors_total" in body
    assert "workeros_db_connection_errors_total 0" in body
    assert "workeros_active_runs 1" in body
