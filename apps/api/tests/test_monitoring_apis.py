"""Tests for Tier-1 and Tier-2 monitoring APIs.

Covers:
  GET  /stats                              — workspace aggregate stats
  GET  /workers/{id}/stats                 — single worker stats
  GET  /workers/{id}/logs                  — cross-run log search (level, since)
  GET  /runs/{id}/logs?level=              — per-run log level filter
  POST /workers/{id}/alerts                — register webhook / email alert
  GET  /workers/{id}/alerts                — list alerts
  DELETE /workers/{id}/alerts/{alert_id}   — remove alert

All tests run against an in-memory SQLite DB with a real FastAPI TestClient;
no network calls are made.
"""

from __future__ import annotations

import importlib
import json
import platform
import sys
import threading
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# The integration-test fixture boots the full FastAPI app (SQLite-backed) which
# imports `fcntl` — a Linux-only module. Skip those tests on Windows; they run
# in CI on ubuntu-latest.
_LINUX_ONLY = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="SQLite db layer uses fcntl (Linux only); runs in CI on ubuntu-latest",
)

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import socket as _socket  # noqa: E402


@pytest.fixture(autouse=True)
def _stub_outbound_dns():
    """Alert creation + webhook delivery now SSRF-validate the URL, which
    resolves the host (fail-closed). These tests use public-looking example
    hostnames that don't resolve in the sandbox, so stub DNS to a public IP.
    Keeps the file's "no network calls" invariant while exercising the real
    (safe) validation path. SSRF rejection is covered in test_alert_webhook_ssrf.
    """
    def _fake_getaddrinfo(host, *args, **kwargs):
        return [(_socket.AF_INET, _socket.SOCK_STREAM, _socket.IPPROTO_TCP, "", ("93.184.216.34", 0))]

    with patch("models.socket.getaddrinfo", side_effect=_fake_getaddrinfo):
        yield

_WORKER_YML = """\
schema_version: "0.3"
name: "ai-news-digest"
title: "AI News Digest"
description: "Fetches AI news and posts to Discord every 60 minutes."
version: "0.1.0"
trigger:
  type: "schedule"
  cron: "0 * * * *"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs:
  - name: "discord_channel_id"
    kind: "scalar"
    type: "string"
    required: true
    label: "Discord Channel ID"
    default: "123456789"
  - name: "max_stories"
    kind: "scalar"
    type: "number"
    required: false
    label: "Max Stories"
    default: 3
secrets:
  - "DISCORD_BOT_TOKEN"
  - "NEWS_API_KEY"
connections: []
"""

_WORKER_ID = "ai-news-digest"
_SECRET = "test-secret-monitoring"
_USER_ID = "federico"


