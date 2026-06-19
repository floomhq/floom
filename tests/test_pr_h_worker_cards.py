"""
Tests for PR H: worker card improvements.

Coverage:
- _build_triggers_list: all configured triggers for a worker dict
- RecentStats projection via _get_stats_batch (mocked DB)
- WorkerSummary model includes triggers + recent_stats fields
"""

from __future__ import annotations

import os
import sys
import sqlite3
import tempfile
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "api"))

os.environ.setdefault("FLOOM_WORKERS_DIR", str(REPO_ROOT / "workers"))

# Use a temp DB so init_db() in main.py succeeds without touching real data
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ.pop("FLOOM_SECRET", None)  # dev mode

import db as _db_module  # noqa: E402 (must be after env setup)
_db_module.DB_PATH = _tmp_db.name

import main as _main_module  # noqa: E402 (triggers init_db with temp DB)


# ---------------------------------------------------------------------------
# _build_triggers_list
# ---------------------------------------------------------------------------

class TestBuildTriggersList:
    """Unit tests for _build_triggers_list helper (no DB needed).

    Since PR #50 ("multiple triggers per worker"), multiple triggers are
    modeled as the `triggers_json` column (a JSON list of trigger objects);
    `config.trigger` carries only the single legacy trigger. `_build_triggers_list`
    prefers `triggers_json` and falls back to `config.trigger` for one label.
    These tests exercise the current model (one trigger object per label).
    """

    def _make_worker_single(self, trigger: dict, *, trigger_type: str | None = None) -> dict:
        """Legacy single-trigger worker: one trigger dict in config.trigger."""
        return {
            "id": "test-worker",
            "name": "Test Worker",
            "trigger_type": trigger_type or trigger.get("type", "manual"),
            "config": {"trigger": trigger},
        }

    def _make_worker_multi(self, triggers: list[dict]) -> dict:
        """Multi-trigger worker: triggers_json column (current model)."""
        import json as _json
        return {
            "id": "test-worker",
            "name": "Test Worker",
            "trigger_type": triggers[0].get("type", "manual") if triggers else "manual",
            "triggers_json": _json.dumps(triggers),
            "config": {"trigger": triggers[0] if triggers else {"type": "manual"}},
        }

    def test_manual_trigger(self):
        from main import _build_triggers_list
        w = self._make_worker_single({"type": "manual"})
        labels = _build_triggers_list(w)
        assert "Manual" in labels

    def test_manual_only_one_label(self):
        from main import _build_triggers_list
        w = self._make_worker_single({"type": "manual"})
        labels = _build_triggers_list(w)
        # manual-only worker: exactly one label
        assert len(labels) == 1
        assert labels[0] == "Manual"

    def test_cron_trigger_included(self):
        from main import _build_triggers_list
        w = self._make_worker_single({"type": "schedule", "cron": "0 9 * * 1-5"})
        labels = _build_triggers_list(w)
        assert any("Cron" in l for l in labels), f"no cron label in {labels}"
        assert any("0 9 * * 1-5" in l for l in labels)

    def test_webhook_trigger_included(self):
        from main import _build_triggers_list
        w = self._make_worker_single(
            {"type": "webhook", "webhook": {"secret": True, "allowed_methods": ["POST"]}}
        )
        labels = _build_triggers_list(w)
        assert any("Webhook" in l for l in labels), f"no webhook label in {labels}"

    def test_composio_trigger_included(self):
        from main import _build_triggers_list
        w = self._make_worker_single({
            "type": "composio",
            "composio": {
                "event": "new_email",
                "connection_id": "gmail_conn_abc",
                "filters": {},
            },
        })
        labels = _build_triggers_list(w)
        assert any("On" in l for l in labels), f"no On-<app> label in {labels}"
        assert any("new_email" in l for l in labels), f"event name not in labels: {labels}"

    def test_all_four_triggers_together(self):
        """A worker with manual + cron + webhook + composio reports all four.

        Multiple triggers are carried in triggers_json (current model).
        """
        from main import _build_triggers_list
        w = self._make_worker_multi([
            {"type": "manual"},
            {"type": "schedule", "cron": "0 8 * * *"},
            {"type": "webhook", "webhook": {"secret": True, "allowed_methods": ["POST"]}},
            {
                "type": "composio",
                "composio": {
                    "event": "new_message",
                    "connection_id": "slack_conn_xyz",
                    "filters": {},
                },
            },
        ])
        labels = _build_triggers_list(w)
        assert len(labels) == 4, f"expected 4 labels, got {len(labels)}: {labels}"
        assert "Manual" in labels
        assert any("Cron" in l for l in labels)
        assert any("Webhook" in l for l in labels)
        assert any("On" in l for l in labels)

    def test_no_runner_label_anywhere(self):
        """Runner (e2b) must never appear in trigger labels."""
        from main import _build_triggers_list
        w = self._make_worker_single({"type": "manual"})
        w["runner"] = "e2b"
        labels = _build_triggers_list(w)
        for label in labels:
            assert "e2b" not in label.lower(), f"runner leaked into trigger label: {label}"
            assert "runner" not in label.lower(), f"'runner' leaked into trigger label: {label}"

    def test_no_composio_brand_in_labels(self):
        """'Composio' must never appear verbatim in any trigger label (white-label rule)."""
        from main import _build_triggers_list
        w = self._make_worker_single({
            "type": "composio",
            "composio": {
                "event": "new_email",
                "connection_id": "gmail_abc",
            },
        })
        labels = _build_triggers_list(w)
        for label in labels:
            assert "composio" not in label.lower(), f"'Composio' in label: {label}"


