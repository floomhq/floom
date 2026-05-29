#!/usr/bin/env python3
"""Unit tests for the skill runtime driver."""

from __future__ import annotations

import json
import copy
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from models import (  # noqa: E402
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
        self.calls.append(copy.deepcopy(kwargs))
        if not self._messages:
            raise AssertionError("OpenAI stub exhausted")
        message = self._messages.pop(0)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class FailingOpenAIClient:
    def __init__(self):
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=self.create),
        )

    def create(self, **_kwargs):
        raise RuntimeError("simulated model failure")


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


def config_for(worker_dir: Path, *, connections=None, entrypoint="SKILL.md") -> WorkerConfig:
    return WorkerConfig(
        id="research_brief",
        name="Research Brief",
        description="Test worker",
        model="gpt-test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="skill",
            entrypoint=entrypoint,
            runner="local",
            bundle_path=str(worker_dir),
        ),
        inputs=[WorkerInput(name="topic", label="Topic", type="text", required=True)],
        secrets=["OPENAI_API_KEY"],
        connections=connections or [],
        outputs=[WorkerOutput(name="brief", label="Brief", type="markdown")],
    )


class _SkillDriverDirsMixin:
    """Save/restore skill_driver module-level dir handles.

    The driver resolves the worker bundle and artifacts against module-level
    WORKERS_DIR / ARTIFACTS_DIR (bound at import to the repo `../../workers`).
    Tests run the driver against per-test temp dirs, and the path-traversal
    guard in `_worker_dir_for_run` rejects any bundle_path outside
    WORKERS_DIR.parent. Each test therefore pins both handles to its temp base;
    restoring on tearDown keeps the mutation from leaking into other modules in
    a full-suite run.
    """

    def setUp(self):
        super().setUp()
        self._orig_workers_dir = skill_driver.WORKERS_DIR
        self._orig_artifacts_dir = skill_driver.ARTIFACTS_DIR

    def tearDown(self):
        skill_driver.WORKERS_DIR = self._orig_workers_dir
        skill_driver.ARTIFACTS_DIR = self._orig_artifacts_dir
        super().tearDown()


