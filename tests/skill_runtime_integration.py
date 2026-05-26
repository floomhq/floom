#!/usr/bin/env python3
"""Local integration check for skill runtime plus code-runtime regression."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
TMP = tempfile.TemporaryDirectory()
TMP_PATH = Path(TMP.name)

os.environ["FLOOM_DB"] = str(TMP_PATH / "floom.db")
os.environ["FLOOM_WORKERS_DIR"] = str(ROOT / "workers")
os.environ["FLOOM_ARTIFACTS_DIR"] = str(TMP_PATH / "artifacts")
os.environ["OPENAI_API_KEY"] = "test-openai-key"

sys.path.insert(0, str(ROOT / "apps" / "api"))

import main  # noqa: E402
from db import get_db  # noqa: E402
from run_service import create_run, execute_run  # noqa: E402
from runner_sandbox.skill_driver import SkillRuntimeDriver  # noqa: E402


class FakeOpenAIClient:
    def __init__(self, output_name: str = "brief"):
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.calls = 0
        self.output_name = output_name

    def create(self, **_kwargs):
        self.calls += 1
        if self.calls == 1:
            message = SimpleNamespace(
                role="assistant",
                content="",
                tool_calls=[
                    SimpleNamespace(
                        id="call_brief",
                        type="function",
                        function=SimpleNamespace(
                            name="write_output",
                            arguments=json.dumps({
                                "name": self.output_name,
                                "content": "# Research Brief\n\nStubbed integration output.",
                            }),
                        ),
                    )
                ],
            )
        else:
            message = SimpleNamespace(role="assistant", content="Done.", tool_calls=[])
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def run_row(run_id: str) -> sqlite3.Row:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise AssertionError(f"Run not found: {run_id}")
    return row


def artifacts_for(run_id: str) -> list[sqlite3.Row]:
    with get_db() as conn:
        return conn.execute("SELECT * FROM artifacts WHERE run_id = ? ORDER BY name", (run_id,)).fetchall()


def assert_skill_runtime() -> None:
    original_client = SkillRuntimeDriver._client
    SkillRuntimeDriver._client = lambda self, secrets: FakeOpenAIClient()
    try:
        run_id = create_run(
            "research_brief",
            {"topic": "AI agents", "audience": "executive", "depth": "overview"},
            trigger_source="integration",
        )
        execute_run(
            run_id,
            "research_brief",
            {"topic": "AI agents", "audience": "executive", "depth": "overview"},
        )
    finally:
        SkillRuntimeDriver._client = original_client

    row = run_row(run_id)
    assert row["status"] == "completed", row["error"]
    assert row["runner"] == "skill", row["runner"]
    output = json.loads(row["output_json"])
    assert output["brief"].startswith("# Research Brief")
    artifacts = artifacts_for(run_id)
    names = {artifact["name"] for artifact in artifacts}
    assert "brief.md" in names, names
    assert "transcript.jsonl" in names, names
    transcript = next(artifact for artifact in artifacts if artifact["name"] == "transcript.jsonl")
    transcript_path = Path(transcript["path"])
    assert transcript_path.is_file(), transcript_path
    assert any(json.loads(line)["type"] == "tool_call" for line in transcript_path.read_text().splitlines())
    print(f"skill runtime completed: {run_id}")


def assert_failed_skill_transcript_persisted() -> None:
    original_client = SkillRuntimeDriver._client
    SkillRuntimeDriver._client = lambda self, secrets: FakeOpenAIClient(output_name="wrong_name")
    try:
        run_id = create_run(
            "research_brief",
            {"topic": "AI agents", "audience": "executive", "depth": "overview"},
            trigger_source="integration",
        )
        execute_run(
            run_id,
            "research_brief",
            {"topic": "AI agents", "audience": "executive", "depth": "overview"},
        )
    finally:
        SkillRuntimeDriver._client = original_client

    row = run_row(run_id)
    assert row["status"] == "failed", row["status"]
    artifacts = artifacts_for(run_id)
    names = {artifact["name"] for artifact in artifacts}
    assert "wrong_name.txt" in names, names
    assert "transcript.jsonl" in names, names
    transcript = next(artifact for artifact in artifacts if artifact["name"] == "transcript.jsonl")
    assert Path(transcript["path"]).is_file(), transcript["path"]
    print(f"failed skill transcript persisted: {run_id}")


def assert_code_runtime_regression() -> None:
    inputs = {
        "text_input": "hello",
        "textarea_input": "longer text",
        "number_input": 7,
        "select_input": "beta",
        "boolean_input": True,
        "file_input": "file body",
    }
    run_id = create_run("input_types_test", inputs, trigger_source="integration")
    execute_run(run_id, "input_types_test", inputs)
    row = run_row(run_id)
    assert row["status"] == "completed", row["error"]
    assert row["runner"] == "local", row["runner"]
    output = json.loads(row["output_json"])
    assert "summary" in output
    assert "raw_inputs" in output
    print(f"code runtime completed: {run_id}")


if __name__ == "__main__":
    loaded = main.reload_workers()
    assert loaded.workers_loaded == 12, loaded
    assert_skill_runtime()
    assert_failed_skill_transcript_persisted()
    assert_code_runtime_regression()
    print("skill runtime integration passed")