# ---------------------------------------------------------------------------
# RecentStats via _get_stats_batch (in-memory SQLite)
# ---------------------------------------------------------------------------

class TestGetStatsBatch:
    """Test _get_stats_batch against the real repo + DB.

    Since the stats path moved to repos.workers.stats_batch (owner-scoped via a
    runs->workers JOIN on owner_id), _get_stats_batch now takes keyword-only
    user_id + repos and the old "mock main.get_db with a bare runs table" setup
    no longer matches the implementation. These tests insert real worker + run
    rows into the module's temp DB and assert through the repo, including the
    owner-scoping invariant. Dates are relative to now so the 7-day window is
    deterministic.
    """

    def _owner(self) -> str:
        # Distinct owner per call to keep tests isolated within the shared temp DB.
        import uuid as _uuid
        return f"owner-{_uuid.uuid4().hex[:8]}"

    def _insert_worker(self, conn, worker_id: str, owner_id: str) -> None:
        conn.execute(
            "INSERT INTO skill_versions (id, name, version, manifest_json, created_at) "
            "VALUES (?, ?, '0.1.0', '{}', datetime('now'))",
            (f"sv_{worker_id}", worker_id),
        )
        conn.execute(
            "INSERT INTO workers (id, skill_version_id, name, trigger_type, created_at, owner_id) "
            "VALUES (?, ?, ?, 'manual', datetime('now'), ?)",
            (worker_id, f"sv_{worker_id}", worker_id, owner_id),
        )

    def _insert_run(self, conn, run_id: str, worker_id: str, status: str, *, days_ago: int = 1) -> None:
        conn.execute(
            "INSERT INTO runs (id, worker_id, status, trigger_source, runner, created_at) "
            "VALUES (?, ?, ?, 'manual', 'local', datetime('now', ?))",
            (run_id, worker_id, status, f"-{days_ago} days"),
        )

    def test_5_runs_7d_count_and_success_rate(self):
        """5 runs in last 7d: 4 completed + 1 failed = 80% success."""
        from main import _get_stats_batch, get_db, get_repositories
        owner = self._owner()
        with get_db() as conn:
            self._insert_worker(conn, "worker-a", owner)
            for i in range(4):
                self._insert_run(conn, f"run-ok-{i}", "worker-a", "completed", days_ago=1)
            self._insert_run(conn, "run-fail-0", "worker-a", "failed", days_ago=1)
            # Old run outside the 7d window -- not counted in runs_7d.
            self._insert_run(conn, "run-old", "worker-a", "completed", days_ago=10)

        result = _get_stats_batch(["worker-a"], user_id=owner, repos=get_repositories())

        assert "worker-a" in result
        stats = result["worker-a"]
        assert stats.runs_7d == 5, f"Expected 5 runs, got {stats.runs_7d}"
        assert stats.success_rate_7d is not None
        assert abs(stats.success_rate_7d - 0.8) < 0.01, f"Expected 80%, got {stats.success_rate_7d}"
        assert stats.last_run_at is not None

    def test_no_runs_returns_empty_dict(self):
        """Worker with no runs should not appear in the result dict."""
        from main import _get_stats_batch, get_db, get_repositories
        owner = self._owner()
        with get_db() as conn:
            self._insert_worker(conn, "worker-no-runs", owner)

        result = _get_stats_batch(["worker-no-runs"], user_id=owner, repos=get_repositories())
        assert "worker-no-runs" not in result

    def test_owner_scoping(self):
        """A caller must not see another owner's worker stats."""
        from main import _get_stats_batch, get_db, get_repositories
        owner = self._owner()
        other = self._owner()
        with get_db() as conn:
            self._insert_worker(conn, "scoped-worker", owner)
            self._insert_run(conn, "sw-0", "scoped-worker", "completed", days_ago=1)

        assert "scoped-worker" in _get_stats_batch(
            ["scoped-worker"], user_id=owner, repos=get_repositories()
        )
        assert "scoped-worker" not in _get_stats_batch(
            ["scoped-worker"], user_id=other, repos=get_repositories()
        )

    def test_multiple_workers_isolated(self):
        """Stats for worker-a and worker-b are independent."""
        from main import _get_stats_batch, get_db, get_repositories
        owner = self._owner()
        with get_db() as conn:
            self._insert_worker(conn, "mw-a", owner)
            self._insert_worker(conn, "mw-b", owner)
            for i in range(3):
                self._insert_run(conn, f"a-{i}", "mw-a", "completed", days_ago=1)
            self._insert_run(conn, "b-0", "mw-b", "completed", days_ago=1)
            self._insert_run(conn, "b-1", "mw-b", "failed", days_ago=1)

        result = _get_stats_batch(["mw-a", "mw-b"], user_id=owner, repos=get_repositories())
        assert result["mw-a"].runs_7d == 3
        assert result["mw-a"].success_rate_7d == 1.0
        assert result["mw-b"].runs_7d == 2
        assert abs(result["mw-b"].success_rate_7d - 0.5) < 0.01

    def test_all_completed_is_100_percent(self):
        """All completed runs = 100% success rate."""
        from main import _get_stats_batch, get_db, get_repositories
        owner = self._owner()
        with get_db() as conn:
            self._insert_worker(conn, "worker-x", owner)
            for i in range(3):
                self._insert_run(conn, f"run-{i}", "worker-x", "completed", days_ago=1)

        result = _get_stats_batch(["worker-x"], user_id=owner, repos=get_repositories())
        assert result["worker-x"].success_rate_7d == 1.0

    def test_empty_worker_ids_returns_empty(self):
        """Empty input list returns empty dict without DB call."""
        from main import _get_stats_batch, get_repositories
        result = _get_stats_batch([], user_id="anyone", repos=get_repositories())
        assert result == {}


