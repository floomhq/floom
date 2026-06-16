from __future__ import annotations

import yaml
import pytest

from ops.smoke_cloud_critical import Config, Response, SmokeError, _smoke_chat, _smoke_create_worker, _smoke_edit_worker, run_smoke


class FakeClient:
    def __init__(self):
        self.calls: list[tuple[str, str, object | None, bool]] = []

    def request(self, method, path_or_url, *, json_body=None, auth=True, expected=None):
        self.calls.append((method, path_or_url, json_body, auth))
        if path_or_url == "/api/workers" and method == "POST":
            return Response(201, '{"id":"cloud-smoke-1"}')
        if path_or_url == "/api/workspaces":
            return Response(200, '{"workspaces":[{"id":"ws_test"}]}')
        if path_or_url in {"/api/workers", "/api/runs"}:
            return Response(200, "[]")
        if path_or_url.startswith("https://web.example/app/api/proxy/healthz"):
            status = 401 if expected and 401 in expected else 200
            return Response(status, "{}")
        if path_or_url == "/healthz":
            return Response(200, "{}")
        if path_or_url == "/mcp/ws_test":
            return Response(200, '{"jsonrpc":"2.0","id":"smoke-tools","result":{"tools":[]}}')
        if method == "PUT" and path_or_url == "/api/workers/cloud-smoke-1/files":
            return Response(200, "{}")
        if method == "POST" and path_or_url == "/api/chat":
            return Response(200, 'data: {"type":"finish"}\n\n')
        raise AssertionError(f"unexpected request {method} {path_or_url}")


def test_safe_smoke_runs_non_mutating_checks():
    client = FakeClient()
    passed = run_smoke(
        Config(
            api_base="https://api.example",
            token="tok",
            workspace_id="ws_test",
            web_base="https://web.example",
        ),
        client=client,
    )

    assert passed == [
        "api health",
        "auth workspaces",
        "workers list",
        "runs list",
        "mcp tools/list",
        "frontend proxy health",
    ]
    assert all(call[0] != "POST" or call[1] == "/mcp/ws_test" for call in client.calls)


def test_mutating_prod_smoke_requires_explicit_allow():
    with pytest.raises(SmokeError, match="Refusing mutating smoke"):
        run_smoke(
            Config(
                api_base="https://workeros-api.floom.dev",
                token="tok",
                mutate=True,
                allow_prod=False,
            ),
            client=FakeClient(),
        )


def test_smoke_create_worker_uses_current_manifest_schema():
    client = FakeClient()

    worker_id = _smoke_create_worker(client, "cloud-smoke-test")

    assert worker_id == "cloud-smoke-1"
    create_call = next(call for call in client.calls if call[0] == "POST" and call[1] == "/api/workers")
    manifest = yaml.safe_load(create_call[2]["worker_yml"])
    assert manifest["schema_version"] == "0.3"
    assert manifest["name"] == "cloud-smoke-test"
    assert "runtime" not in manifest
    assert manifest["exec"]["entry"] == "run.py"
    assert manifest["exec"]["runtime"] == "python311"
    assert manifest["exec"]["runner"] == "e2b"
    assert manifest["exec"]["inputs"] == []
    assert manifest["exec"]["outputs"][0]["name"] == "result"
    assert "result.json" in create_call[2]["run_py"]
    assert "inputs.json" in create_call[2]["run_py"]


def test_smoke_edit_worker_sends_full_file_set():
    client = FakeClient()

    _smoke_edit_worker(client, "cloud-smoke-1", "cloud-smoke-test")

    edit_call = next(call for call in client.calls if call[0] == "PUT")
    files = {item["path"]: item["content"] for item in edit_call[2]["files"]}
    assert set(files) == {"worker.yml", "run.py", "SKILL.md"}
    manifest = yaml.safe_load(files["worker.yml"])
    assert manifest["name"] == "cloud-smoke-test"
    assert manifest["exec"]["entry"] == "run.py"
    assert "cloud-smoke-test-edited" in files["run.py"]
    assert "result.json" in files["run.py"]


def test_smoke_chat_uses_current_chat_request_schema():
    client = FakeClient()

    _smoke_chat(client, "cloud-smoke-test")

    chat_call = next(call for call in client.calls if call[0] == "POST" and call[1] == "/api/chat")
    assert chat_call[2] == {
        "message": "Smoke check cloud-smoke-test. Reply briefly.",
        "source": "web",
    }