@pytest.fixture
def client_and_repos(monkeypatch, tmp_path):
    """Spin up a full FastAPI TestClient with an isolated SQLite DB."""
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    wdir = workers_dir / _WORKER_ID
    wdir.mkdir()
    (wdir / "worker.yml").write_text(_WORKER_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('running')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", _SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id=_USER_ID)

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": _SECRET})
    repos = db.get_repositories()
    yield client, repos
    db.get_repositories.cache_clear()


def _create_run(client, status: str = "completed", error: str | None = None) -> str:
    """Create a dummy run row via the repos directly (bypasses sandbox)."""
    import importlib as _il
    db = _il.import_module("db")
    repos = db.get_repositories()
    import uuid
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    repos.runs.create(
        user_id=_USER_ID,
        run_id=run_id,
        worker_id=_WORKER_ID,
        trigger_source="manual",
        status=status,
        runner="e2b",
        error=error,
        duration_ms=1234,
    )
    return run_id


def _add_log(repos, run_id: str, level: str = "info", message: str = "hello"):
    repos.runs.add_log(
        user_id=_USER_ID,
        run_id=run_id,
        level=level,
        message=message,
        timestamp="2026-05-31T00:00:00Z",
    )


# ---------------------------------------------------------------------------
# GET /stats
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestWorkspaceStats:
    def test_returns_200_with_correct_shape(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get("/stats")
        assert resp.status_code == 200
        body = resp.json()
        assert "total_workers" in body
        assert "active_workers" in body
        assert "total_runs_7d" in body
        assert body["total_workers"] >= 1  # at least our test worker

    def test_total_workers_counts_non_archived(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get("/stats")
        body = resp.json()
        assert body["total_workers"] == 1

    def test_requires_auth(self, client_and_repos):
        client, _ = client_and_repos
        from fastapi.testclient import TestClient
        import importlib as _il
        main = _il.import_module("main")
        unauthed = TestClient(main.app)
        resp = unauthed.get("/stats")
        assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# GET /workers/{id}/stats
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestWorkerStats:
    def test_returns_200_for_known_worker(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get(f"/workers/{_WORKER_ID}/stats")
        assert resp.status_code == 200
        body = resp.json()
        assert body["worker_id"] == _WORKER_ID
        assert "runs_7d" in body
        assert "success_rate_7d" in body
        assert "avg_duration_ms" in body
        assert "total_failures" in body

    def test_returns_404_for_unknown_worker(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get("/workers/does-not-exist/stats")
        assert resp.status_code == 404

    def test_total_failures_counts_failed_runs(self, client_and_repos):
        client, repos = client_and_repos
        _create_run(client, status="failed", error="Something broke")
        _create_run(client, status="failed", error="Another error")
        _create_run(client, status="completed")
        resp = client.get(f"/workers/{_WORKER_ID}/stats")
        body = resp.json()
        assert body["total_failures"] >= 2

    def test_last_error_reflects_most_recent_failure(self, client_and_repos):
        client, repos = client_and_repos
        _create_run(client, status="failed", error="Disk full")
        resp = client.get(f"/workers/{_WORKER_ID}/stats")
        body = resp.json()
        assert body["last_error"] is not None


# ---------------------------------------------------------------------------
# GET /workers/{id}/logs
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestWorkerLogs:
    def test_returns_404_for_unknown_worker(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get("/workers/ghost-worker/logs")
        assert resp.status_code == 404

    def test_returns_empty_list_when_no_runs(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get(f"/workers/{_WORKER_ID}/logs")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_logs_across_runs(self, client_and_repos):
        client, repos = client_and_repos
        run_id1 = _create_run(client)
        run_id2 = _create_run(client)
        _add_log(repos, run_id1, "info", "Run 1 started")
        _add_log(repos, run_id2, "error", "Run 2 crashed")

        resp = client.get(f"/workers/{_WORKER_ID}/logs")
        assert resp.status_code == 200
        messages = [e["message"] for e in resp.json()]
        assert any("Run 1" in m for m in messages)
        assert any("Run 2" in m for m in messages)

    def test_level_filter_restricts_results(self, client_and_repos):
        client, repos = client_and_repos
        run_id = _create_run(client)
        _add_log(repos, run_id, "info", "Info message")
        _add_log(repos, run_id, "error", "Error message")
        _add_log(repos, run_id, "debug", "Debug message")

        resp = client.get(f"/workers/{_WORKER_ID}/logs?level=error")
        assert resp.status_code == 200
        body = resp.json()
        assert all(e["level"] == "error" for e in body)
        messages = [e["message"] for e in body]
        assert any("Error" in m for m in messages)

    def test_each_log_has_run_id(self, client_and_repos):
        client, repos = client_and_repos
        run_id = _create_run(client)
        _add_log(repos, run_id, "info", "Test log")

        resp = client.get(f"/workers/{_WORKER_ID}/logs")
        assert resp.status_code == 200
        for entry in resp.json():
            assert "run_id" in entry
            assert "level" in entry
            assert "message" in entry
            assert "timestamp" in entry

    def test_limit_param_respected(self, client_and_repos):
        client, repos = client_and_repos
        run_id = _create_run(client)
        for i in range(20):
            _add_log(repos, run_id, "info", f"Log entry {i}")

        resp = client.get(f"/workers/{_WORKER_ID}/logs?limit=5")
        assert resp.status_code == 200
        assert len(resp.json()) <= 5


# ---------------------------------------------------------------------------
# GET /runs/{id}/logs?level=
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestRunLogsLevelFilter:
    def test_no_filter_returns_all_logs(self, client_and_repos):
        client, repos = client_and_repos
        run_id = _create_run(client)
        _add_log(repos, run_id, "info", "Info")
        _add_log(repos, run_id, "error", "Error")

        resp = client.get(f"/runs/{run_id}/logs")
        assert resp.status_code == 200
        levels = {e["level"] for e in resp.json()}
        assert "info" in levels
        assert "error" in levels

    def test_level_filter_returns_only_matching(self, client_and_repos):
        client, repos = client_and_repos
        run_id = _create_run(client)
        _add_log(repos, run_id, "info", "Info")
        _add_log(repos, run_id, "error", "Error")
        _add_log(repos, run_id, "warning", "Warning")

        resp = client.get(f"/runs/{run_id}/logs?level=error")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) >= 1
        assert all(e["level"] == "error" for e in body)

    def test_returns_404_for_unknown_run(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get("/runs/run_doesnotexist/logs")
        assert resp.status_code == 404

    def test_empty_result_for_non_matching_level(self, client_and_repos):
        client, repos = client_and_repos
        run_id = _create_run(client)
        _add_log(repos, run_id, "info", "Info only")

        resp = client.get(f"/runs/{run_id}/logs?level=error")
        assert resp.status_code == 200
        assert resp.json() == []


# ---------------------------------------------------------------------------
# POST /workers/{id}/alerts
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestCreateAlert:
    def test_create_webhook_alert_returns_201(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/notify", "on": ["failed"]},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["url"] == "https://hooks.example.com/notify"
        assert body["on"] == ["failed"]
        assert "id" in body
        assert body["worker_id"] == _WORKER_ID

    def test_create_email_alert_returns_201(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"email_to": ["alice@example.com", "bob@example.com"], "on": ["failed"]},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["email_to"] == ["alice@example.com", "bob@example.com"]
        assert body["on"] == ["failed"]

    def test_create_combined_webhook_and_email(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={
                "url": "https://hooks.example.com/notify",
                "email_to": ["ops@example.com"],
                "on": ["failed", "completed"],
            },
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["url"] == "https://hooks.example.com/notify"
        assert body["email_to"] == ["ops@example.com"]
        assert set(body["on"]) == {"failed", "completed"}

    def test_create_alert_returns_400_if_no_channel(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"on": ["failed"]},
        )
        assert resp.status_code == 400

    def test_create_alert_returns_400_for_invalid_event(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://example.com", "on": ["unknown_event"]},
        )
        assert resp.status_code == 400

    def test_create_alert_returns_404_for_unknown_worker(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(
            "/workers/ghost/alerts",
            json={"url": "https://example.com/hook", "on": ["failed"]},
        )
        assert resp.status_code == 404

    def test_create_alert_with_description(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={
                "url": "https://hooks.example.com/notify",
                "on": ["failed"],
                "description": "Notify ops on failure",
            },
        )
        assert resp.status_code == 201
        assert resp.json()["description"] == "Notify ops on failure"


# ---------------------------------------------------------------------------
# GET /workers/{id}/alerts
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestListAlerts:
    def test_empty_list_when_no_alerts(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get(f"/workers/{_WORKER_ID}/alerts")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_returns_404_for_unknown_worker(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.get("/workers/ghost/alerts")
        assert resp.status_code == 404

    def test_lists_all_registered_alerts(self, client_and_repos):
        client, _ = client_and_repos
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://one.example.com/hook", "on": ["failed"]},
        )
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"email_to": ["a@example.com"], "on": ["completed"]},
        )
        resp = client.get(f"/workers/{_WORKER_ID}/alerts")
        assert resp.status_code == 200
        assert len(resp.json()) == 2

    def test_each_alert_has_required_fields(self, client_and_repos):
        client, _ = client_and_repos
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/a", "on": ["failed"]},
        )
        resp = client.get(f"/workers/{_WORKER_ID}/alerts")
        alert = resp.json()[0]
        assert "id" in alert
        assert "worker_id" in alert
        assert "on" in alert
        assert "created_at" in alert


# ---------------------------------------------------------------------------
# DELETE /workers/{id}/alerts/{alert_id}
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestDeleteAlert:
    def test_delete_existing_alert_returns_204(self, client_and_repos):
        client, _ = client_and_repos
        create_resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/del", "on": ["failed"]},
        )
        alert_id = create_resp.json()["id"]

        del_resp = client.delete(f"/workers/{_WORKER_ID}/alerts/{alert_id}")
        assert del_resp.status_code == 204

    def test_deleted_alert_no_longer_listed(self, client_and_repos):
        client, _ = client_and_repos
        create_resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/del2", "on": ["failed"]},
        )
        alert_id = create_resp.json()["id"]
        client.delete(f"/workers/{_WORKER_ID}/alerts/{alert_id}")

        list_resp = client.get(f"/workers/{_WORKER_ID}/alerts")
        ids = [a["id"] for a in list_resp.json()]
        assert alert_id not in ids

    def test_delete_unknown_alert_returns_404(self, client_and_repos):
        client, _ = client_and_repos
        resp = client.delete(f"/workers/{_WORKER_ID}/alerts/alrt_doesnotexist")
        assert resp.status_code == 404

    def test_delete_alert_from_wrong_worker_returns_404(self, client_and_repos):
        client, _ = client_and_repos
        create_resp = client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/x", "on": ["failed"]},
        )
        alert_id = create_resp.json()["id"]

        resp = client.delete(f"/workers/other-worker/alerts/{alert_id}")
        assert resp.status_code in (404,)  # worker not found or alert not found


# ---------------------------------------------------------------------------
# Webhook firing (unit test — no real HTTP)
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestAlertWebhookFiring:
    def test_webhook_fires_on_failure(self, client_and_repos, monkeypatch):
        """_fire_alert_webhooks calls urllib.request.urlopen for matching alerts."""
        client, repos = client_and_repos
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/fire", "on": ["failed"]},
        )

        run_id = _create_run(client, status="failed")

        calls = []

        def mock_urlopen(req, timeout=None):
            calls.append(req.full_url)
            cm = MagicMock()
            cm.__enter__ = lambda s: s
            cm.__exit__ = MagicMock(return_value=False)
            return cm

        run_svc = importlib.import_module("run_service")
        with patch("models.socket.getaddrinfo",
                   return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]):
            with patch.object(run_svc, "_open_pinned_webhook", side_effect=mock_urlopen):
                run_svc._fire_alert_webhooks(
                    run_id=run_id,
                    worker_id=_WORKER_ID,
                    status="failed",
                    error="Test error",
                    repos=repos,
                )

        assert any("hooks.example.com" in url for url in calls), f"No webhook call, got: {calls}"

    def test_webhook_not_fired_when_event_does_not_match(self, client_and_repos):
        """An alert subscribed to 'completed' should not fire on 'failed'."""
        client, repos = client_and_repos
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/completed-only", "on": ["completed"]},
        )
        run_id = _create_run(client, status="failed")

        calls = []
        run_svc = importlib.import_module("run_service")
        with patch.object(run_svc, "_open_pinned_webhook", side_effect=lambda *a, **kw: calls.append(a)):
            run_svc._fire_alert_webhooks(
                run_id=run_id,
                worker_id=_WORKER_ID,
                status="failed",
                error="Nope",
                repos=repos,
            )

        assert calls == [], "Webhook should NOT have fired for a 'completed'-only alert on a failed run"

    def test_run_status_update_fires_registered_failure_alert(self, client_and_repos):
        """The real run outcome path dispatches existing WorkerAlert rows."""
        client, repos = client_and_repos
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/run-status", "on": ["failed"]},
        )
        run_id = _create_run(client, status="queued")
        delivered = threading.Event()
        calls: list[str] = []

        def mock_open(req, timeout=None):
            calls.append(req.full_url)
            delivered.set()
            cm = MagicMock()
            cm.__enter__ = lambda s: s
            cm.__exit__ = MagicMock(return_value=False)
            return cm

        run_svc = importlib.import_module("run_service")
        alerting = importlib.import_module("alerting")
        with patch.object(run_svc, "_open_pinned_webhook", side_effect=mock_open), \
             patch.object(alerting, "alert_worker_failure_if_needed", return_value=None):
            run_svc.update_run_status(
                run_id,
                "failed",
                error="Test outcome failure",
                user_id=_USER_ID,
                repos=repos,
            )
            assert delivered.wait(timeout=2), f"registered alert did not fire; calls={calls}"

        assert calls == ["https://hooks.example.com/run-status"]

    def test_run_status_update_does_not_double_fire_alerts(self, client_and_repos):
        """Central terminal-status dispatch sends one alert for one failed outcome."""
        client, repos = client_and_repos
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"url": "https://hooks.example.com/once", "on": ["failed"]},
        )
        run_id = _create_run(client, status="queued")
        delivered = threading.Event()
        calls: list[str] = []

        def mock_open(req, timeout=None):
            calls.append(req.full_url)
            delivered.set()
            cm = MagicMock()
            cm.__enter__ = lambda s: s
            cm.__exit__ = MagicMock(return_value=False)
            return cm

        run_svc = importlib.import_module("run_service")
        alerting = importlib.import_module("alerting")
        with patch.object(run_svc, "_open_pinned_webhook", side_effect=mock_open), \
             patch.object(alerting, "alert_worker_failure_if_needed", return_value=None):
            run_svc.update_run_status(
                run_id,
                "failed",
                error="Test outcome failure",
                user_id=_USER_ID,
                repos=repos,
            )
            assert delivered.wait(timeout=2), f"registered alert did not fire; calls={calls}"

        assert calls == ["https://hooks.example.com/once"]