class SkillRuntimeDriverTest(_SkillDriverDirsMixin, unittest.TestCase):
    def test_tool_loop_writes_output_and_transcript(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "SKILL.md").write_text("Write a brief and call write_output.", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir
            skill_driver.WORKERS_DIR = base / "workers"

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
            transcript_artifact = next(artifact for artifact in result.artifacts if artifact["name"] == "transcript.jsonl")
            self.assertEqual(transcript_artifact["type"], "jsonl")
            transcript = artifacts_dir / "run_test" / "transcript.jsonl"
            rows = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(rows[0]["role"], "system")
            self.assertTrue(any(row["type"] == "tool_call" and row["name"] == "write_output" for row in rows))
            self.assertIn("write_output", {tool["function"]["name"] for tool in fake_client.calls[0]["tools"]})
            self.assertEqual(fake_client.calls[0]["model"], "gpt-test")
            tool_message = fake_client.calls[1]["messages"][-1]
            self.assertEqual(tool_message["role"], "tool")
            self.assertEqual(tool_message["tool_call_id"], "call_1")
            self.assertNotIn("name", tool_message)

    def test_transcript_artifact_scrubs_secret_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "SKILL.md").write_text("Write a brief.", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir
            skill_driver.WORKERS_DIR = base / "workers"

            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "write_output",
                            {"name": "brief", "content": "token secret-value appeared"},
                        )
                    ]
                ),
                assistant_message(content="Done."),
            ])
            driver = skill_driver.SkillRuntimeDriver(openai_client=fake_client)

            result = driver.run(
                worker_id="research_brief",
                run_id="run_scrub",
                inputs={"topic": "AI agents"},
                secrets={"OPENAI_API_KEY": "secret-value"},
                log_fn=lambda *_args, **_kwargs: None,
                trace_id="trace_test",
                config=config_for(worker_dir),
            )

            self.assertEqual(result.status, "success")
            transcript_text = (artifacts_dir / "run_scrub" / "transcript.jsonl").read_text(encoding="utf-8")
            self.assertNotIn("secret-value", transcript_text)
            self.assertIn("<REDACTED:OPENAI_API_KEY>", transcript_text)

    def test_floom_placeholders_return_not_yet(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "SKILL.md").write_text("Invoke another skill.", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir
            skill_driver.WORKERS_DIR = base / "workers"

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

    def test_uses_configured_skill_entrypoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "CUSTOM_SKILL.md").write_text("Custom entrypoint.", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir
            skill_driver.WORKERS_DIR = base / "workers"

            fake_client = FakeOpenAIClient([
                assistant_message(content="# Brief\nFrom custom entrypoint"),
            ])
            driver = skill_driver.SkillRuntimeDriver(openai_client=fake_client)

            result = driver.run(
                worker_id="research_brief",
                run_id="run_custom_entrypoint",
                inputs={"topic": "AI agents"},
                secrets={},
                log_fn=lambda *_args, **_kwargs: None,
                trace_id="trace_test",
                config=config_for(worker_dir, entrypoint="CUSTOM_SKILL.md"),
            )

            self.assertEqual(result.status, "success")
            self.assertEqual(result.outputs["brief"], "# Brief\nFrom custom entrypoint")
            self.assertEqual(fake_client.calls[0]["messages"][0]["content"], "Custom entrypoint.")

    def test_missing_declared_output_fails_after_transcript(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "SKILL.md").write_text("Write a brief.", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir
            skill_driver.WORKERS_DIR = base / "workers"

            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call("write_output", {"name": "wrong_name", "content": "Wrong output"})
                    ]
                ),
                assistant_message(content="Done."),
            ])
            driver = skill_driver.SkillRuntimeDriver(openai_client=fake_client)

            result = driver.run(
                worker_id="research_brief",
                run_id="run_missing_output",
                inputs={"topic": "AI agents"},
                secrets={},
                log_fn=lambda *_args, **_kwargs: None,
                trace_id="trace_test",
                config=config_for(worker_dir),
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error_code, "schema_violation")
            self.assertIn("brief", result.error or "")
            artifact_names = {artifact["name"] for artifact in result.artifacts}
            self.assertIn("wrong_name.txt", artifact_names)
            self.assertIn("transcript.jsonl", artifact_names)

    def test_model_failure_still_writes_transcript_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "SKILL.md").write_text("Write a brief.", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir
            skill_driver.WORKERS_DIR = base / "workers"

            driver = skill_driver.SkillRuntimeDriver(openai_client=FailingOpenAIClient())

            result = driver.run(
                worker_id="research_brief",
                run_id="run_model_failure",
                inputs={"topic": "AI agents"},
                secrets={"OPENAI_API_KEY": "secret-value"},
                log_fn=lambda *_args, **_kwargs: None,
                trace_id="trace_test",
                config=config_for(worker_dir),
            )

            self.assertEqual(result.status, "error")
            self.assertEqual(result.error_code, "openai_call_failed")
            artifact_names = {artifact["name"] for artifact in result.artifacts}
            self.assertIn("transcript.jsonl", artifact_names)
            transcript_text = (artifacts_dir / "run_model_failure" / "transcript.jsonl").read_text(encoding="utf-8")
            self.assertIn("openai_call_failed", transcript_text)
            self.assertIn("simulated model failure", transcript_text)


class ComposioToolDispatchTest(_SkillDriverDirsMixin, unittest.TestCase):
    """Unhappy-path coverage for the Composio tool dispatch surface."""

    def _setup(self, tmp, *, connections=None):
        base = Path(tmp)
        worker_dir = base / "worker"
        artifacts_dir = base / "artifacts"
        worker_dir.mkdir()
        (worker_dir / "SKILL.md").write_text("Call composio.gmail.execute.", encoding="utf-8")
        skill_driver.ARTIFACTS_DIR = artifacts_dir
        skill_driver.WORKERS_DIR = base / "workers"
        return base, worker_dir, artifacts_dir

    def _run_tool_call(self, worker_dir, run_id, fake_client, mock_requests, *, connections):
        driver = skill_driver.SkillRuntimeDriver(
            openai_client=fake_client,
            requests_session=mock_requests,
        )
        return driver.run(
            worker_id="research_brief",
            run_id=run_id,
            inputs={"topic": "AI agents"},
            secrets={"OPENAI_API_KEY": "k", "COMPOSIO_API_KEY": "ck"},
            log_fn=lambda *a, **k: None,
            trace_id="trace_test",
            config=config_for(worker_dir, connections=connections),
        )

    def _tool_result_contents(self, artifacts_dir, run_id):
        transcript = artifacts_dir / run_id / "transcript.jsonl"
        rows = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
        return [r["content"] for r in rows if r.get("type") == "tool_result"]

    def test_composio_schema_does_not_emit_regex_pattern(self):
        """Backend enforcement is the auth boundary; model schema avoids non-ECMA regex."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, _artifacts_dir = self._setup(tmp)
            driver = skill_driver.SkillRuntimeDriver(openai_client=FakeOpenAIClient([]))

            tools = driver._build_tools(config_for(worker_dir, connections=["gmail"]))
            composio_tool = next(
                tool for tool in tools
                if tool["function"]["name"] == "composio__gmail__execute"
            )
            tool_slug_schema = composio_tool["function"]["parameters"]["properties"]["tool_slug"]

            self.assertNotIn("pattern", tool_slug_schema)

    def test_composio_tool_slug_outside_namespace_is_rejected_pre_http(self):
        """LLM picking a slug outside its declared app namespace must NOT hit the wire."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, artifacts_dir = self._setup(tmp)
            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "composio__gmail__execute",
                            {"tool_slug": "SLACK_SEND_MESSAGE", "arguments": {}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nFallback"),
            ])
            mock_requests = MagicMock()
            driver = skill_driver.SkillRuntimeDriver(
                openai_client=fake_client,
                requests_session=mock_requests,
            )

            result = driver.run(
                worker_id="research_brief",
                run_id="run_namespace_violation",
                inputs={"topic": "AI agents"},
                secrets={"OPENAI_API_KEY": "k", "COMPOSIO_API_KEY": "ck"},
                log_fn=lambda *a, **k: None,
                trace_id="trace_test",
                config=config_for(worker_dir, connections=["gmail"]),
            )

            self.assertEqual(result.status, "success")
            # Critical: no HTTP request issued for the cross-namespace slug.
            self.assertFalse(mock_requests.post.called, "Composio HTTP must not be called for out-of-namespace slug")
            transcript = artifacts_dir / "run_namespace_violation" / "transcript.jsonl"
            rows = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
            tool_results = [r for r in rows if r.get("type") == "tool_result"]
            self.assertTrue(any(
                r["content"].get("error_code") == "tool_slug_namespace_violation"
                for r in tool_results
            ))

    def test_dotted_composio_tool_for_undeclared_app_is_rejected_pre_http(self):
        """Dotted composio.<app> tools must be limited to declared connections."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, artifacts_dir = self._setup(tmp)
            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "composio.slack.SLACK_SEND_MESSAGE",
                            {"arguments": {}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nFallback"),
            ])
            mock_requests = MagicMock()

            with patch.object(skill_driver.SkillRuntimeDriver, "_connection_id_for") as connection_lookup:
                result = self._run_tool_call(
                    worker_dir,
                    "run_dotted_undeclared_app",
                    fake_client,
                    mock_requests,
                    connections=["gmail"],
                )

            self.assertEqual(result.status, "success")
            self.assertFalse(connection_lookup.called, "Undeclared app must not resolve a connection")
            self.assertFalse(mock_requests.post.called, "Undeclared app must not call Composio HTTP")
            tool_results = self._tool_result_contents(artifacts_dir, "run_dotted_undeclared_app")
            self.assertTrue(any(
                item.get("error_code") == "tool_outside_declared_connections"
                and item.get("error") == "Worker did not declare connection to slack"
                for item in tool_results
            ))

    def test_generated_composio_tool_for_undeclared_app_is_rejected_pre_http(self):
        """Generated composio__<app>__execute tools use the same declared-app gate."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, artifacts_dir = self._setup(tmp)
            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "composio__slack__execute",
                            {"tool_slug": "SLACK_SEND_MESSAGE", "arguments": {}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nFallback"),
            ])
            mock_requests = MagicMock()

            with patch.object(skill_driver.SkillRuntimeDriver, "_connection_id_for") as connection_lookup:
                result = self._run_tool_call(
                    worker_dir,
                    "run_generated_undeclared_app",
                    fake_client,
                    mock_requests,
                    connections=["gmail"],
                )

            self.assertEqual(result.status, "success")
            self.assertFalse(connection_lookup.called, "Undeclared app must not resolve a connection")
            self.assertFalse(mock_requests.post.called, "Undeclared app must not call Composio HTTP")
            tool_results = self._tool_result_contents(artifacts_dir, "run_generated_undeclared_app")
            self.assertTrue(any(
                item.get("error_code") == "tool_outside_declared_connections"
                and item.get("error") == "Worker did not declare connection to slack"
                for item in tool_results
            ))

    def test_dotted_declared_app_with_wrong_slug_namespace_is_rejected_pre_http(self):
        """Declared dotted app still rejects tool slugs from another app namespace."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, artifacts_dir = self._setup(tmp)
            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "composio.gmail.SLACK_SEND_MESSAGE",
                            {"arguments": {}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nFallback"),
            ])
            mock_requests = MagicMock()

            with patch.object(skill_driver.SkillRuntimeDriver, "_connection_id_for") as connection_lookup:
                result = self._run_tool_call(
                    worker_dir,
                    "run_dotted_wrong_slug_namespace",
                    fake_client,
                    mock_requests,
                    connections=["gmail"],
                )

            self.assertEqual(result.status, "success")
            self.assertFalse(connection_lookup.called, "Namespace violation must not resolve a connection")
            self.assertFalse(mock_requests.post.called, "Namespace violation must not call Composio HTTP")
            tool_results = self._tool_result_contents(artifacts_dir, "run_dotted_wrong_slug_namespace")
            self.assertTrue(any(
                item.get("error_code") == "tool_slug_namespace_violation"
                for item in tool_results
            ))

    def test_dotted_declared_app_with_matching_slug_reaches_http(self):
        """Dotted composio.<declared-app>.<slug> proceeds through normal execution."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, _artifacts_dir = self._setup(tmp)
            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "composio.gmail.GMAIL_SEND_EMAIL",
                            {"arguments": {"to": "person@example.com"}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nSent"),
            ])
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {"ok": True}
            mock_requests = MagicMock()
            mock_requests.post.return_value = mock_response

            with patch.dict("os.environ", {"COMPOSIO_API_KEY": "ck"}), \
                    patch.object(skill_driver.SkillRuntimeDriver, "_connection_id_for", return_value="ca_test"):
                result = self._run_tool_call(
                    worker_dir,
                    "run_dotted_declared_app",
                    fake_client,
                    mock_requests,
                    connections=["gmail"],
                )

            self.assertEqual(result.status, "success")
            mock_requests.post.assert_called_once()
            called_url = mock_requests.post.call_args.args[0]
            self.assertTrue(called_url.endswith("/tools/execute/GMAIL_SEND_EMAIL"))

    def test_missing_composio_connection_fails_fast(self):
        """No active connection for the declared app -> missing_connection BEFORE HTTP."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, artifacts_dir = self._setup(tmp)
            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "composio__gmail__execute",
                            {"tool_slug": "GMAIL_SEND_EMAIL", "arguments": {}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nDone"),
            ])
            mock_requests = MagicMock()
            driver = skill_driver.SkillRuntimeDriver(
                openai_client=fake_client,
                requests_session=mock_requests,
            )

            with patch.object(driver, "_connection_id_for", return_value=None):
                result = driver.run(
                    worker_id="research_brief",
                    run_id="run_missing_conn",
                    inputs={"topic": "AI agents"},
                    secrets={"OPENAI_API_KEY": "k", "COMPOSIO_API_KEY": "ck"},
                    log_fn=lambda *a, **k: None,
                    trace_id="trace_test",
                    config=config_for(worker_dir, connections=["gmail"]),
                )

            self.assertEqual(result.status, "success")
            self.assertFalse(mock_requests.post.called, "No HTTP must fire when connection_id is None")
            transcript = artifacts_dir / "run_missing_conn" / "transcript.jsonl"
            rows = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
            tool_results = [r for r in rows if r.get("type") == "tool_result"]
            self.assertTrue(any(
                r["content"].get("error_code") == "missing_connection"
                for r in tool_results
            ))

    def test_composio_http_timeout_captured_as_tool_result(self):
        """Network timeout -> tool_result error, run continues to completion."""
        import requests as _requests_module
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, artifacts_dir = self._setup(tmp)
            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "composio__gmail__execute",
                            {"tool_slug": "GMAIL_SEND_EMAIL", "arguments": {}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nRecovered"),
            ])
            mock_requests = MagicMock()
            mock_requests.exceptions = _requests_module.exceptions
            mock_requests.post.side_effect = _requests_module.exceptions.Timeout("timeout")
            driver = skill_driver.SkillRuntimeDriver(
                openai_client=fake_client,
                requests_session=mock_requests,
            )

            with patch.object(driver, "_connection_id_for", return_value="ca_test"):
                import os as _os
                _os.environ["COMPOSIO_API_KEY"] = "ck"
                result = driver.run(
                    worker_id="research_brief",
                    run_id="run_composio_timeout",
                    inputs={"topic": "AI agents"},
                    secrets={"OPENAI_API_KEY": "k"},
                    log_fn=lambda *a, **k: None,
                    trace_id="trace_test",
                    config=config_for(worker_dir, connections=["gmail"]),
                )

            self.assertEqual(result.status, "success")
            transcript = artifacts_dir / "run_composio_timeout" / "transcript.jsonl"
            rows = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
            tool_results = [r for r in rows if r.get("type") == "tool_result"]
            self.assertTrue(any(
                r["content"].get("error_code") == "composio_timeout"
                for r in tool_results
            ))

    def test_composio_http_5xx_captured_as_tool_result(self):
        """Upstream 500 -> tool_result error with status_code, run continues."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, artifacts_dir = self._setup(tmp)
            fake_client = FakeOpenAIClient([
                assistant_message(
                    tool_calls=[
                        tool_call(
                            "composio__gmail__execute",
                            {"tool_slug": "GMAIL_SEND_EMAIL", "arguments": {}},
                        )
                    ]
                ),
                assistant_message(content="# Brief\nRecovered"),
            ])
            mock_response = MagicMock()
            mock_response.status_code = 500
            mock_response.json.return_value = {"error": "internal server error"}
            mock_requests = MagicMock()
            import requests as _r
            mock_requests.exceptions = _r.exceptions
            mock_requests.post.return_value = mock_response
            driver = skill_driver.SkillRuntimeDriver(
                openai_client=fake_client,
                requests_session=mock_requests,
            )

            with patch.object(driver, "_connection_id_for", return_value="ca_test"):
                import os as _os
                _os.environ["COMPOSIO_API_KEY"] = "ck"
                result = driver.run(
                    worker_id="research_brief",
                    run_id="run_composio_500",
                    inputs={"topic": "AI agents"},
                    secrets={"OPENAI_API_KEY": "k"},
                    log_fn=lambda *a, **k: None,
                    trace_id="trace_test",
                    config=config_for(worker_dir, connections=["gmail"]),
                )

            self.assertEqual(result.status, "success")
            transcript = artifacts_dir / "run_composio_500" / "transcript.jsonl"
            rows = [json.loads(line) for line in transcript.read_text(encoding="utf-8").splitlines()]
            tool_results = [r for r in rows if r.get("type") == "tool_result"]
            self.assertTrue(any(
                r["content"].get("status_code") == 500 for r in tool_results
            ))

    def test_concurrent_runs_no_shared_mutable_state(self):
        """5 parallel runs of the same worker must each capture their own output."""
        with tempfile.TemporaryDirectory() as tmp:
            _base, worker_dir, artifacts_dir = self._setup(tmp)

            results = {}
            errors = []

            def runner(run_idx: int):
                try:
                    fake_client = FakeOpenAIClient([
                        assistant_message(
                            tool_calls=[
                                tool_call(
                                    "write_output",
                                    {"name": "brief", "content": f"# Brief {run_idx}"},
                                )
                            ]
                        ),
                        assistant_message(content="Done."),
                    ])
                    driver = skill_driver.SkillRuntimeDriver(openai_client=fake_client)
                    r = driver.run(
                        worker_id="research_brief",
                        run_id=f"run_concurrent_{run_idx}",
                        inputs={"topic": f"Topic {run_idx}"},
                        secrets={"OPENAI_API_KEY": "k"},
                        log_fn=lambda *a, **k: None,
                        trace_id=f"trace_{run_idx}",
                        config=config_for(worker_dir),
                    )
                    results[run_idx] = r
                except Exception as exc:
                    errors.append((run_idx, exc))

            threads = [threading.Thread(target=runner, args=(i,)) for i in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(errors, [])
            self.assertEqual(len(results), 5)
            for i, r in results.items():
                self.assertEqual(r.status, "success")
                self.assertEqual(r.outputs["brief"], f"# Brief {i}")

    def test_skill_path_traversal_rejected(self):
        """bundle_path with .. components must NOT escape WORKERS_DIR."""
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            worker_dir = base / "worker"
            artifacts_dir = base / "artifacts"
            worker_dir.mkdir()
            (worker_dir / "SKILL.md").write_text("noop", encoding="utf-8")
            skill_driver.ARTIFACTS_DIR = artifacts_dir
            skill_driver.WORKERS_DIR = base / "workers"

            fake_client = FakeOpenAIClient([assistant_message(content="# Brief")])
            driver = skill_driver.SkillRuntimeDriver(openai_client=fake_client)

            # Force config to have a traversal-attempt bundle_path
            cfg = config_for(worker_dir)
            cfg.runtime.bundle_path = "../../../etc"

            result = driver.run(
                worker_id="research_brief",
                run_id="run_traversal",
                inputs={"topic": "x"},
                secrets={"OPENAI_API_KEY": "k"},
                log_fn=lambda *a, **k: None,
                trace_id="trace",
                config=cfg,
            )

            self.assertEqual(result.status, "error")
            self.assertIn(result.error_code, ("skill_not_found", "skill_path_invalid"))


if __name__ == "__main__":
    unittest.main()
