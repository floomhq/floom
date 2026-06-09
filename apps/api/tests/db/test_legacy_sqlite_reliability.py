from __future__ import annotations

import importlib
import sqlite3
import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[2]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_legacy_sqlite(monkeypatch: pytest.MonkeyPatch, db_path: Path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(db_path.with_suffix(".env")))
    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("db._legacy_sqlite")


def test_apply_migrations_rolls_back_partial_sql_script(monkeypatch, tmp_path):
    db = _load_legacy_sqlite(monkeypatch, tmp_path / "rollback.db")
    db._close_cached_db_connection()
    monkeypatch.setattr(
        db,
        "MIGRATIONS",
        [
            """
            CREATE TABLE schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            CREATE TABLE demo_table (id INTEGER PRIMARY KEY);
            INSERT INTO demo_table (id) VALUES (1);
            SELECT * FROM missing_table;
            """,
        ],
    )

    with pytest.raises(sqlite3.OperationalError):
        db.apply_migrations()

    with db.get_db() as conn:
        tables = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        }

    assert "schema_version" not in tables
    assert "demo_table" not in tables
    db._close_cached_db_connection()


def test_get_db_reuses_connection_until_db_path_changes(monkeypatch, tmp_path):
    first_path = tmp_path / "pool.db"
    second_path = tmp_path / "pool-two.db"
    db = _load_legacy_sqlite(monkeypatch, first_path)
    db._close_cached_db_connection()

    connect_calls: list[str] = []
    real_connect = db.sqlite3.connect

    def wrapped_connect(*args, **kwargs):
        connect_calls.append(args[0])
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(db.sqlite3, "connect", wrapped_connect)

    try:
        with db.get_db() as conn1:
            conn1.execute("CREATE TABLE IF NOT EXISTS pool_check (id INTEGER PRIMARY KEY)")
        with db.get_db() as conn2:
            conn2.execute("INSERT INTO pool_check (id) VALUES (1)")

        assert conn1 is conn2
        assert connect_calls == [str(first_path)]

        monkeypatch.setenv("WORKEROS_DB", str(second_path))
        monkeypatch.setenv("FLOOM_DB", str(second_path))
        with db.get_db() as conn3:
            conn3.execute("CREATE TABLE IF NOT EXISTS pool_check (id INTEGER PRIMARY KEY)")

        assert conn3 is not conn1
        assert connect_calls == [str(first_path), str(second_path)]
    finally:
        db._close_cached_db_connection()