@_LINUX_ONLY
class TestOverviewConsecutiveFailureAlerting:
    def test_immediate_incident_check_notifies_once_at_threshold(self, client_and_repos):
        client, repos = client_and_repos
        for index in range(1, 4):
            repos.runs.create(
                user_id=_USER_ID,
                run_id=f"run_{uuid.uuid4().hex[:12]}",
                worker_id=_WORKER_ID,
                trigger_source="schedule",
                status="failed",
                runner="e2b",
                error=f"boom {index}",
                error_code="test_failure",
                created_at=f"2026-06-06T11:0{index}:00+00:00",
                completed_at=f"2026-06-06T11:0{index}:10+00:00",
            )

        alerting = importlib.import_module("alerting")
        notify_calls: list[tuple[str, str, str, str]] = []
        with patch.object(
            alerting,
            "_notify",
            side_effect=lambda worker_id, worker_name, reason, details: notify_calls.append(
                (worker_id, worker_name, reason, details)
            ),
        ):
            first = alerting.alert_worker_failure_if_needed(_WORKER_ID)
            second = alerting.alert_worker_failure_if_needed(_WORKER_ID)

        assert first and first["opened"] is True
        assert first["consecutive_failures"] == 3
        assert second and second["already_open"] is True
        assert len(notify_calls) == 1
        assert notify_calls[0][0] == _WORKER_ID

    def test_overview_surfaces_consecutive_failures_at_threshold(self, client_and_repos):
        client, repos = client_and_repos
        for index, status in enumerate(["completed", "failed", "failed", "failed"], start=1):
            repos.runs.create(
                user_id=_USER_ID,
                run_id=f"run_{uuid.uuid4().hex[:12]}",
                worker_id=_WORKER_ID,
                trigger_source="schedule",
                status=status,
                runner="e2b",
                error="boom" if status == "failed" else None,
                error_code="test_failure" if status == "failed" else None,
                created_at=f"2026-06-06T10:0{index}:00+00:00",
                completed_at=f"2026-06-06T10:0{index}:10+00:00",
            )

        resp = client.get("/system/overview")
        assert resp.status_code == 200
        items = resp.json()["needs_attention"]
        consecutive = [
            item for item in items
            if item["type"] == "consecutive_failures" and item["worker_id"] == _WORKER_ID
        ]
        assert len(consecutive) == 1
        assert consecutive[0]["recent_failure_count"] == 3
        assert consecutive[0]["message"] == "3 consecutive failures"


