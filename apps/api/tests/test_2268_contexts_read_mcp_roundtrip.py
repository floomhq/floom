"""#2268 — contexts.read via the MCP proxy must round-trip what contexts.write wrote.

RCA: the /mcp-tools/serve dispatch proxied contexts.read to
``GET /contexts/{name}/files/{path}``, whose SUCCESS response for text files is
a raw non-JSON body. The proxy's JSON-first response parser
(``_api_call_response_data``) could not round-trip that faithfully: deployed
builds masked every successful read as ``{"detail": "Internal server error"}``
(read worked ONLY on misses, which return JSON 404s), empty files collapsed to
``{}``, and file content that itself is valid JSON was returned parsed instead
of as text.

Fix: the dispatch now requests ``?format=json`` and the REST route returns an
unambiguous JSON envelope (shape mirrors ``_mcp_call_contexts_read``):
``{"name", "path", "size", "mime_type", "is_binary", "content"}``.

These tests assert byte-fidelity of the write -> read round trip through the
real /mcp-tools/serve surface for ASCII, unicode/emoji, empty, and
JSON-shaped content, in both a sensitive (default) and a non-sensitive
context, and pin the raw (non-envelope) REST response as unchanged.

Run:
    cd apps/api && python -m pytest tests/test_2268_contexts_read_mcp_roundtrip.py -v
"""
from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    # alpha: sensitive by default (no explicit key). beta: explicitly non-sensitive.
    (contexts_dir / "alpha").mkdir()
    (contexts_dir / "beta").mkdir()
    (contexts_dir / ".workeros-contexts.json").write_text(
        json.dumps(
            {
                "alpha": {"writeable": True, "owner_id": "testuser"},
                "beta": {"writeable": True, "owner_id": "testuser", "sensitive": False},
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "testuser")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "files", "worker_registry", "runner_utils",
            "run_service", "webhook_service", "composio_client", "scheduler",
            "auth", "contexts", "chat_service", "git_ops", "github_api",
            "alerting", "mcp_server",
        ]):
            sys.modules.pop(name)
    for _rn in [x for x in list(sys.modules) if x.startswith("routers")]:
        sys.modules.pop(_rn, None)

    stub_names = [
        "e2b", "e2b.sandbox", "openai", "anthropic", "composio_openai",
        "composio_core", "slowapi", "slowapi.util", "slowapi.errors",
        "resend", "supabase", "gotrue",
    ]
    _newly_stubbed = [s for s in stub_names if s not in sys.modules]
    for stub in stub_names:
        if stub not in sys.modules:
            sys.modules[stub] = types.ModuleType(stub)

    git_ops_stub = types.ModuleType("git_ops")
    git_ops_stub.commit_paths = MagicMock(return_value=None)
    git_ops_stub.push_background = MagicMock(return_value=None)
    git_ops_stub.get_log = MagicMock(return_value=[])
    git_ops_stub.get_file_at_sha = MagicMock(return_value=None)
    git_ops_stub.list_files_at_sha = MagicMock(return_value=[])
    git_ops_stub.checkout_path = MagicMock(return_value=None)
    git_ops_stub.GitOpsError = Exception
    git_ops_stub.ensure_repo = MagicMock(return_value=None)
    git_ops_stub.get_active_workspace_id = MagicMock(return_value=None)
    sys.modules["git_ops"] = git_ops_stub

    import importlib

    main_mod = importlib.import_module("main")
    from fastapi.testclient import TestClient

    with TestClient(main_mod.app) as test_client:
        yield test_client
    sys.modules.pop("git_ops", None)
    for stub in _newly_stubbed:
        if isinstance(sys.modules.get(stub), types.ModuleType) and not getattr(
            sys.modules.get(stub), "__file__", None
        ):
            sys.modules.pop(stub, None)


HEADERS = {"x-floom-secret": "test-secret"}


def _mcp_call(client, tool, arguments):
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    resp = client.post("/mcp-tools/serve", json=body, headers=HEADERS)
    assert resp.status_code == 200, resp.text
    return resp.json()["result"]


CONTENT_CASES = [
    ("ascii", "plain ascii memory line\n"),
    ("unicode_emoji", "unicodé — ümläute ß 🚀🧠 中文\n"),
    ("empty", ""),
    # A file whose CONTENT is valid JSON must come back as that exact text,
    # not parsed (pre-fix, the proxy's resp.json() ate it).
    ("json_shaped", '{"detail": "Internal server error"}'),
]


@pytest.mark.parametrize("context_name", ["alpha", "beta"], ids=["sensitive", "non_sensitive"])
@pytest.mark.parametrize("case_id,content", CONTENT_CASES, ids=[c[0] for c in CONTENT_CASES])
def test_mcp_write_then_read_round_trips_exactly(client, context_name, case_id, content):
    path = f"mem/{case_id}.md"

    write = _mcp_call(client, "contexts.write", {"name": context_name, "path": path, "content": content})
    assert write["isError"] is False, write
    assert write["structuredContent"]["size"] == len(content.encode("utf-8"))

    read = _mcp_call(client, "contexts.read", {"name": context_name, "path": path})
    assert read["isError"] is False, read
    envelope = read["structuredContent"]
    assert envelope["content"] == content  # byte-fidelity: read-back == written
    assert envelope["is_binary"] is False
    assert envelope["name"] == context_name
    assert envelope["path"] == path
    assert envelope["size"] == len(content.encode("utf-8"))


def test_mcp_read_missing_path_still_reports_not_found(client):
    read = _mcp_call(client, "contexts.read", {"name": "alpha", "path": "never-written.md"})
    assert read["isError"] is True
    assert "Context file not found" in read["content"][0]["text"]
    assert "Internal server error" not in read["content"][0]["text"]


def test_rest_raw_get_is_unchanged(client):
    content = "raw body stays raw — ✓"
    put = client.put(
        "/contexts/alpha/files/raw.md",
        json={"content": content},
        headers=HEADERS,
    )
    assert put.status_code == 200, put.text

    resp = client.get("/contexts/alpha/files/raw.md", headers=HEADERS)
    assert resp.status_code == 200
    assert resp.content == content.encode("utf-8")
    assert "application/json" not in resp.headers.get("content-type", "")


def test_rest_get_format_json_returns_envelope(client):
    content = '{"nested": [1, 2, 3]}'
    put = client.put(
        "/contexts/alpha/files/env.json",
        json={"content": content},
        headers=HEADERS,
    )
    assert put.status_code == 200, put.text

    resp = client.get("/contexts/alpha/files/env.json", params={"format": "json"}, headers=HEADERS)
    assert resp.status_code == 200
    assert resp.headers.get("content-type", "").startswith("application/json")
    body = resp.json()
    assert body["content"] == content  # envelope wraps JSON-shaped text as text
    assert body["is_binary"] is False
    assert body["name"] == "alpha"
    assert body["path"] == "env.json"
    assert body["size"] == len(content.encode("utf-8"))
