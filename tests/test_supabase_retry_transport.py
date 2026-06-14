"""Regression: the Supabase httpx client must retry once on a dropped
connection instead of surfacing ``httpx.RemoteProtocolError: Server
disconnected`` as a bare HTTP 500.

Root cause (deployed cloud, 2026-06-14): Supabase silently terminated a
pooled HTTP/2 connection mid-window; the next ``.execute()`` raised
RemoteProtocolError, which Starlette turned into a 500. That broke
run-detail Output (GET /api/runs/<id> -> list_logs) and intermittently
/auth/tokens/bootstrap, /api/system/overview, etc. The fix retries the
idempotent request once on a fresh connection.
"""

from __future__ import annotations

import httpx
import pytest

from apps.api.config import (
    _RetryingHTTPTransport,
    _new_retrying_httpx_client,
    _client_options,
)


def _make_request() -> httpx.Request:
    return httpx.Request("GET", "https://example.supabase.co/rest/v1/run_logs")


def test_retries_once_on_remote_protocol_error(monkeypatch):
    transport = _RetryingHTTPTransport(http2=True)
    calls = {"n": 0}
    ok = httpx.Response(200, json=[{"run_id": "r1"}])

    def fake_super_handle(self, request):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.RemoteProtocolError("Server disconnected", request=request)
        return ok

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_super_handle)

    resp = transport.handle_request(_make_request())

    assert calls["n"] == 2  # first attempt failed, retried once
    assert resp.status_code == 200


@pytest.mark.parametrize(
    "exc_factory",
    [
        lambda req: httpx.RemoteProtocolError("Server disconnected", request=req),
        lambda req: httpx.ConnectError("conn refused", request=req),
        lambda req: httpx.ConnectTimeout("timeout", request=req),
        lambda req: httpx.ReadError("read failed", request=req),
    ],
)
def test_each_retryable_error_is_retried(monkeypatch, exc_factory):
    transport = _RetryingHTTPTransport(http2=True)
    calls = {"n": 0}
    ok = httpx.Response(200, json=[])

    def fake_super_handle(self, request):
        calls["n"] += 1
        if calls["n"] == 1:
            raise exc_factory(request)
        return ok

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_super_handle)
    resp = transport.handle_request(_make_request())
    assert calls["n"] == 2
    assert resp.status_code == 200


def test_second_failure_propagates(monkeypatch):
    """If the retry also fails, the error must surface (not silently loop)."""
    transport = _RetryingHTTPTransport(http2=True)
    calls = {"n": 0}

    def fake_super_handle(self, request):
        calls["n"] += 1
        raise httpx.RemoteProtocolError("Server disconnected", request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_super_handle)
    with pytest.raises(httpx.RemoteProtocolError):
        transport.handle_request(_make_request())
    assert calls["n"] == 2  # tried twice, then gave up


def test_non_retryable_error_not_retried(monkeypatch):
    transport = _RetryingHTTPTransport(http2=True)
    calls = {"n": 0}

    def fake_super_handle(self, request):
        calls["n"] += 1
        raise httpx.HTTPStatusError("boom", request=request, response=httpx.Response(500))

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", fake_super_handle)
    with pytest.raises(httpx.HTTPStatusError):
        transport.handle_request(_make_request())
    assert calls["n"] == 1  # not retried


def test_client_and_options_wired_with_retry_transport():
    client = _new_retrying_httpx_client()
    assert isinstance(client._transport, _RetryingHTTPTransport)

    opts = _client_options()
    assert opts.httpx_client is not None
    assert isinstance(opts.httpx_client._transport, _RetryingHTTPTransport)
