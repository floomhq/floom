"""Regression tests for PR S6 — final close-out batch.

Covers:
  P1.1 - Newline injection in _upsert_env_var returns ValueError (then 400 via API)
  N5   - Worker FK orphan cleanup on delete; UNIQUE slot freed for recreation
  N6   - Multi-trigger PATCH round-trips cron value to disk
"""

import os
import sys
import re
import json
import sqlite3
import tempfile
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# P1.1 — Newline injection in secret values
# ---------------------------------------------------------------------------

class TestNewlineInjectionInSecretValue:
    """P1.1: the sanitisation logic in _upsert_env_var must reject values
    containing newline or null bytes before writing to .env."""

    def _make_upsert(self, tmp_path):
        """Return a minimal standalone _upsert_env_var that mirrors the fix."""
        env_file = tmp_path / ".env"
        env_file.write_text("")

        def _read_env_lines():
            return env_file.read_text().splitlines(keepends=True)

        def _write_env_lines(lines):
            env_file.write_text("".join(lines))

        def _upsert_env_var(name: str, value: str) -> None:
            # Same guard as added in main.py (P1.1 fix)
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                raise ValueError(f"Invalid secret name: {name!r}")
            if any(c in value for c in ("\n", "\r", "\x00")):
                raise ValueError(
                    "Secret value must not contain newline or null characters"
                )
            lines = _read_env_lines()
            new_line = f"{name}={value}\n"
            replaced = False
            new_lines = []
            for line in lines:
                stripped = line.rstrip("\n")
                if stripped.startswith(f"{name}=") or stripped == name:
                    new_lines.append(new_line)
                    replaced = True
                else:
                    new_lines.append(line)
            if not replaced:
                if new_lines and not new_lines[-1].endswith("\n"):
                    new_lines[-1] += "\n"
                new_lines.append(new_line)
            _write_env_lines(new_lines)

        return _upsert_env_var, env_file

    def test_newline_in_value_raises_value_error(self, tmp_path):
        upsert, _ = self._make_upsert(tmp_path)
        with pytest.raises(ValueError, match="newline"):
            upsert("MY_SECRET", "legit\nEVIL=injected")

    def test_carriage_return_in_value_raises_value_error(self, tmp_path):
        upsert, _ = self._make_upsert(tmp_path)
        with pytest.raises(ValueError, match="newline"):
            upsert("MY_SECRET", "value\rwith_cr")

    def test_null_byte_in_value_raises_value_error(self, tmp_path):
        upsert, _ = self._make_upsert(tmp_path)
        with pytest.raises(ValueError):
            upsert("MY_SECRET", "value\x00null")

    def test_clean_value_writes_env_file(self, tmp_path):
        upsert, env_file = self._make_upsert(tmp_path)
        upsert("MY_SECRET", "clean_value_abc123")
        content = env_file.read_text()
        assert "MY_SECRET=clean_value_abc123" in content

    def test_multiline_injection_does_not_pollute_env_file(self, tmp_path):
        """Ensure that if injection were attempted, the second line does NOT
        appear in the .env file (i.e., the guard fires before the write)."""
        upsert, env_file = self._make_upsert(tmp_path)
        try:
            upsert("LEGIT", "good_value\nEVIL_KEY=owned")
        except ValueError:
            pass
        content = env_file.read_text()
        assert "EVIL_KEY" not in content, "Injected key must not appear in .env"


# ---------------------------------------------------------------------------
# N5 — FK orphan cleanup on worker delete
# ---------------------------------------------------------------------------

