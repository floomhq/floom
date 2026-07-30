"""Harden the E2B connect-RPC error decoder against non-object error payloads.

Why this module exists
----------------------
The ``e2b`` SDK ships a vendored ``e2b_connect`` client. Its error decoder
assumes the decoded error payload is always a JSON **object**::

    def make_error(error):
        status = None
        try:
            code_value = error.get("code")      # <- AttributeError when not a Mapping
            ...
        except (KeyError, ValueError):
            status = Code.unknown
        return ConnectException(status, error.get("message", ""))

Three call sites feed it, and none of them guard the payload shape:

* ``error_for_response`` does ``json.loads(body)`` and only catches
  ``json.JSONDecodeError``/``KeyError``, so a body that is valid JSON but not an
  object falls straight through to ``make_error``.
* the server-stream trailer path calls ``make_error(data["error"])`` raw. A
  worker command runs as a connect **server stream**, so this is the path a
  failing worker command takes.

So an envd/edge error whose body is a bare JSON string, ``null``, a number or an
array raises ``AttributeError: 'str' object has no attribute 'get'`` from inside
the SDK instead of a ``ConnectException``.

That matters far more than a cosmetic message, because the AttributeError
*replaces* the real upstream error:

* the operator and the user never learn what actually failed upstream, and
* its text matches none of the driver's
  ``_TRANSIENT_E2B_TRANSPORT_MARKERS``, so ``_is_transient_e2b_transport_error``
  returns ``False``, the driver's bounded transport retry never engages, and the
  run is failed as a generic *retryable* ``e2b_sandbox_error``. The run-level
  retry scheduler then re-dispatches twice more, each attempt hitting the same
  masked upstream error, so one real failure is amplified into three failed
  runs on the user's dashboard.

The fix is deliberately narrow: normalize a non-Mapping payload into the shape
``make_error`` already expects, preserving the upstream text as the message.
The SDK then produces a real ``ConnectException`` and every existing
classification, retry and reporting path works as designed.

``make_error`` is the only function we need to wrap. Verified against the
vendored e2b 2.34.0 tree: ``e2b_connect`` is a single ``client.py`` plus an
``__init__`` that re-exports only ``Client``, ``GzipCompressor``,
``ConnectException`` and ``Code``. Nothing anywhere imports ``make_error`` or
``error_for_response`` by name, so both of its call sites (inside
``error_for_response``, and the stream trailer's ``make_error(data["error"])``)
resolve it as a module global at call time and see the wrapper.

This wraps the SDK rather than pinning a newer one on purpose. ``e2b`` 2.35
replaced the vendored ``e2b_connect`` with third-party ``connectrpc`` and swapped
the HTTP transport, which would invalidate the transport-retry behaviour tuned
against 2.34. Wrapping one function is the smaller, reversible change.
"""

from __future__ import annotations

import inspect
import logging
import threading
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)

# Marks our wrapper so installing twice is a no-op and so a test can assert the
# hardening is present without depending on the wrapper's identity.
_HARDENED_ATTR = "_workeros_connect_error_hardened"

# Memoized so the hot path (every sandbox spawn) does not re-import and
# re-inspect the SDK. Guarded by a lock rather than a bare flag: runs execute on
# concurrent executor threads, and a check-then-set flag would let a second
# thread observe "attempted" while the first is still importing, and proceed
# against an UNPATCHED SDK. That would reintroduce, under load, exactly the bug
# this module exists to prevent.
_install_lock = threading.Lock()
_install_result: bool | None = None


def normalize_connect_error_payload(payload: Any) -> Any:
    """Coerce a connect error payload into the ``{"code", "message"}`` shape.

    A ``Mapping`` is returned unchanged, so the SDK's own handling of a
    well-formed error is untouched. Anything else is wrapped so the upstream
    text survives as ``message`` instead of being destroyed by an
    ``AttributeError``.

    ``code`` follows what the SDK's ``make_error`` already understands: an
    ``int`` is treated as an HTTP status and mapped to a ``Code``; anything else
    goes through ``Code(...)``, whose ``ValueError`` the SDK catches and turns
    into ``Code.unknown``. ``None`` therefore yields ``Code.unknown``, which is
    the honest answer when the payload carried no code.
    """
    if isinstance(payload, Mapping):
        return payload
    if payload is None:
        return {"code": None, "message": ""}
    if isinstance(payload, (bytes, bytearray)):
        return {"code": None, "message": payload.decode("utf-8", errors="replace")}
    if isinstance(payload, str):
        return {"code": None, "message": payload}
    # bool is an int subclass but is never a meaningful HTTP status.
    if isinstance(payload, int) and not isinstance(payload, bool):
        return {"code": payload, "message": ""}
    return {"code": None, "message": str(payload)}


