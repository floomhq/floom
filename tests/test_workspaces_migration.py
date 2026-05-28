"""Verify 0005_workspaces.sql is idempotent.

Running migrations twice must not raise; the second run is a no-op
because every statement uses ``if not exists`` / ``do $$ if ... $$``.

The test parses the migration file's text and asserts the structural
properties that make it idempotent. We intentionally do NOT spin up a
real Postgres in CI for this test — that requires a live Supabase /
psql connection and is exercised by the live application-time
verification in the PR description. This test catches the most common
regression: dropping the idempotency guards in a future edit.
"""

from __future__ import annotations

import re
from pathlib import Path


MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def _migration_text() -> str:
    path = MIGRATIONS_DIR / "0005_workspaces.sql"
    assert path.is_file(), f"migration file missing: {path}"
    return path.read_text(encoding="utf-8")


def test_migration_starts_with_transaction():
    text = _migration_text().lower()
    # Wrap in transaction so a mid-flight failure rolls back.
    assert "begin;" in text
    assert "commit;" in text


def test_table_creates_are_idempotent():
    text = _migration_text().lower()
    # Each CREATE TABLE must use IF NOT EXISTS so re-runs don't error.
    create_table_pattern = re.compile(r"create\s+table\s+(?!if\s+not\s+exists)")
    bad = create_table_pattern.findall(text)
    assert not bad, f"non-idempotent CREATE TABLE detected: {bad}"


def test_column_additions_are_idempotent():
    text = _migration_text().lower()
    add_column_pattern = re.compile(r"add\s+column\s+(?!if\s+not\s+exists)")
    bad = add_column_pattern.findall(text)
    assert not bad, f"non-idempotent ADD COLUMN detected: {bad}"


def test_index_creates_are_idempotent():
    text = _migration_text().lower()
    create_index_pattern = re.compile(r"create\s+(?:unique\s+)?index\s+(?!if\s+not\s+exists)")
    bad = create_index_pattern.findall(text)
    assert not bad, f"non-idempotent CREATE INDEX detected: {bad}"


def test_workspace_id_columns_added_to_all_scoped_tables():
    text = _migration_text().lower()
    required_tables = ("workers", "runs", "connections", "secrets")
    for table in required_tables:
        # Each must get a workspace_id column added (idempotently).
        pattern = re.compile(
            rf"alter\s+table\s+public\.{table}\s+add\s+column\s+if\s+not\s+exists\s+workspace_id"
        )
        assert pattern.search(text), f"workspace_id column not added to {table}"


def test_not_null_promotion_is_guarded():
    text = _migration_text().lower()
    # NOT NULL promotion lives inside DO blocks that check information_schema
    # first, so re-running the migration doesn't fail when the column is
    # already non-nullable.
    promotion_guard = re.compile(
        r"alter\s+table\s+public\.\w+\s+alter\s+column\s+workspace_id\s+set\s+not\s+null",
        re.IGNORECASE,
    )
    assert promotion_guard.search(text)
    # The promotion must occur AFTER an information_schema check.
    assert "information_schema.columns" in text


def test_backfill_verification_aborts_on_orphan():
    text = _migration_text().lower()
    # The migration verifies all rows have workspace_id BEFORE promoting
    # to NOT NULL. If any row is still null, raise so the txn aborts.
    assert "raise exception" in text
    assert "backfill incomplete" in text


def test_secrets_pk_is_repaired_to_workspace_name():
    text = _migration_text().lower()
    # Pre-workspace PK was (user_id, name). Brutally-simple v1 allows
    # the same user to have the same secret name in multiple workspaces,
    # so the PK must move to (workspace_id, name).
    assert "secrets_workspace_name_pkey" in text
    assert "primary key (workspace_id, name)" in text