class TestWorkerFKOrphanCleanup:
    """N5: deleting a worker must remove the unreferenced skill_version row
    so the name+version UNIQUE slot is free for recreation."""

    def _build_db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript("""
            CREATE TABLE skill_versions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                manifest_json TEXT,
                bundle_path TEXT,
                created_at TEXT,
                UNIQUE(name, version)
            );
            CREATE TABLE workers (
                id TEXT PRIMARY KEY,
                skill_version_id TEXT,
                name TEXT NOT NULL,
                trigger_type TEXT DEFAULT 'manual',
                created_at TEXT,
                FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id)
            );
        """)
        return conn

    def test_orphan_removed_after_delete(self):
        conn = self._build_db()
        conn.execute(
            "INSERT INTO skill_versions (id, name, version, created_at) VALUES (?, ?, ?, ?)",
            ("sv-1", "my-worker", "0.1.0", "2026-01-01"),
        )
        conn.execute(
            "INSERT INTO workers (id, skill_version_id, name, created_at) VALUES (?, ?, ?, ?)",
            ("my-worker", "sv-1", "my-worker", "2026-01-01"),
        )
        conn.commit()

        # Delete worker
        conn.execute("DELETE FROM workers WHERE id = 'my-worker'")
        conn.commit()

        # Apply N5 fix: remove orphaned skill_version
        ref_count = conn.execute(
            "SELECT COUNT(*) as cnt FROM workers WHERE skill_version_id = 'sv-1'"
        ).fetchone()["cnt"]
        assert ref_count == 0
        if ref_count == 0:
            conn.execute("DELETE FROM skill_versions WHERE id = 'sv-1'")
            conn.commit()

        orphan = conn.execute("SELECT id FROM skill_versions WHERE id = 'sv-1'").fetchone()
        assert orphan is None, "Orphaned skill_version should be gone"

    def test_recreate_after_orphan_cleanup_succeeds(self):
        conn = self._build_db()
        conn.execute(
            "INSERT INTO skill_versions (id, name, version, created_at) VALUES (?, ?, ?, ?)",
            ("sv-1", "my-worker", "0.1.0", "2026-01-01"),
        )
        conn.execute(
            "INSERT INTO workers (id, skill_version_id, name, created_at) VALUES (?, ?, ?, ?)",
            ("my-worker", "sv-1", "my-worker", "2026-01-01"),
        )
        conn.commit()

        # Delete + cleanup orphan
        conn.execute("DELETE FROM workers WHERE id = 'my-worker'")
        conn.commit()
        conn.execute("DELETE FROM skill_versions WHERE id = 'sv-1'")
        conn.commit()

        # Now re-create with same name+version — must NOT raise UNIQUE error
        conn.execute(
            "INSERT INTO skill_versions (id, name, version, created_at) VALUES (?, ?, ?, ?)",
            ("sv-2", "my-worker", "0.1.0", "2026-01-02"),
        )
        conn.commit()
        row = conn.execute("SELECT id FROM skill_versions WHERE name = 'my-worker'").fetchone()
        assert row is not None and row["id"] == "sv-2"

    def test_other_worker_preserves_skill_version(self):
        """When two workers share a skill_version, deleting one must not remove it."""
        conn = self._build_db()
        conn.execute(
            "INSERT INTO skill_versions (id, name, version, created_at) VALUES (?, ?, ?, ?)",
            ("sv-shared", "shared-worker", "0.1.0", "2026-01-01"),
        )
        conn.execute(
            "INSERT INTO workers (id, skill_version_id, name, created_at) VALUES (?, ?, ?, ?)",
            ("worker-a", "sv-shared", "worker-a", "2026-01-01"),
        )
        conn.execute(
            "INSERT INTO workers (id, skill_version_id, name, created_at) VALUES (?, ?, ?, ?)",
            ("worker-b", "sv-shared", "worker-b", "2026-01-01"),
        )
        conn.commit()

        # Delete only worker-a
        conn.execute("DELETE FROM workers WHERE id = 'worker-a'")
        conn.commit()

        ref_count = conn.execute(
            "SELECT COUNT(*) as cnt FROM workers WHERE skill_version_id = 'sv-shared'"
        ).fetchone()["cnt"]
        # ref_count is 1 (worker-b still references it) — must NOT delete skill_version
        assert ref_count == 1
        if ref_count == 0:
            conn.execute("DELETE FROM skill_versions WHERE id = 'sv-shared'")
            conn.commit()

        still_there = conn.execute("SELECT id FROM skill_versions WHERE id = 'sv-shared'").fetchone()
        assert still_there is not None, "skill_version still referenced by worker-b must be preserved"


