"""Run-notification email must carry its Resend credential per request.

Regression guard for a latent credential race. The resend SDK reads its
credential from the process-global ``resend.api_key`` when it BUILDS the
request, not when you assign it, so the old

    import resend
    resend.api_key = api_key
    resend.Emails.send(payload)

could ship an email under whichever key another sender in the same process had
assigned last. The notification path runs on its own daemon thread and the
hosted wrapper vendors this engine while sending its own mail from a second
Resend account, so "one key per process" is not something this module gets to
assume. The send is now a plain POST with an Authorization header built per
request, and there is no shared state left to lose.

Mirrors the same fix on the cloud side (workeros-cloud #1277, 2a0b474).
"""
from __future__ import annotations

import inspect
import re
import sys
import threading
import time
import types
from pathlib import Path

import httpx
import pytest

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from services import run_notifications as rn  # noqa: E402


GLOBAL_SENTINEL = "sentinel-never-assigned"


class _Response:
    """Minimal stand-in for an httpx response."""

    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def _install_resend_global_probe(monkeypatch):
    """Put a stub ``resend`` module in place whose api_key must never change.

    Under the old implementation ``import resend; resend.api_key = api_key``
    overwrote this sentinel on every send. The stub faithfully reproduces what
    the real SDK does with it: ``Request.__get_headers`` builds
    ``Authorization: Bearer {resend.api_key}`` when the request is BUILT, on
    the sender thread, long after the assignment. So if anything ever routes
    through the SDK again, these tests observe the real crossover (a header
    carrying another sender's key) rather than merely a stub that refuses.
    """
    stub = types.ModuleType("resend")
    stub.api_key = GLOBAL_SENTINEL

    def _sdk_send(payload):
        import httpx

        # The window the SDK leaves open between "assign the global" and "read
        # the global to build the request".
        time.sleep(0.001)
        # Literal URL, not a module constant: the stub has to work unchanged
        # against the pre-fix implementation for the counterfactual to mean
        # anything.
        return httpx.post(
            "https://api.resend.com/emails",
            json=payload,
            headers={"Authorization": f"Bearer {stub.api_key}"},
            timeout=5.0,
        )

    stub.Emails = types.SimpleNamespace(send=_sdk_send)
    monkeypatch.setitem(sys.modules, "resend", stub)
    return stub


def _base_env(monkeypatch):
    monkeypatch.setenv("NOTIFY_FROM_EMAIL", "notifications@example.com")
    monkeypatch.delenv("WORKEROS_EMAIL_FROM", raising=False)
    monkeypatch.delenv("WORKEROS_EMAIL_UNSUBSCRIBE_URL", raising=False)
    monkeypatch.setenv("WORKEROS_RESEND_TIMEOUT_SECONDS", "5")


def test_resend_send_carries_the_key_per_request_and_surfaces_provider_errors(monkeypatch):
    seen = []

    def fake_post(url, json=None, headers=None, timeout=None):
        seen.append((url, json, headers, timeout))
        return _Response(200, {"id": "email_abc"})

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setenv("WORKEROS_RESEND_TIMEOUT_SECONDS", "7")

    out = rn._resend_send(api_key="re_caller_key", params={"from": "x@y.z"})

    assert out == {"id": "email_abc"}
    url, body, headers, timeout = seen[0]
    assert url == rn.RESEND_SEND_URL == "https://api.resend.com/emails"
    assert body == {"from": "x@y.z"}
    assert headers["Authorization"] == "Bearer re_caller_key"
    assert headers["Content-Type"] == "application/json"
    assert timeout == 7.0

    # A provider rejection must raise with the provider's own message rather
    # than be mistaken for a delivered email.
    monkeypatch.setattr(
        httpx,
        "post",
        lambda *a, **k: _Response(403, {"message": "The floom.dev domain is not verified"}),
    )
    with pytest.raises(RuntimeError) as err:
        rn._resend_send(api_key="re_caller_key", params={})
    assert "403" in str(err.value)
    assert "not verified" in str(err.value)

    # A malformed error body still raises rather than returning silently.
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Response(500, ValueError("not json")))
    with pytest.raises(RuntimeError):
        rn._resend_send(api_key="re_caller_key", params={})

    # A redirect is an UNDELIVERED email. httpx does not follow it (and a
    # credentialed POST must not chase one), so it has to raise rather than be
    # mistaken for an accepted send with no message id.
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Response(302, {"id": "not-delivered"}))
    with pytest.raises(RuntimeError) as redirect_err:
        rn._resend_send(api_key="re_caller_key", params={})
    assert "302" in str(redirect_err.value)

    # A success body that is valid JSON but not an object yields no message id
    # rather than exploding.
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Response(200, ["unexpected"]))
    assert rn._resend_send(api_key="re_caller_key", params={}) == {}

    # A success body that is not JSON at all surfaces as a failure, so the
    # caller logs it instead of reporting a delivery it cannot confirm.
    monkeypatch.setattr(httpx, "post", lambda *a, **k: _Response(200, ValueError("not json")))
    with pytest.raises(ValueError):
        rn._resend_send(api_key="re_caller_key", params={})


