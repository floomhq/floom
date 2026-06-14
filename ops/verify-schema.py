#!/usr/bin/env python3
"""
ops/verify-schema.py — schema drift detector for workeros.

Compares every expected table defined in apps/api/db/_legacy_sqlite.py
against the live SQLite database. Fails with a non-zero exit code and a
clear diff if any expected table is missing.

Usage:
    python3 ops/verify-schema.py [db_path]

    db_path defaults to /root/workeros/data/floom.db (or $FLOOM_DB).

Exit codes:
    0  All expected tables present.
    1  One or more tables missing (drift detected).
    2  Usage / configuration error.
"""

from __future__ import annotations

import os
import re
import sqlite3
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Tables that are intentionally absent from a healthy DB
# ---------------------------------------------------------------------------
# These were created and then explicitly dropped via migrations, OR are
# transient scratch tables used only during a single migration run.
INTENTIONALLY_ABSENT: frozenset[str] = frozenset(
    {
        # Migration 15 dropped approvals + worker_state; migration 37 recreated
        # approvals, so worker_state is the only one expected-gone forever.
        "worker_state",
        # Transient scratch tables used inside a single migration (renamed to
        # canonical name before commit, never persisted in the DB).
        "runs_new",
        "approvals_new",
        "composio_connections_new",
        "secrets_new",
        "worker_alerts_new",
        "worker_webhook_secrets_new",
        # workers_legacy is actually present in the DB as a migration artefact;
        # we skip it here because its presence is acceptable but optional.
        "workers_legacy",
        # Approval preserve table is a temporary table (TEMP) inside one migration.
        "approvals_preserve",
    }
)

# ---------------------------------------------------------------------------
# Extract expected table names from _legacy_sqlite.py
# ---------------------------------------------------------------------------

def _extract_expected_tables(legacy_py: Path) -> set[str]:
    """
    Parse _legacy_sqlite.py for every ``CREATE TABLE (IF NOT EXISTS)? <name>``
    statement that appears in migration SQL strings or executescript calls.
    This catches tables defined in string migrations (most) and in helper
    functions (_migrate_* functions that create tables inline).
    """
    source = legacy_py.read_text(encoding="utf-8")

    # Match: CREATE TABLE [IF NOT EXISTS] table_name
    # Intentionally case-insensitive to handle any capitalisation variance.
    #
    # We use a multi-line approach: strip Python comments (lines starting with
    # optional whitespace + #) before running the regex to avoid matching
    # English prose like "Recreate table without".
    pattern = re.compile(
        r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)",
        re.IGNORECASE,
    )
    # Strip Python line comments so the regex doesn't match prose in comments.
    source_no_comments = re.sub(r"#[^\n]*", "", source)

    # SQL keywords that can never be valid table names (guard against edge cases)
    SQL_KEYWORDS = frozenset(
        {"without", "select", "insert", "update", "delete", "from", "where",
         "table", "index", "view", "trigger", "temp", "temporary", "virtual"}
    )

    tables: set[str] = set()
    for match in pattern.finditer(source_no_comments):
        name = match.group(1).lower()
        if name not in SQL_KEYWORDS:
            tables.add(name)

    return tables


# ---------------------------------------------------------------------------
# Get live tables from the SQLite DB
# ---------------------------------------------------------------------------

def _live_tables(db_path: str) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    return {row[0].lower() for row in rows}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    # Resolve DB path
    if len(sys.argv) >= 2:
        db_path = sys.argv[1]
    else:
        db_path = os.environ.get("FLOOM_DB") or os.environ.get("WORKEROS_DB")
        if not db_path:
            # Try the standard relative path from /root/workeros/apps/api working dir
            candidates = [
                "/root/workeros/data/floom.db",
                Path(__file__).parent.parent / "data" / "floom.db",
            ]
            for c in candidates:
                if Path(c).exists():
                    db_path = str(c)
                    break
        if not db_path:
            print("[verify-schema] ERROR: Cannot find floom.db. Pass path as argument or set FLOOM_DB.", file=sys.stderr)
            return 2

    db_path = str(Path(db_path).resolve())
    if not Path(db_path).exists():
        print(f"[verify-schema] ERROR: DB not found: {db_path}", file=sys.stderr)
        return 2

    # Resolve _legacy_sqlite.py
    script_dir = Path(__file__).parent
    repo_root = script_dir.parent
    legacy_py = repo_root / "apps" / "api" / "db" / "_legacy_sqlite.py"
    if not legacy_py.exists():
        print(f"[verify-schema] ERROR: Migration source not found: {legacy_py}", file=sys.stderr)
        return 2

    # Extract expected tables
    expected = _extract_expected_tables(legacy_py)
    expected -= INTENTIONALLY_ABSENT

    # Get live tables
    live = _live_tables(db_path)

    # Diff
    missing = sorted(expected - live)
    extra   = sorted(live - expected - INTENTIONALLY_ABSENT)

    if not missing:
        print(f"[verify-schema] OK — all {len(expected)} expected tables present in {db_path}")
        if extra:
            # Extra tables are not an error (could be legacy migration artefacts)
            print(f"[verify-schema] NOTE: {len(extra)} extra table(s) in DB (not in migration source): {', '.join(extra)}")
        return 0

    print(f"[verify-schema] DRIFT DETECTED in {db_path}")
    print(f"[verify-schema] Expected {len(expected)} tables, found {len(live)} live.")
    print()
    print(f"  MISSING ({len(missing)}):")
    for t in missing:
        print(f"    - {t}")
    print()
    if extra:
        print("  EXTRA in DB (informational, not a failure):")
        for t in extra:
            print(f"    + {t}")
        print()
    print("[verify-schema] This means a migration was skipped or the version counter advanced ahead of the schema.")
    print("[verify-schema] Run the API once with an empty/test DB to re-apply all migrations, OR restore the pre-deploy backup.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