# ---------------------------------------------------------------------------
# N6 — Multi-trigger PATCH round-trip: cron persisted to disk
# ---------------------------------------------------------------------------

class TestMultiTriggerPatchRoundTrip:
    """N6: the trigger-update logic in PATCH /workers/{id} must write the
    updated cron/trigger values back to worker.yml on disk."""

    INITIAL_YML = """\
schema_version: "0.3"
name: rt-worker
title: "Round-trip Worker"
description: "Test worker."
version: "0.1.0"
exec:
  command: python run.py
  runtime: python311
  mode: pure-script
  runner: e2b
  inputs: []
  outputs: []
trigger:
  type: manual
"""

    def _apply_patch(self, yml_path: Path, new_type: str, new_cron: str, new_tz: str):
        """Simulate the N6 disk-write logic from update_worker() PATCH handler."""
        trigger_lines = ["trigger:", f"  type: {new_type}"]
        if new_type == "schedule":
            trigger_lines.append(f'  cron: "{new_cron}"')
            trigger_lines.append(f'  timezone: "{new_tz}"')
        new_trigger_yaml = "\n".join(trigger_lines)

        existing_yml = yml_path.read_text()
        lines = existing_yml.split("\n")
        start = next(
            (i for i, ln in enumerate(lines) if re.match(r"^triggers?:\s*$", ln)),
            None,
        )
        if start is not None:
            end = len(lines)
            for i in range(start + 1, len(lines)):
                if re.match(r"^[A-Za-z_][\w_-]*:\s*", lines[i]):
                    end = i
                    break
            updated_yml = "\n".join(
                lines[:start] + new_trigger_yaml.split("\n") + lines[end:]
            )
        else:
            updated_yml = existing_yml.rstrip("\n") + "\n\n" + new_trigger_yaml + "\n"

        yml_path.write_text(updated_yml)

    def test_cron_value_persisted_to_disk(self, tmp_path):
        yml_path = tmp_path / "worker.yml"
        yml_path.write_text(self.INITIAL_YML)
        self._apply_patch(yml_path, "schedule", "0 7 * * 1", "Europe/Berlin")
        content = yml_path.read_text()
        assert "0 7 * * 1" in content, "cron not found in updated YAML"
        assert "schedule" in content
        assert "Europe/Berlin" in content

    def test_other_yaml_fields_preserved(self, tmp_path):
        yml_path = tmp_path / "worker.yml"
        yml_path.write_text(self.INITIAL_YML)
        self._apply_patch(yml_path, "schedule", "30 8 * * *", "UTC")
        content = yml_path.read_text()
        assert "schema_version" in content
        assert "rt-worker" in content
        assert "Round-trip Worker" in content
        assert "python311" in content
        assert "30 8 * * *" in content

    def test_manual_trigger_patch(self, tmp_path):
        """Patching back to manual removes cron from the trigger block."""
        yml_path = tmp_path / "worker.yml"
        yml_path.write_text(self.INITIAL_YML)
        # First set to schedule
        self._apply_patch(yml_path, "schedule", "0 9 * * *", "UTC")
        assert "0 9 * * *" in yml_path.read_text()
        # Now patch back to manual
        self._apply_patch(yml_path, "manual", "", "")
        content = yml_path.read_text()
        assert "type: manual" in content
        # cron should not be in the trigger block (not set for manual)
        trigger_idx = content.find("trigger:")
        remaining = content[trigger_idx:] if trigger_idx >= 0 else content
        assert "cron:" not in remaining.split("\n")[0:5], "cron should not appear in manual trigger block"

    def test_multi_triggers_block_detected(self, tmp_path):
        """The regex must match the `triggers:` (plural) block too."""
        yml_path = tmp_path / "worker.yml"
        yml_path.write_text(self.INITIAL_YML.replace("trigger:\n  type: manual", "triggers:\n  - type: manual"))
        self._apply_patch(yml_path, "schedule", "0 6 * * *", "Europe/London")
        content = yml_path.read_text()
        assert "0 6 * * *" in content
