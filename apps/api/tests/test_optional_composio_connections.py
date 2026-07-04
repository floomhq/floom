"""Tests for optional Composio connections.

Covers:
  (a) A worker declaring two Composio connections both optional:true, with only
      ONE connected, resolves without error and connection_ids contains only the
      connected one.
  (b) A REQUIRED (default) unconnected connection still fails with missing_connection.
  (c) declared_composio_connections still includes optional apps (proxy allowlist
      must see all declared apps regardless of the optional flag).
  (d) The `optional` field on WorkerComposioConnection defaults to False.
  (e) The shorthand (app: / optional: true) wires through to WorkerComposioConnection.
"""
from __future__ import annotations

import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch  # noqa: F401 (kept for reference)

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import (
    WorkerComposioConnection,
    WorkerConfig,
    WorkerConnection,
    WorkerRuntime,
    WorkerTrigger,
    declared_composio_connections,
    optional_composio_connections,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_config(*connections) -> WorkerConfig:
    return WorkerConfig(
        id="test-worker",
        name="Test Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b", mode="pure-script"),
        inputs=[],
        outputs=[],
        connections=list(connections),
    )


def _make_db(rows: list[tuple[str, str, str]]) -> sqlite3.Connection:
    """Create an in-memory SQLite DB with a composio_connections table.

    rows: list of (app_name, composio_connection_id, status)
    """
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "CREATE TABLE composio_connections ("
        "  id TEXT,"
        "  app_name TEXT,"
        "  user_id TEXT,"
        "  composio_connection_id TEXT,"
        "  status TEXT,"
        "  updated_at TEXT"
        ")"
    )
    for app_name, conn_id, status in rows:
        conn.execute(
            "INSERT INTO composio_connections (id, app_name, user_id, composio_connection_id, status, updated_at)"
            " VALUES (?, ?, ?, ?, ?, datetime('now'))",
            (conn_id, app_name, "user-a", conn_id, status),
        )
    conn.commit()
    return conn


@contextmanager
def _stub_get_db(sqlite_conn):
    """Context-manager that patches `get_db` as imported inside runner_utils.

    runner_utils does `from db import get_db` inside the function body, so we
    must patch it at the `db` module level, which is what `from db import X`
    resolves against at call time.
    """
    import importlib
    import db as db_module

    @contextmanager
    def fake_get_db():
        yield sqlite_conn

    original = db_module.get_db
    db_module.get_db = fake_get_db
    try:
        yield
    finally:
        db_module.get_db = original


def _resolve(config: WorkerConfig, sqlite_conn, user_id: str = "user-a"):
    import runner_utils
    with _stub_get_db(sqlite_conn):
        logs = []
        connection_ids, error = runner_utils._resolve_connections(
            worker_id="test-worker",
            log_fn=lambda msg, level="info", **_: logs.append((msg, level)),
            config=config,
            user_id=user_id,
        )
    return connection_ids, error, logs


# ---------------------------------------------------------------------------
# (d) Default value
# ---------------------------------------------------------------------------

class TestWorkerComposioConnectionDefaults:
    def test_optional_defaults_to_false(self):
        c = WorkerComposioConnection(app="gmail")
        assert c.optional is False

    def test_optional_can_be_set_true(self):
        c = WorkerComposioConnection(app="gmail", optional=True)
        assert c.optional is True


# ---------------------------------------------------------------------------
# (e) Shorthand wires optional through
# ---------------------------------------------------------------------------

class TestWorkerConnectionShorthand:
    def test_shorthand_optional_true_wires_to_composio(self):
        wc = WorkerConnection(app="gmail", optional=True)
        assert wc.composio is not None
        assert wc.composio.optional is True

    def test_shorthand_optional_false_by_default(self):
        wc = WorkerConnection(app="slack")
        assert wc.composio is not None
        assert wc.composio.optional is False

    def test_shorthand_optional_false_explicit(self):
        wc = WorkerConnection(app="slack", optional=False)
        assert wc.composio is not None
        assert wc.composio.optional is False


# ---------------------------------------------------------------------------
# (c) declared_composio_connections always includes optional apps
# ---------------------------------------------------------------------------

