#!/usr/bin/env python3
"""Seed a skill run and verify the run detail Transcript tab in a browser."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from playwright.sync_api import expect, sync_playwright


API_BASE = os.environ.get("FLOOM_API_BASE", "http://127.0.0.1:8017").rstrip("/")
WEB_BASE = os.environ.get("WORKEROS_WEB_BASE", "http://127.0.0.1:3017").rstrip("/")
DB_PATH = Path(os.environ.get("FLOOM_DB", "/tmp/workeros-t1b-ui.db"))
ARTIFACTS_DIR = Path(os.environ.get("FLOOM_ARTIFACTS_DIR", "/tmp/workeros-t1b-ui-artifacts"))
RUN_ID = "ui_skill_transcript"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def wait_for_api() -> None:
    for _ in range(60):
        try:
            response = requests.get(f"{API_BASE}/workers", timeout=2)
            if response.status_code == 200 and any(worker["id"] == "research_brief" for worker in response.json()):
                return
        except requests.RequestException:
            pass
        time.sleep(0.5)
    raise RuntimeError("API did not expose research_brief in time")


def seed_run() -> None:
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    run_dir = ARTIFACTS_DIR / RUN_ID
    run_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = run_dir / "transcript.jsonl"
    rows = [
        {"type": "message", "role": "system", "content": "# Research Brief"},
        {"type": "message", "role": "user", "content": '{"topic":"AI agents"}'},
        {
            "type": "tool_call",
            "id": "call_1",
            "name": "write_output",
            "arguments": {"name": "brief", "content": "# Brief"},
        },
        {
            "type": "tool_result",
            "tool_call_id": "call_1",
            "name": "write_output",
            "content": {"ok": True, "artifact": "brief.md"},
        },
        {"type": "message", "role": "assistant", "content": "Done."},
    ]
    transcript_path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("DELETE FROM artifacts WHERE run_id = ?", (RUN_ID,))
        conn.execute("DELETE FROM logs WHERE run_id = ?", (RUN_ID,))
        conn.execute("DELETE FROM runs WHERE id = ?", (RUN_ID,))
        conn.execute(
            """
            INSERT INTO runs
                (id, worker_id, status, trigger_source, runner, input_json, output_json,
                 approval_status, error, started_at, completed_at, duration_ms, created_at)
            VALUES (?, 'research_brief', 'completed', 'ui_test', 'skill', ?, ?,
                    'not_required', NULL, ?, ?, 1200, ?)
            """,
            (
                RUN_ID,
                json.dumps({"topic": "AI agents", "audience": "executive", "depth": "overview"}),
                json.dumps({"brief": "# Brief\nSeeded output"}),
                now_iso(),
                now_iso(),
                now_iso(),
            ),
        )
        conn.execute(
            "INSERT INTO logs (run_id, level, message, timestamp, trace_id) VALUES (?, 'info', ?, ?, 'trace_ui')",
            (RUN_ID, "Seeded skill run", now_iso()),
        )
        conn.execute(
            """
            INSERT INTO artifacts (id, run_id, name, type, path, size_bytes, created_at)
            VALUES ('art_transcript_ui', ?, 'transcript.jsonl', 'jsonl', ?, ?, ?)
            """,
            (RUN_ID, str(transcript_path), transcript_path.stat().st_size, now_iso()),
        )


def verify_ui() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(f"{WEB_BASE}/runs/{RUN_ID}", wait_until="domcontentloaded")
        expect(page.get_by_text(RUN_ID)).to_be_visible()
        expect(page.get_by_role("tab", name="Transcript")).to_be_visible()
        page.get_by_role("tab", name="Transcript").evaluate("(node) => node.click()")
        page.wait_for_timeout(500)
        try:
            expect(page.get_by_text("Tool call · write_output")).to_be_visible(timeout=10000)
            expect(page.get_by_text("Tool result · write_output")).to_be_visible(timeout=10000)
        except AssertionError:
            print(page.locator("body").inner_text(timeout=2000))
            raise
        browser.close()


if __name__ == "__main__":
    wait_for_api()
    seed_run()
    verify_ui()
    print("Transcript UI verified")
