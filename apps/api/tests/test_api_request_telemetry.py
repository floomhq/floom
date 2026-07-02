from __future__ import annotations

import os
import sys
import asyncio

from starlette.responses import Response
from starlette.requests import Request

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import main  # noqa: E402
from auth import AuthContext  # noqa: E402


def _request(path: str, *, route_path: str | None = None, method: str = "GET") -> Request:
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "root_path": "",
        "headers": [],
        "query_string": b"token=secret",
        "server": ("testserver", 80),
        "scheme": "http",
        "client": ("127.0.0.1", 1234),
    }
    if route_path is not None:
        class _Route:
            pass

        route = _Route()
        route.path = route_path
        scope["route"] = route
    return Request(scope)


def test_api_request_route_label_prefers_route_template():
    req = _request("/runs/run_abc123/stream?token=secret", route_path="/runs/{run_id}/stream")

    assert main._api_request_route_label(req, "/runs/run_abc123/stream") == "/runs/{run_id}/stream"


def test_api_request_route_label_scrubs_dynamic_segments_without_query():
    req = _request("/runs/run_abc1234567890abcdef/composio-execute/GMAIL_FETCH")

    assert (
        main._api_request_route_label(req, "/runs/run_abc1234567890abcdef/composio-execute/GMAIL_FETCH")
        == "/runs/{id}/composio-execute/GMAIL_FETCH"
    )


def test_api_request_telemetry_excludes_noisy_and_sensitive_surfaces():
    assert main._api_request_telemetry_excluded("/health", "GET") is True
    assert main._api_request_telemetry_excluded("/healthz", "GET") is True
    assert main._api_request_telemetry_excluded("/telemetry/cli-command", "POST") is True
    assert main._api_request_telemetry_excluded("/assets/app.js", "GET") is True
    assert main._api_request_telemetry_excluded("/static/logo.svg", "GET") is True
    assert main._api_request_telemetry_excluded("/favicon.ico", "GET") is True
    assert main._api_request_telemetry_excluded("/runs/run_1/stream", "GET") is True
    assert main._api_request_telemetry_excluded("/workers/wkr_1/runs", "POST") is False


def test_api_request_workspace_id_uses_workspace_actor_principal():
    assert (
        main._api_request_workspace_id_for_auth(
            AuthContext(user_id="workspace:ws_1234567890abcd", auth_method="workspace_token")
        )
        == "ws_1234567890abcd"
    )
    assert main._api_request_workspace_id_for_auth(AuthContext(user_id="alice__ws_abcdef12345678")) == (
        "ws_abcdef12345678"
    )


def test_api_request_middleware_emits_workspace_token_workspace(monkeypatch):
    monkeypatch.setenv("WORKEROS_API_TELEMETRY_SAMPLE", "1.0")
    captured = []

    def fake_emit_api_request_completed(**kwargs):
        captured.append(kwargs)

    monkeypatch.setattr(
        "services.product_events.emit_api_request_completed",
        fake_emit_api_request_completed,
    )

    req = _request("/workers", route_path="/workers")
    req.state.auth_context = AuthContext(
        user_id="workspace:ws_1234567890abcd",
        auth_method="workspace_token",
        role="member",
    )

    async def call_next(_request):
        return Response(status_code=200)

    response = asyncio.run(main.api_request_telemetry_middleware(req, call_next))

    assert response.status_code == 200
    assert captured
    assert captured[0]["owner_id"] == "workspace:ws_1234567890abcd"
    assert captured[0]["workspace_id"] == "ws_1234567890abcd"
    assert captured[0]["auth_method"] == "workspace_token"
    assert captured[0]["route"] == "/workers"


def test_api_request_middleware_sampling_rate_zero_suppresses(monkeypatch):
    monkeypatch.setenv("WORKEROS_API_TELEMETRY_SAMPLE", "0.0")
    captured = []

    def fake_emit_api_request_completed(**kwargs):
        captured.append(kwargs)

    monkeypatch.setattr(
        "services.product_events.emit_api_request_completed",
        fake_emit_api_request_completed,
    )

    req = _request("/workers", route_path="/workers")
    req.state.auth_context = AuthContext(
        user_id="workspace:ws_1234567890abcd",
        auth_method="workspace_token",
        role="member",
    )

    async def call_next(_request):
        return Response(status_code=200)

    response = asyncio.run(main.api_request_telemetry_middleware(req, call_next))

    assert response.status_code == 200
    assert captured == []


def test_api_request_middleware_excluded_paths_never_emit(monkeypatch):
    monkeypatch.setenv("WORKEROS_API_TELEMETRY_SAMPLE", "1.0")
    captured = []

    def fake_emit_api_request_completed(**kwargs):
        captured.append(kwargs)

    monkeypatch.setattr(
        "services.product_events.emit_api_request_completed",
        fake_emit_api_request_completed,
    )

    async def call_next(_request):
        return Response(status_code=200)

    for path in ("/healthz", "/telemetry/cli-command"):
        req = _request(path, route_path=path, method="POST" if path.startswith("/telemetry/") else "GET")
        req.state.auth_context = AuthContext(
            user_id="workspace:ws_1234567890abcd",
            auth_method="workspace_token",
            role="member",
        )
        response = asyncio.run(main.api_request_telemetry_middleware(req, call_next))
        assert response.status_code == 200

    assert captured == []
