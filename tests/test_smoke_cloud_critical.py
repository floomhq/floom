from __future__ import annotations

import pytest

from ops.smoke_cloud_critical import Config, Response, SmokeError, run_smoke


class FakeClient:
    def __init__(self):
        self.calls: list[tuple[str, str, object | None, bool]] = []

    def request(self, method, path_or_url, *, json_body=None, auth=True, expected=None):
        self.calls.append((method, path_or_url, json_body, auth))
        if path_or_url == "/api/workspaces":
            return Response(200, '{"workspaces":[{"id":"ws_test"}]}')
        if path_or_url in {"/api/workers", "/api/runs"}:
            return Response(200, "[]")
        if path_or_url.startswith("https://web.example/app/api/proxy/healthz"):
            return Response(200, "{}")
        if path_or_url == "/healthz":
            return Response(200, "{}")
        if path_or_url == "/mcp/ws_test":
            return Response(200, '{"jsonrpc":"2.0","id":"smoke-tools","result":{"tools":[]}}')
        if path_or_url == "/api/workers" and method == "POST":
            return Response(201, '{"id":"cloud-smoke-1"}')
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
