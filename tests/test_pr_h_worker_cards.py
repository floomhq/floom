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
    """Unit tests for _build_triggers_list helper (no DB needed)."""

    def _make_worker(self, trigger_type: str, trigger_extra: dict | None = None) -> dict:
        return {
            "id": "test-worker",
            "name": "Test Worker",
            "trigger_type": trigger_type,
            "config": {
                "trigger": {
                    "type": trigger_type,
                    **(trigger_extra or {}),
                }
            },
        }

    def test_manual_trigger(self):
        from main import _build_triggers_list
        w = self._make_worker("manual")
        labels = _build_triggers_list(w)
        assert "Manual" in labels

    def test_manual_only_one_label(self):
        from main import _build_triggers_list
        w = self._make_worker("manual")
        labels = _build_triggers_list(w)
        # manual-only worker: exactly one label
        assert len(labels) == 1
        assert labels[0] == "Manual"

    def test_cron_trigger_included(self):
        from main import _build_triggers_list
        w = self._make_worker("manual", {"cron": "0 9 * * 1-5"})
        labels = _build_triggers_list(w)
        assert any("Cron" in l for l in labels), f"no cron label in {labels}"
        assert any("0 9 * * 1-5" in l for l in labels)

    def test_webhook_trigger_included(self):
        from main import _build_triggers_list
        w = self._make_worker("manual", {"webhook": {"secret": True, "allowed_methods": ["POST"]}})
        labels = _build_triggers_list(w)
        assert any("Webhook" in l for l in labels), f"no webhook label in {labels}"

    def test_composio_trigger_included(self):
        from main import _build_triggers_list
        w = self._make_worker("manual", {
            "composio": {
                "event": "new_email",
                "connection_id": "gmail_conn_abc",
                "filters": {},
            }
        })
        labels = _build_triggers_list(w)
        assert any("On" in l for l in labels), f"no On-<app> label in {labels}"
        assert any("new_email" in l for l in labels), f"event name not in labels: {labels}"

    def test_all_four_triggers_together(self):
        """A worker with manual + cron + webhook + composio reports all four."""
        from main import _build_triggers_list
        w = self._make_worker("manual", {
            "cron": "0 8 * * *",
            "webhook": {"secret": True, "allowed_methods": ["POST"]},
            "composio": {
                "event": "new_message",
                "connection_id": "slack_conn_xyz",
                "filters": {},
            },
        })
        labels = _build_triggers_list(w)
        assert len(labels) == 4, f"expected 4 labels, got {len(labels)}: {labels}"
        assert "Manual" in labels
        assert any("Cron" in l for l in labels)
        assert any("Webhook" in l for l in labels)
        assert any("On" in l for l in labels)

    def test_no_runner_label_anywhere(self):
        """Runner (e2b) must never appear in trigger labels."""
        from main import _build_triggers_list
        w = self._make_worker("manual")
        w["runner"] = "e2b"
        labels = _build_triggers_list(w)
        for label in labels:
            assert "e2b" not in label.lower(), f"runner leaked into trigger label: {label}"
            assert "runner" not in label.lower(), f"'runner' leaked into trigger label: {label}"

    def test_no_composio_brand_in_labels(self):
        """'Composio' must never appear verbatim in any trigger label (white-label rule)."""
        from main import _build_triggers_list
        w = self._make_worker("manual", {
            "composio": {
                "event": "new_email",
                "connection_id": "gmail_abc",
            }
        })
        labels = _build_triggers_list(w)
        for label in labels:
            assert "composio" not in label.lower(), f"'Composio' in label: {label}"


# ---------------------------------------------------------------------------
# RecentStats via _get_stats_batch (in-memory SQLite)
# ---------------------------------------------------------------------------

class TestGetStatsBatch:
    """Test _get_stats_batch with a real in-memory SQLite DB."""

    def _setup_db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE runs (
                id TEXT PRIMARY KEY,
                worker_id TEXT NOT NULL,
                status TEXT NOT NULL,
                trigger_source TEXT NOT NULL DEFAULT 'manual',
                runner TEXT NOT NULL DEFAULT 'e2b',
                created_at TEXT NOT NULL
            )
        """)
        conn.commit()
        return conn

    def _insert_run(self, conn, run_id, worker_id, status, created_at):
        conn.execute(
            "INSERT INTO runs (id, worker_id, status, created_at) VALUES (?, ?, ?, ?)",
            (run_id, worker_id, status, created_at),
        )
        conn.commit()

    def _make_db_context(self, conn):
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=conn)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        return mock_ctx

    def test_5_runs_7d_count_and_success_rate(self):
        """5 runs in last 7d: 4 completed + 1 failed = 80% success."""
        from main import _get_stats_batch
        conn = self._setup_db()

        # 5 recent runs
        for i in range(4):
            self._insert_run(conn, f"run-ok-{i}", "worker-a", "completed", "2026-05-25T10:00:00")
        self._insert_run(conn, "run-fail-0", "worker-a", "failed", "2026-05-25T11:00:00")

        # 1 old run (outside 7d window) -- won't be counted
        self._insert_run(conn, "run-old", "worker-a", "completed", "2026-05-01T10:00:00")

        with patch("main.get_db", return_value=self._make_db_context(conn)):
            result = _get_stats_batch(["worker-a"])

        assert "worker-a" in result
        stats = result["worker-a"]
        assert stats.runs_7d == 5, f"Expected 5 runs, got {stats.runs_7d}"
        assert stats.success_rate_7d is not None
        assert abs(stats.success_rate_7d - 0.8) < 0.01, f"Expected 80%, got {stats.success_rate_7d}"
        assert stats.last_run_at is not None

    def test_no_runs_returns_empty_dict(self):
        """Worker with no runs should not appear in the result dict."""
        from main import _get_stats_batch
        conn = self._setup_db()

        with patch("main.get_db", return_value=self._make_db_context(conn)):
            result = _get_stats_batch(["worker-no-runs"])

        assert "worker-no-runs" not in result

    def test_multiple_workers_isolated(self):
        """Stats for worker-a and worker-b are independent."""
        from main import _get_stats_batch
        conn = self._setup_db()

        # worker-a: 3 completed
        for i in range(3):
            self._insert_run(conn, f"a-{i}", "worker-a", "completed", "2026-05-25T10:00:00")

        # worker-b: 2 runs, 1 failed
        self._insert_run(conn, "b-0", "worker-b", "completed", "2026-05-25T10:00:00")
        self._insert_run(conn, "b-1", "worker-b", "failed", "2026-05-25T11:00:00")

        with patch("main.get_db", return_value=self._make_db_context(conn)):
            result = _get_stats_batch(["worker-a", "worker-b"])

        assert result["worker-a"].runs_7d == 3
        assert result["worker-a"].success_rate_7d == 1.0
        assert result["worker-b"].runs_7d == 2
        assert abs(result["worker-b"].success_rate_7d - 0.5) < 0.01

    def test_all_completed_is_100_percent(self):
        """All completed runs = 100% success rate."""
        from main import _get_stats_batch
        conn = self._setup_db()
        for i in range(3):
            self._insert_run(conn, f"run-{i}", "worker-x", "completed", "2026-05-25T10:00:00")

        with patch("main.get_db", return_value=self._make_db_context(conn)):
            result = _get_stats_batch(["worker-x"])

        assert result["worker-x"].success_rate_7d == 1.0

    def test_empty_worker_ids_returns_empty(self):
        """Empty input list returns empty dict without DB call."""
        from main import _get_stats_batch
        result = _get_stats_batch([])
        assert result == {}


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