# ---------------------------------------------------------------------------
# Email sending (pure unit tests — no DB, no fcntl, cross-platform)
# ---------------------------------------------------------------------------

class TestEmailNotifications:
    """Tests for _send_email_notification. These are pure-unit — they mock
    Resend entirely and do NOT import db (so they pass on Windows too)."""

    def _import_send_email(self):
        """Import _send_email_notification by loading run_service with fcntl mocked."""
        # Stub out fcntl so run_service can be imported on Windows
        if "fcntl" not in sys.modules:
            sys.modules["fcntl"] = MagicMock()
        for name in list(sys.modules.keys()):
            if name in {"run_service"} or name.startswith("run_service."):
                sys.modules.pop(name, None)
        # Also stub db.sqlite to avoid the real import chain
        if "db.sqlite" not in sys.modules or not isinstance(sys.modules.get("db.sqlite"), MagicMock):
            sys.modules["db.sqlite"] = MagicMock()
        if "db" not in sys.modules or not isinstance(sys.modules.get("db"), MagicMock):
            sys.modules.setdefault("db", MagicMock())
        if "db.factory" not in sys.modules or not isinstance(sys.modules.get("db.factory"), MagicMock):
            sys.modules.setdefault("db.factory", MagicMock())
        run_svc = importlib.import_module("run_service")
        return run_svc

    def test_send_email_skips_when_resend_not_configured(self, monkeypatch):
        """When RESEND_API_KEY is absent, no Resend call is attempted."""
        monkeypatch.delenv("RESEND_API_KEY", raising=False)
        fake_resend = MagicMock()
        monkeypatch.setitem(sys.modules, "resend", fake_resend)
        run_svc = self._import_send_email()

        run_svc._send_email_notification(
            to_addrs=["ops@example.com"],
            worker_name="Worker",
            run_id="run_123",
            worker_id="worker_123",
            status="failed",
            error=None,
        )

        fake_resend.Emails.send.assert_not_called()

    def test_send_email_uses_resend_payload_and_escapes_html(self, monkeypatch):
        """Configured email notifications call Resend with safe HTML and plain text."""
        monkeypatch.setenv("RESEND_API_KEY", "re_test")
        monkeypatch.setenv("NOTIFY_FROM_EMAIL", "notifications@example.com")
        fake_resend = MagicMock()
        monkeypatch.setitem(sys.modules, "resend", fake_resend)
        run_svc = self._import_send_email()

        run_svc._send_email_notification(
            to_addrs=["ops@example.com"],
            worker_name="Weekly <Digest>",
            run_id="run_<123>",
            worker_id="worker_<123>",
            status="failed",
            error="Boom <script>",
        )

        fake_resend.Emails.send.assert_called_once()
        payload = fake_resend.Emails.send.call_args.args[0]
        assert fake_resend.api_key == "re_test"
        assert payload["from"] == "notifications@example.com"
        assert payload["to"] == ["ops@example.com"]
        assert payload["subject"] == "Worker Weekly <Digest> failed"
        assert "Weekly &lt;Digest&gt;" in payload["html"]
        assert "run_&lt;123&gt;" in payload["html"]
        assert "Boom &lt;script&gt;" in payload["html"]
        assert "Weekly <Digest>" in payload["text"]

    def test_notify_config_model_accepts_email_to(self):
        """NotifyConfig Pydantic model accepts email_to list."""
        # Re-import models fresh (no db dependency)
        if "models" not in sys.modules:
            models = importlib.import_module("models")
        else:
            models = sys.modules["models"]
        cfg = models.NotifyConfig(email_to=["alice@example.com", "bob@example.com"], on=["failed"])
        assert cfg.email_to == ["alice@example.com", "bob@example.com"]
        assert cfg.url is None

    def test_notify_config_model_accepts_url(self):
        """NotifyConfig Pydantic model accepts url."""
        if "models" not in sys.modules:
            models = importlib.import_module("models")
        else:
            models = sys.modules["models"]
        cfg = models.NotifyConfig(url="https://hooks.example.com/hook", on=["failed"])
        assert cfg.url == "https://hooks.example.com/hook"
        assert cfg.email_to is None

    def test_worker_alert_create_model_requires_at_least_one_channel(self):
        """WorkerAlertCreate has optional url and optional email_to."""
        if "models" not in sys.modules:
            models = importlib.import_module("models")
        else:
            models = sys.modules["models"]
        # Both channels optional at model level — validation happens in endpoint
        alert = models.WorkerAlertCreate(on=["failed"])
        assert alert.url is None
        assert alert.email_to is None

    def test_worker_alert_create_model_accepts_email(self):
        """WorkerAlertCreate accepts email_to."""
        if "models" not in sys.modules:
            models = importlib.import_module("models")
        else:
            models = sys.modules["models"]
        alert = models.WorkerAlertCreate(email_to=["ops@example.com"], on=["failed"])
        assert alert.email_to == ["ops@example.com"]