def install_e2b_connect_error_hardening() -> bool:
    """Wrap ``e2b_connect.client.make_error`` so it tolerates any payload shape.

    ``make_error`` is the single chokepoint: ``error_for_response`` and the
    server-stream trailer path both resolve it as a module global at call time,
    so wrapping the module attribute covers every path.

    Idempotent, and never raises: if the vendored module is absent or its shape
    changed (a newer ``e2b``), we log and leave the SDK untouched rather than
    breaking sandbox execution.

    :return: ``True`` when the hardening is active after this call, ``False``
        when the SDK could not be hardened (module unavailable, or unexpected
        shape). Safe to call on every sandbox spawn, from any thread.
    """
    global _install_result
    # Read under the lock too: a plain fast-path read could observe a half-set
    # result while another thread is mid-import.
    with _install_lock:
        if _install_result is None:
            _install_result = _install_once()
        return _install_result


def _accepts_one_positional_argument(func: Any) -> bool:
    """Whether *func* can be called as ``func(payload)``.

    A structural check instead of an e2b version pin: a version string would
    refuse to harden a patch release that still carries the defect, and would
    still not notice a signature change within the same version. What actually
    matters is that our one-argument call is still valid.
    """
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):  # builtins and C functions have no signature
        return False
    positional = [
        parameter
        for parameter in signature.parameters.values()
        if parameter.kind
        in (parameter.POSITIONAL_ONLY, parameter.POSITIONAL_OR_KEYWORD)
    ]
    if any(
        parameter.kind is parameter.VAR_POSITIONAL
        for parameter in signature.parameters.values()
    ):
        return True
    if len(positional) != 1:
        return False
    # A second, keyword-only parameter with no default would also break the call.
    return all(
        parameter.default is not parameter.empty
        for parameter in signature.parameters.values()
        if parameter.kind is parameter.KEYWORD_ONLY
    )


def _install_once() -> bool:
    try:
        from e2b_connect import client as connect_client  # noqa: PLC0415
    except Exception:  # pragma: no cover - depends on the installed SDK layout
        logger.debug(
            "e2b_connect is not importable; skipping connect error hardening",
            exc_info=True,
        )
        return False

    original = getattr(connect_client, "make_error", None)
    if not callable(original):
        logger.warning(
            "e2b_connect.client.make_error is missing or not callable; "
            "skipping connect error hardening"
        )
        return False
    if getattr(original, _HARDENED_ATTR, False):
        # Already wrapped (another import path, or a reloaded module). Report it
        # as active but never stack a second wrapper on top.
        return True
    if not _accepts_one_positional_argument(original):
        logger.warning(
            "e2b_connect.client.make_error has an unexpected signature (%s); "
            "skipping connect error hardening rather than risk breaking it",
            getattr(original, "__name__", original),
        )
        return False

    def make_error(error: Any):  # noqa: ANN202 - mirrors the SDK signature
        return original(normalize_connect_error_payload(error))

    setattr(make_error, _HARDENED_ATTR, True)
    make_error.__wrapped__ = original  # type: ignore[attr-defined]
    make_error.__doc__ = (original.__doc__ or "") + (
        "\n\nWrapped by Floom: non-object error payloads are normalized instead "
        "of raising AttributeError."
    )
    connect_client.make_error = make_error
    logger.info("Installed e2b_connect non-object error payload hardening")
    return True


def reset_install_state_for_tests() -> None:
    """Clear the memoized result. Test-only."""
    global _install_result
    with _install_lock:
        _install_result = None
