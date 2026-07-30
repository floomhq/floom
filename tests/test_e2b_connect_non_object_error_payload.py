"""Regression: a non-object connect error payload must not become an opaque
``AttributeError: 'str' object has no attribute 'get'``.

Production evidence (prod runs, 2026-06-27 to 2026-07-20): 36 runs across 3
users failed with

    E2B sandbox failed before the worker timeout was reached:
    'str' object has no attribute 'get'

filed under the generic retryable ``e2b_sandbox_error``. The trace is entirely
inside the e2b SDK's vendored ``e2b_connect`` error decoder::

    def error_for_response(http_resp):
        try:
            error = json.loads(http_resp.content)   # a bare JSON string decodes fine
            return make_error(error)
        except (json.decoder.JSONDecodeError, KeyError):   # AttributeError is not caught
            ...

    def make_error(error):
        code_value = error.get("code")              # <- boom on str/None/int/list
        ...
        return ConnectException(status, error.get("message", ""))

The server-stream trailer path (``make_error(data["error"])``) has no guard at
all, and a worker command runs as a connect server stream, so that is the path
these runs took.

Two consequences made this worse than a bad message:

  * the AttributeError REPLACED the real upstream error, so the failure was
    undiagnosable from the run record, and
  * its text matches none of ``_TRANSIENT_E2B_TRANSPORT_MARKERS``, so the
    driver's bounded transport retry never engaged and the run was failed as
    *retryable* ``e2b_sandbox_error``. The run scheduler then re-dispatched
    twice more into the same failure, turning one real problem into three failed
    runs (the exact 1-manual-plus-2-retries triplets seen in prod).

These tests pin both halves of the fix: the payload normalizer, and the fact
that a driver-internal defect is classified distinctly and non-retryably.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.path.join(str(ROOT), "apps", "api"))

from runner_sandbox import e2b_connect_hardening
from runner_sandbox.e2b_driver import (
    SANDBOX_DRIVER_INTERNAL_ERROR_CODE,
    _is_driver_internal_error,
    _sandbox_exception_result,
)


# --------------------------------------------------------------------------
# The payload normalizer
# --------------------------------------------------------------------------


def _make_error_like_the_sdk(error):
    """A faithful copy of the vendored SDK's unguarded ``make_error`` body.

    Reproduced here so the test proves the defect independently of whether the
    installed e2b wheel vendors ``e2b_connect``, and so it keeps proving it if a
    future wheel moves the module.
    """
    code_value = error.get("code")
    return ("code", code_value, "message", error.get("message", ""))


@pytest.mark.parametrize(
    "payload, expected_type_name",
    [
        ('"upstream connect error or disconnect/reset before headers"', "str"),
        (None, "NoneType"),
        (503, "int"),
        ([{"code": "internal"}], "list"),
    ],
)
def test_unguarded_sdk_decoder_raises_attributeerror(payload, expected_type_name):
    """Pin the upstream defect this hardening exists for."""
    with pytest.raises(AttributeError) as excinfo:
        _make_error_like_the_sdk(payload)
    assert f"'{expected_type_name}' object has no attribute 'get'" in str(excinfo.value)


def test_normalizer_preserves_a_bare_string_payload_as_the_message():
    upstream = "upstream connect error or disconnect/reset before headers"
    normalized = e2b_connect_hardening.normalize_connect_error_payload(upstream)
    # The real upstream text survives instead of being destroyed. That is the
    # whole point: without it the operator sees only "'str' object has no
    # attribute 'get'".
    assert normalized["message"] == upstream
    assert normalized["code"] is None
    assert _make_error_like_the_sdk(normalized) == ("code", None, "message", upstream)


def test_normalizer_leaves_a_well_formed_object_untouched():
    payload = {"code": "internal", "message": "boom"}
    assert e2b_connect_hardening.normalize_connect_error_payload(payload) is payload


@pytest.mark.parametrize(
    "payload, expected_code, expected_message",
    [
        (None, None, ""),
        (b"raw bytes detail", None, "raw bytes detail"),
        (503, 503, ""),
        (True, None, "True"),
        ([{"code": "internal"}], None, "[{'code': 'internal'}]"),
    ],
)
def test_normalizer_handles_every_non_object_json_shape(
    payload, expected_code, expected_message
):
    normalized = e2b_connect_hardening.normalize_connect_error_payload(payload)
    assert normalized["code"] == expected_code
    assert normalized["message"] == expected_message
    # Whatever the shape, the SDK's own accessor pattern now works.
    _make_error_like_the_sdk(normalized)


def test_bool_is_not_treated_as_an_http_status():
    """``bool`` is an ``int`` subclass; ``True`` is not HTTP status 1."""
    normalized = e2b_connect_hardening.normalize_connect_error_payload(True)
    assert normalized["code"] is None


def test_normalizer_never_raises_on_an_exotic_payload():
    class Weird:
        def __str__(self) -> str:
            return "weird payload"

    normalized = e2b_connect_hardening.normalize_connect_error_payload(Weird())
    assert normalized == {"code": None, "message": "weird payload"}


# --------------------------------------------------------------------------
# Installing the wrapper
# --------------------------------------------------------------------------


class _FakeConnectClient:
    """Stand-in for ``e2b_connect.client``."""

    def __init__(self):
        self.calls = []

        def make_error(error):
            self.calls.append(error)
            return _make_error_like_the_sdk(error)

        self.make_error = make_error


@pytest.fixture
def fake_connect_module(monkeypatch):
    """Install a fake ``e2b_connect.client`` and reset the once-guard."""
    import types

    client = _FakeConnectClient()
    package = types.ModuleType("e2b_connect")
    module = types.ModuleType("e2b_connect.client")
    module.make_error = client.make_error
    package.client = module
    monkeypatch.setitem(sys.modules, "e2b_connect", package)
    monkeypatch.setitem(sys.modules, "e2b_connect.client", module)
    e2b_connect_hardening.reset_install_state_for_tests()
    yield module
    e2b_connect_hardening.reset_install_state_for_tests()


def test_install_wraps_make_error_and_fixes_a_bare_string_payload(fake_connect_module):
    original = fake_connect_module.make_error
    with pytest.raises(AttributeError):
        original("plain string error")

    assert e2b_connect_hardening.install_e2b_connect_error_hardening() is True

    patched = fake_connect_module.make_error
    assert patched is not original
    assert patched.__wrapped__ is original
    # No AttributeError, and the upstream text survives into the message slot.
    assert patched("plain string error") == ("code", None, "message", "plain string error")


def test_install_is_idempotent(fake_connect_module):
    assert e2b_connect_hardening.install_e2b_connect_error_hardening() is True
    first = fake_connect_module.make_error
    # Second call short-circuits on the once-guard and reports "active".
    assert e2b_connect_hardening.install_e2b_connect_error_hardening() is True
    assert fake_connect_module.make_error is first
    # Even after the guard is cleared, an already-wrapped function is not
    # double-wrapped (which would otherwise stack a wrapper per reload).
    e2b_connect_hardening.reset_install_state_for_tests()
    assert e2b_connect_hardening.install_e2b_connect_error_hardening() is True
    assert fake_connect_module.make_error is first
    assert fake_connect_module.make_error.__wrapped__ is not fake_connect_module.make_error


def test_install_is_a_no_op_when_the_sdk_module_is_absent(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def blocked_import(name, *args, **kwargs):
        if name.startswith("e2b_connect"):
            raise ImportError("no e2b_connect in this build")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked_import)
    monkeypatch.delitem(sys.modules, "e2b_connect", raising=False)
    monkeypatch.delitem(sys.modules, "e2b_connect.client", raising=False)
    e2b_connect_hardening.reset_install_state_for_tests()
    try:
        # Must not raise: a missing vendored module can never break sandbox runs.
        assert e2b_connect_hardening.install_e2b_connect_error_hardening() is False
    finally:
        e2b_connect_hardening.reset_install_state_for_tests()


def test_install_is_a_no_op_when_the_sdk_shape_changed(monkeypatch):
    import types

    package = types.ModuleType("e2b_connect")
    module = types.ModuleType("e2b_connect.client")
    package.client = module  # no make_error at all (e2b 2.35 dropped the vendor)
    monkeypatch.setitem(sys.modules, "e2b_connect", package)
    monkeypatch.setitem(sys.modules, "e2b_connect.client", module)
    e2b_connect_hardening.reset_install_state_for_tests()
    try:
        assert e2b_connect_hardening.install_e2b_connect_error_hardening() is False
    finally:
        e2b_connect_hardening.reset_install_state_for_tests()


def test_against_the_real_vendored_sdk_if_it_is_installed(monkeypatch):
    """End-to-end proof against the actual dependency, not just a fake.

    Skipped when the installed e2b wheel does not vendor ``e2b_connect``
    (e2b 2.35 replaced it with third-party ``connectrpc``), so this never turns
    into a false CI failure on an SDK bump.
    """
    connect_client = pytest.importorskip(
        "e2b_connect.client",
        reason="installed e2b wheel does not vendor e2b_connect",
    )
    original = getattr(connect_client, "make_error", None)
    if not callable(original) or getattr(
        original, e2b_connect_hardening._HARDENED_ATTR, False
    ):
        pytest.skip("e2b_connect.client.make_error is absent or already wrapped")

    monkeypatch.setattr(connect_client, "make_error", original, raising=False)
    e2b_connect_hardening.reset_install_state_for_tests()
    try:
        # The real SDK function is genuinely broken on a bare-string payload.
        with pytest.raises(AttributeError):
            original("upstream connect error")

        assert e2b_connect_hardening.install_e2b_connect_error_hardening() is True
        hardened = connect_client.make_error
        err = hardened("upstream connect error")
        # A real ConnectException carrying the upstream text, not an AttributeError.
        assert isinstance(err, BaseException)
        assert getattr(err, "message", None) == "upstream connect error"
        # And a well-formed payload still decodes exactly as before.
        ok = hardened({"code": "internal", "message": "boom"})
        assert getattr(ok, "message", None) == "boom"
    finally:
        e2b_connect_hardening.reset_install_state_for_tests()


def test_driver_installs_the_hardening_before_spawning_a_sandbox():
    """The driver must actually call the installer, not just ship the module."""
    import inspect

    from runner_sandbox import agent_driver, e2b_driver

    driver_source = inspect.getsource(e2b_driver.E2BSandboxDriver._run_in_sandbox)
    assert "install_e2b_connect_error_hardening()" in driver_source
    assert "install_e2b_connect_error_hardening()" in inspect.getsource(agent_driver)


# --------------------------------------------------------------------------
# Classification: a driver defect is not an E2B platform failure
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "exc",
    [
        AttributeError("'str' object has no attribute 'get'"),
        TypeError("unsupported operand"),
        KeyError("outputs"),
        NameError("name 'foo' is not defined"),
        IndexError("list index out of range"),
        UnboundLocalError("local variable referenced before assignment"),
        ZeroDivisionError("division by zero"),
        ImportError("cannot import name 'Sandbox'"),
        NotImplementedError("subclass responsibility"),
    ],
)
def test_programming_defects_get_their_own_non_retryable_code(exc):
    result = _sandbox_exception_result(exc, elapsed_seconds=4.3, timeout_seconds=1800)
    assert result.error_code == SANDBOX_DRIVER_INTERNAL_ERROR_CODE
    # Non-retryable is the point: re-running a deterministic defect only
    # multiplies the user's failed-run count.
    assert result.retryable is False
    assert exc.__class__.__name__ in result.error
    # Never blame the customer's worker for our bug.
    assert "Floom defect" in result.error


def test_the_exact_production_exception_is_classified_correctly():
    """The literal failure seen on 36 prod runs."""
    exc = AttributeError("'str' object has no attribute 'get'")
    result = _sandbox_exception_result(exc, elapsed_seconds=4.301, timeout_seconds=1800)
    assert result.error_code == SANDBOX_DRIVER_INTERNAL_ERROR_CODE
    assert result.retryable is False


@pytest.mark.parametrize(
    "exc",
    [
        Exception("Server disconnected"),
        Exception("ConnectionTerminated"),
        Exception("Error decoding header block: Encoded header out of range"),
        Exception("[Errno 32] Broken pipe"),
        RuntimeError("deque mutated during iteration"),
    ],
)
def test_genuine_transport_failures_stay_retryable_e2b_sandbox_errors(exc):
    """The split must not steal cases the transport-retry work already handles."""
    result = _sandbox_exception_result(exc, elapsed_seconds=4.0, timeout_seconds=1800)
    assert result.error_code == "e2b_sandbox_error"
    assert result.retryable is True


def test_a_transport_error_that_happens_to_be_a_typeerror_stays_transient():
    """Type of the exception must not outrank a recognized transport signature."""
    exc = TypeError("Server disconnected while reading the stream")
    assert _is_driver_internal_error(exc) is False
    result = _sandbox_exception_result(exc, elapsed_seconds=4.0, timeout_seconds=1800)
    assert result.error_code == "e2b_sandbox_error"
    assert result.retryable is True


def test_timeout_classification_still_wins_over_the_internal_split():
    exc = TypeError("context deadline exceeded")
    result = _sandbox_exception_result(exc, elapsed_seconds=1800.0, timeout_seconds=1800)
    assert result.error_code == "timeout"


def test_the_new_code_is_registered_across_the_failure_taxonomy():
    """A new terminal code is useless if the retry, metrics, alerting and
    user-facing layers do not know about it."""
    import alerting
    import run_service
    from services import public_view, run_metrics

    code = SANDBOX_DRIVER_INTERNAL_ERROR_CODE
    # Never auto-retried by the run scheduler either.
    assert code in run_service._PERMANENT_RETRY_ERROR_CODES
    assert code not in run_service._TRANSIENT_RETRY_ERROR_CODES
    decision = run_service._classify_retry_failure(error_code=code)
    assert decision.retryable is False
    assert decision.permanent is True
    # Categorized, not dumped in "unknown".
    assert run_metrics.classify_failure(error_code=code) == "crash"
    # Pages the operator: it is always our defect.
    assert code in alerting._OPS_PLATFORM_ERROR_CODES
    # And the user gets a plain-language headline rather than a raw traceback.
    assert code in public_view._OPERATOR_ERROR_CODE_HEADLINES
