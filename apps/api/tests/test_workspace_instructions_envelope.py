"""N3-1: workspace instructions must accept raw markdown OR a JSON
``{"content": "..."}`` envelope, and an already-corrupted (JSON-stored) value
must be repairable — without mangling legit markdown that happens to start with
``{``.

Bug: the Cloud wrapper PUT a JSON envelope to the OSS ``PUT /workspace``, which
stored the raw body verbatim. The literal ``{"content":"..."}`` string then got
prepended to every agent's system prompt and shown on /assistant.
"""

from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Unit: the pure unwrap helper
# ---------------------------------------------------------------------------

class TestUnwrapWorkspaceBody:
    def _unwrap(self, body: str) -> str:
        import chat_service
        return chat_service.unwrap_workspace_body(body)

    def test_raw_markdown_is_untouched(self):
        md = "# My workspace\n\nDo great work."
        assert self._unwrap(md) == md

    def test_json_envelope_is_unwrapped(self):
        assert self._unwrap('{"content": "# Test workspace"}') == "# Test workspace"

    def test_json_envelope_with_newlines_and_markdown(self):
        inner = "# Workspace\n\n- rule 1\n- rule 2\n"
        import json
        envelope = json.dumps({"content": inner})
        assert self._unwrap(envelope) == inner

    def test_markdown_starting_with_brace_but_not_envelope_is_untouched(self):
        # A JSON code block in markdown — NOT the envelope shape. Must not mangle.
        md = '{"foo": "bar"}\n\nThis is documentation about JSON.'
        assert self._unwrap(md) == md

    def test_envelope_with_extra_keys_is_not_unwrapped(self):
        # Only the exact single-key {"content": <str>} envelope is unwrapped.
        body = '{"content": "# X", "other": 1}'
        assert self._unwrap(body) == body

    def test_envelope_with_non_string_content_is_not_unwrapped(self):
        body = '{"content": 123}'
        assert self._unwrap(body) == body

    def test_invalid_json_starting_with_brace_is_untouched(self):
        md = "{ this is not json but starts with a brace"
        assert self._unwrap(md) == md

    def test_plain_text_is_untouched(self):
        assert self._unwrap("just some instructions") == "just some instructions"


# ---------------------------------------------------------------------------
# Integration: PUT /workspace stores unwrapped, and the repair script unwraps a
# corrupted file. We monkeypatch WORKSPACE_MD_PATH so the real repo file is never
# touched.
# ---------------------------------------------------------------------------

@pytest.fixture()
def client_and_main(monkeypatch, tmp_path):
    import types

    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    agent_dir = workers_dir / "workspace-agent"
    agent_dir.mkdir()
    (agent_dir / "SKILL.md").write_text(
        "# Workspace Agent\n\nYou manage the workspace.\n\n{{WORKSPACE_PREAMBLE}}\n",
        encoding="utf-8",
    )
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-envelope")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "")
    monkeypatch.setenv("SLACK_ALLOWED_TEAM_IDS", "")

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts", "chat_service",
    ]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    chat_service = importlib.import_module("chat_service")

    # Redirect workspace.md to the temp dir so we never touch the real repo file.
    ws_path = tmp_path / "workspace.md"
    monkeypatch.setattr(chat_service, "WORKSPACE_MD_PATH", ws_path)

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-envelope"}) as client:
        yield client, chat_service, ws_path
    db.get_repositories.cache_clear()


def test_put_raw_markdown_stored_as_markdown(client_and_main):
    client, chat_service, ws_path = client_and_main
    resp = client.put("/workspace", content="# Raw markdown\n\nbody",
                      headers={"content-type": "text/markdown"})
    assert resp.status_code == 204, resp.text
    assert ws_path.read_text() == "# Raw markdown\n\nbody"
    assert chat_service.get_workspace_md() == "# Raw markdown\n\nbody"


def test_put_json_envelope_stored_unwrapped(client_and_main):
    client, chat_service, ws_path = client_and_main
    resp = client.put("/workspace", json={"content": "# X"})
    assert resp.status_code == 204, resp.text
    # Stored as the inner markdown, NOT the literal JSON envelope.
    stored = ws_path.read_text()
    assert stored == "# X"
    assert stored != '{"content": "# X"}'
    assert '"content"' not in chat_service.get_workspace_md()


def test_put_markdown_starting_with_brace_not_mangled(client_and_main):
    client, chat_service, ws_path = client_and_main
    md = '{"foo": "bar"}\n\nDocs about JSON config.'
    resp = client.put("/workspace", content=md,
                      headers={"content-type": "text/markdown"})
    assert resp.status_code == 204, resp.text
    assert ws_path.read_text() == md


def test_repair_unwraps_corrupted_file(client_and_main, tmp_path):
    _client, chat_service, ws_path = client_and_main
    # Simulate the already-corrupted state: literal JSON envelope on disk.
    ws_path.write_text('{"content": "# Real instructions\\n\\nbe excellent"}')

    script = API_DIR / "scripts" / "repair_workspace_instructions.py"

    # Dry-run: reports corruption, changes nothing.
    dry = subprocess.run(
        [sys.executable, str(script), "--path", str(ws_path)],
        capture_output=True, text=True,
    )
    assert dry.returncode == 0, dry.stderr
    assert "CORRUPTED" in dry.stdout
    assert ws_path.read_text().startswith('{"content"')  # unchanged

    # Apply: unwraps in place.
    applied = subprocess.run(
        [sys.executable, str(script), "--path", str(ws_path), "--apply"],
        capture_output=True, text=True,
    )
    assert applied.returncode == 0, applied.stderr
    assert ws_path.read_text() == "# Real instructions\n\nbe excellent"

    # Idempotent: a second apply is a no-op.
    again = subprocess.run(
        [sys.executable, str(script), "--path", str(ws_path), "--apply"],
        capture_output=True, text=True,
    )
    assert again.returncode == 0, again.stderr
    assert "No repair needed" in again.stdout
    assert ws_path.read_text() == "# Real instructions\n\nbe excellent"


def test_repair_leaves_legit_markdown_alone(client_and_main):
    _client, _chat_service, ws_path = client_and_main
    md = '{"foo": "bar"}\n\nLegit markdown that starts with a brace.'
    ws_path.write_text(md)
    script = API_DIR / "scripts" / "repair_workspace_instructions.py"
    result = subprocess.run(
        [sys.executable, str(script), "--path", str(ws_path), "--apply"],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "No repair needed" in result.stdout
    assert ws_path.read_text() == md