def test_resend_send_honours_the_api_url_override(monkeypatch):
    """The SDK read RESEND_API_URL; dropping the SDK must not drop the knob."""
    seen = []
    monkeypatch.setattr(
        httpx,
        "post",
        lambda url, json=None, headers=None, timeout=None: seen.append(url)
        or _Response(200, {"id": "email_1"}),
    )

    monkeypatch.delenv("RESEND_API_URL", raising=False)
    rn._resend_send(api_key="k", params={})
    assert seen[-1] == rn.RESEND_SEND_URL == "https://api.resend.com/emails"

    monkeypatch.setenv("RESEND_API_URL", "https://resend.proxy.internal/")
    rn._resend_send(api_key="k", params={})
    assert seen[-1] == "https://resend.proxy.internal/emails"


def test_notification_send_never_assigns_the_process_global_api_key(monkeypatch):
    stub = _install_resend_global_probe(monkeypatch)
    _base_env(monkeypatch)
    monkeypatch.setenv("RESEND_API_KEY", "re_only_key")

    seen = []
    monkeypatch.setattr(
        httpx,
        "post",
        lambda url, json=None, headers=None, timeout=None: seen.append(headers)
        or _Response(200, {"id": "email_1"}),
    )

    rn._send_email_notification(
        to_addrs=["ops@example.com"],
        worker_name="Worker",
        run_id="run_123",
        worker_id="worker_123",
        status="failed",
        error=None,
    )

    assert [h["Authorization"] for h in seen] == ["Bearer re_only_key"]
    assert stub.api_key == GLOBAL_SENTINEL

    # Belt and braces: no statement in the send path assigns the SDK global or
    # imports the SDK, so a future edit cannot quietly reintroduce the race.
    source = inspect.getsource(rn._send_email_notification) + inspect.getsource(rn._resend_send)
    statements = [line.strip() for line in source.splitlines()]
    assert not [line for line in statements if re.match(r"resend\.api_key\s*=", line)]
    assert not [line for line in statements if re.match(r"(import|from)\s+resend\b", line)]
    assert "Authorization" in inspect.getsource(rn._resend_send)


class _ThreadKeyedEnviron:
    """os.environ view that answers RESEND_API_KEY per calling thread.

    Two senders holding two different credentials in one process is exactly the
    situation the global made unsafe. Everything other than the key delegates to
    the real environment so the rest of the module behaves normally.
    """

    def __init__(self, real, local):
        self._real = real
        self._local = local

    def _override(self, key):
        if key == "RESEND_API_KEY":
            return getattr(self._local, "api_key", None)
        return None

    def get(self, key, default=None):
        return self._override(key) or self._real.get(key, default)

    def __getitem__(self, key):
        override = self._override(key)
        return override if override is not None else self._real[key]

    def __contains__(self, key):
        return self._override(key) is not None or key in self._real


def test_concurrent_sends_never_carry_another_senders_key(monkeypatch):
    """Many interleaved senders, each with its own credential, zero crossover."""
    thread_count = 64
    sends_per_thread = 8
    expected_total = thread_count * sends_per_thread

    stub = _install_resend_global_probe(monkeypatch)
    _base_env(monkeypatch)

    local = threading.local()
    monkeypatch.setattr(
        rn,
        "os",
        types.SimpleNamespace(environ=_ThreadKeyedEnviron(rn.os.environ, local)),
    )

    observed: list[tuple[str, str]] = []
    lock = threading.Lock()

    def fake_post(url, json=None, headers=None, timeout=None):
        # Hold each request in flight briefly so the senders genuinely overlap
        # rather than serialising through the transport. (The window that
        # mattered, between assigning the SDK global and reading it to build the
        # header, is reproduced inside the stub SDK in _install_resend_global_probe.)
        time.sleep(0.001)
        with lock:
            observed.append((json["to"][0], headers["Authorization"]))
        return _Response(200, {"id": "email_1"})

    monkeypatch.setattr(httpx, "post", fake_post)

    barrier = threading.Barrier(thread_count)
    errors: list[BaseException] = []

    def worker(index: int) -> None:
        local.api_key = f"re_key_{index}"
        try:
            barrier.wait(timeout=30)
            for _ in range(sends_per_thread):
                rn._send_email_notification(
                    to_addrs=[f"ops-{index}@example.com"],
                    worker_name=f"worker-{index}",
                    run_id=f"run_{index}",
                    worker_id=f"worker_{index}",
                    status="failed",
                    error=None,
                )
        except BaseException as exc:  # pragma: no cover - surfaced by the assert
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(thread_count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert not errors, errors
    assert not [t for t in threads if t.is_alive()]
    assert len(observed) == expected_total

    for recipient, authorization in observed:
        index = re.fullmatch(r"ops-(\d+)@example\.com", recipient).group(1)
        assert authorization == f"Bearer re_key_{index}"

    # Every sender got through, and no send borrowed the SDK global.
    assert len({recipient for recipient, _ in observed}) == thread_count
    assert stub.api_key == GLOBAL_SENTINEL