# ---------------------------------------------------------------------------
# Email integration with alert firing (Linux CI only)
# ---------------------------------------------------------------------------

@_LINUX_ONLY
class TestAlertEmailFiring:
    def test_email_alert_fired_via_fire_alert_webhooks(self, client_and_repos, monkeypatch):
        """POST /alerts with email_to triggers _send_email_notification."""
        monkeypatch.setenv("RESEND_API_KEY", "re_test")

        client, repos = client_and_repos
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"email_to": ["notify@example.com"], "on": ["failed"]},
        )
        run_id = _create_run(client, status="failed")

        run_svc = importlib.import_module("run_service")
        email_calls: list[list[str]] = []

        def mock_send_email(*, to_addrs, **kwargs):
            email_calls.append(to_addrs)

        with patch.object(run_svc, "_send_email_notification", side_effect=mock_send_email):
            run_svc._fire_alert_webhooks(
                run_id=run_id,
                worker_id=_WORKER_ID,
                status="failed",
                error="Test",
                repos=repos,
            )

        assert len(email_calls) == 1
        assert "notify@example.com" in email_calls[0]

    def test_email_not_fired_for_non_matching_event(self, client_and_repos):
        """An email alert for 'completed' does not fire on 'failed'."""
        client, repos = client_and_repos
        client.post(
            f"/workers/{_WORKER_ID}/alerts",
            json={"email_to": ["ops@example.com"], "on": ["completed"]},
        )
        run_id = _create_run(client, status="failed")

        run_svc = importlib.import_module("run_service")
        email_calls: list = []

        with patch.object(run_svc, "_send_email_notification", side_effect=lambda **kw: email_calls.append(kw)):
            run_svc._fire_alert_webhooks(
                run_id=run_id,
                worker_id=_WORKER_ID,
                status="failed",
                error="Error",
                repos=repos,
            )

        assert email_calls == []
