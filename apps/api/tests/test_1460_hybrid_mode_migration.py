from __future__ import annotations

import sqlite3
import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_hybrid_mode_migration_updates_skill_versions_without_workers_manifest_column():
    import main

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE workers (id TEXT PRIMARY KEY)")
    conn.execute("CREATE TABLE skill_versions (id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL)")
    conn.execute(
        "INSERT INTO skill_versions (id, manifest_json) VALUES (?, ?)",
        ("sv_1", '{"exec": {"mode": "hybrid"}}'),
    )
    conn.execute(
        "INSERT INTO skill_versions (id, manifest_json) VALUES (?, ?)",
        ("sv_2", '{"exec": {"mode": "pure-script"}}'),
    )

    assert main._migrate_hybrid_worker_modes(conn) == 1

    rows = {
        row["id"]: row["manifest_json"]
        for row in conn.execute("SELECT id, manifest_json FROM skill_versions ORDER BY id")
    }
    assert rows["sv_1"] == '{"exec": {"mode": "pure-script"}}'
    assert rows["sv_2"] == '{"exec": {"mode": "pure-script"}}'