# ---------------------------------------------------------------------------
# Worker card connection slugs
# ---------------------------------------------------------------------------

class TestWorkerCardConnectionSlugs:
    """Unit tests for card connection projection used by /workers."""

    def test_accepts_legacy_string_connection(self):
        from main import _connection_slug_for_worker_card
        assert _connection_slug_for_worker_card("gmail") == "gmail"

    def test_accepts_typed_app_connection(self):
        from main import _connection_slug_for_worker_card
        assert _connection_slug_for_worker_card({"app": "google_search_console"}) == "google_search_console"

    def test_accepts_mcp_connection_label(self):
        from main import _connection_slug_for_worker_card
        assert _connection_slug_for_worker_card({"mcp": {"label": "github"}}) == "github"

    def test_ignores_null_and_empty_connection_shapes(self):
        from main import _connection_slug_for_worker_card
        assert _connection_slug_for_worker_card(None) is None
        assert _connection_slug_for_worker_card({"mcp": None}) is None
        assert _connection_slug_for_worker_card({}) is None


# ---------------------------------------------------------------------------
# WorkerSummary model field presence
# ---------------------------------------------------------------------------

class TestWorkerSummaryModel:
    """Verify WorkerSummary pydantic model has the new fields."""

    def test_has_triggers_field(self):
        from models import WorkerSummary, WorkerStatus
        w = WorkerSummary(
            id="w1",
            name="Test",
            status=WorkerStatus.HEALTHY,
            trigger_type="manual",
            runner="e2b",
            triggers=["Manual", "Cron · 0 9 * * *"],
        )
        assert w.triggers == ["Manual", "Cron · 0 9 * * *"]

    def test_triggers_defaults_to_empty_list(self):
        from models import WorkerSummary, WorkerStatus
        w = WorkerSummary(
            id="w1",
            name="Test",
            status=WorkerStatus.HEALTHY,
            trigger_type="manual",
            runner="e2b",
        )
        assert w.triggers == []

    def test_recent_stats_field_accepts_none(self):
        from models import WorkerSummary, WorkerStatus
        w = WorkerSummary(
            id="w1",
            name="Test",
            status=WorkerStatus.HEALTHY,
            trigger_type="manual",
            runner="e2b",
            recent_stats=None,
        )
        assert w.recent_stats is None

    def test_recent_stats_field_accepts_value(self):
        from models import WorkerSummary, WorkerStatus, RecentStats
        stats = RecentStats(last_run_at="2026-05-25T10:00:00", runs_7d=5, success_rate_7d=0.8)
        w = WorkerSummary(
            id="w1",
            name="Test",
            status=WorkerStatus.HEALTHY,
            trigger_type="manual",
            runner="e2b",
            recent_stats=stats,
        )
        assert w.recent_stats is not None
        assert w.recent_stats.runs_7d == 5
        assert abs(w.recent_stats.success_rate_7d - 0.8) < 0.01