class TestDeclaredComposioConnections:
    def test_includes_optional_apps(self):
        config = _make_config(
            WorkerConnection(app="gmail", optional=True),
            WorkerConnection(app="outlook", optional=True),
        )
        declared = declared_composio_connections(config)
        assert "gmail" in declared
        assert "outlook" in declared

    def test_optional_flag_does_not_affect_declared_allowlists(self):
        config = _make_config(
            WorkerConnection(
                composio=WorkerComposioConnection(
                    app="gmail",
                    allowed_tools=["GMAIL_FETCH_EMAILS"],
                    optional=True,
                )
            ),
        )
        declared = declared_composio_connections(config)
        assert declared.get("gmail") == ["GMAIL_FETCH_EMAILS"]

    def test_optional_composio_connections_returns_optional_slugs(self):
        config = _make_config(
            WorkerConnection(app="gmail", optional=True),
            WorkerConnection(app="slack"),
        )
        optional = optional_composio_connections(config)
        assert optional == {"gmail"}

    def test_optional_composio_connections_empty_when_none_optional(self):
        config = _make_config(WorkerConnection(app="slack"))
        assert optional_composio_connections(config) == set()

    def test_optional_composio_connections_empty_config(self):
        assert optional_composio_connections(None) == set()


# ---------------------------------------------------------------------------
# (a) Both optional, only one connected -- resolves without error
# ---------------------------------------------------------------------------

class TestResolveConnectionsOptional:
    def test_both_optional_one_connected_resolves_ok(self):
        config = _make_config(
            WorkerConnection(app="gmail", optional=True),
            WorkerConnection(app="outlook", optional=True),
        )
        # Only gmail is connected.
        db = _make_db([("gmail", "ca_gmail_1", "active")])
        connection_ids, error, logs = _resolve(config, db)

        assert error is None
        assert connection_ids == {"gmail": "ca_gmail_1"}
        # outlook should produce an info-level skip log, not an error
        skip_logs = [m for m, lvl in logs if "optional" in m.lower() and lvl == "info"]
        assert skip_logs, "expected an info log for the skipped optional connection"

    def test_both_optional_none_connected_resolves_ok(self):
        config = _make_config(
            WorkerConnection(app="gmail", optional=True),
            WorkerConnection(app="outlook", optional=True),
        )
        db = _make_db([])  # nothing connected
        connection_ids, error, logs = _resolve(config, db)

        assert error is None
        assert connection_ids == {}

    def test_both_optional_both_connected_resolves_all(self):
        config = _make_config(
            WorkerConnection(app="gmail", optional=True),
            WorkerConnection(app="outlook", optional=True),
        )
        db = _make_db([
            ("gmail", "ca_gmail_1", "active"),
            ("outlook", "ca_outlook_1", "active"),
        ])
        connection_ids, error, logs = _resolve(config, db)

        assert error is None
        assert connection_ids == {"gmail": "ca_gmail_1", "outlook": "ca_outlook_1"}


# ---------------------------------------------------------------------------
# (b) Required (default) unconnected connection still fails
# ---------------------------------------------------------------------------

class TestResolveConnectionsRequired:
    def test_required_missing_returns_error(self):
        config = _make_config(WorkerConnection(app="github"))
        db = _make_db([])
        connection_ids, error, logs = _resolve(config, db)

        assert error is not None
        assert "missing_connection" in error
        assert "github" in error
        assert connection_ids == {}

    def test_required_connected_resolves_ok(self):
        config = _make_config(WorkerConnection(app="github"))
        db = _make_db([("github", "ca_gh_1", "active")])
        connection_ids, error, logs = _resolve(config, db)

        assert error is None
        assert connection_ids == {"github": "ca_gh_1"}

    def test_mixed_required_missing_fails(self):
        """Required missing + optional connected: should fail for the required one."""
        config = _make_config(
            WorkerConnection(app="github"),           # required, NOT connected
            WorkerConnection(app="gmail", optional=True),  # optional, connected
        )
        db = _make_db([("gmail", "ca_gmail_1", "active")])
        connection_ids, error, logs = _resolve(config, db)

        assert error is not None
        assert "github" in error
        assert "gmail" not in (error or "")

    def test_mixed_all_present_resolves_ok(self):
        """Required connected + optional connected: no error, both in result."""
        config = _make_config(
            WorkerConnection(app="github"),
            WorkerConnection(app="gmail", optional=True),
        )
        db = _make_db([
            ("github", "ca_gh_1", "active"),
            ("gmail", "ca_gmail_1", "active"),
        ])
        connection_ids, error, logs = _resolve(config, db)

        assert error is None
        assert connection_ids == {"github": "ca_gh_1", "gmail": "ca_gmail_1"}
