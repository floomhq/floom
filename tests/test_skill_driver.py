#!/usr/bin/env python3
"""Unit tests for the skill runtime driver."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from models import (  # noqa: E402
    WorkerApprovalConfig,
    WorkerConfig,
    WorkerInput,
    WorkerOutput,
    WorkerRuntime,
    WorkerTrigger,
)
from runner_sandbox import skill_driver  # noqa: E402


class FakeOpenAIClient:
    def __init__(self, messages):
        self._messages = list(messages)
        self.calls = []
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self.create),
        )

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if not self._messages:
            raise AssertionError("OpenAI stub exhausted")
        message = self._messages.pop(0)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def assistant_message(content="", tool_calls=None):
    return SimpleNamespace(
        role="assistant",
        content=content,
        tool_calls=tool_calls or [],
    )


def tool_call(name, args, call_id="call_1"):
    return SimpleNamespace(
        id=call_id,
        type="function",
        function=SimpleNamespace(name=name, arguments=json.dumps(args)),
    )


def config_for(worker_dir: Path, *, connections=None) -> WorkerConfig:
    return WorkerConfig(
        id="research_brief",
        name="Research Brief",
        description="Test worker",
        model="gpt-test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="skill",
            entrypoint="SKILL.md",
            runner="local",
            bundle_path=str(worker_dir),
        ),
        inputs=[WorkerInput(name="topic", label="Topic", type="text", required=True)],
        secrets=["OPENAI_API_KEY"],
        connections=connections or [],
        outputs=[WorkerOutput(name="brief", label="Brief", type="markdown")],
        approvals=WorkerApprovalConfig(required=False),
    )


class SkillRuntimeDriverTest(unittest.TestCase):
    def test_tool_loop_writes_output_and_transcript(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "SKILL.md").write_text("Write a brief and call write_output.", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir

            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call("write_output", {"name": "brief", "content": "# Brief\nDone"})
                    ]
                ),
                assistant_message(content="Done."),
            ])
            driver = skill_driver.SkillRuntimeDriver(openai_client=fake_client)

            logs = []
            result = driver.run(
                worker_id="research_brief",
                run_id="run_test",
                inputs={"topic": "AI agents"},
                secrets={"OPENAI_API_KEY": "secret-value"},
                log_fn=lambda msg, level="info": logs.append((level, msg)),
                trace_id="trace_test",
                config=config_for(worker_dir),
            )

            self.assertEqual(result.status, "success")
            self.assertEqual(result.outputs["brief"], "# Brief\nDone")
            artifact_names = {artifact["name"] for artifact in result.artifacts}
            self.assertIn("brief.md", artifact_names)
            self.assertIn("transcript.jsonl", artifact_names)
            transcript = artifacts_dir / "run_test" / "transcript.jsonl"
            rows = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(rows[0]["role"], "system")
            self.assertTrue(any(row["type"] == "tool_call" and row["name"] == "write_output" for row in rows))
            self.assertIn("write_output", {tool["function"]["name"] for tool in fake_client.calls[0]["tools"]})
            self.assertEqual(fake_client.calls[0]["model"], "gpt-test")

    def test_floom_placeholders_return_not_yet(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "SKILL.md").write_text("Invoke another skill.", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir

            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "floom__skills__invoke",
                            {"slug": "other-skill", "inputs": {"x": 1}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nFallback content"),
            ])
            driver = skill_driver.SkillRuntimeDriver(openai_client=fake_client)

            result = driver.run(
                worker_id="research_brief",
                run_id="run_placeholder",
                inputs={"topic": "AI agents"},
                secrets={},
                log_fn=lambda *_args, **_kwargs: None,
                trace_id="trace_test",
                config=config_for(worker_dir),
            )

            self.assertEqual(result.status, "success")
            self.assertEqual(result.outputs["brief"], "# Brief\nFallback content")
            transcript = artifacts_dir / "run_placeholder" / "transcript.jsonl"
            rows = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
            tool_result = next(row for row in rows if row["type"] == "tool_result")
            self.assertEqual(tool_result["name"], "floom.skills.invoke")
            self.assertEqual(tool_result["content"]["error"], "not yet")


if __name__ == "__main__":
    unittest.main()
