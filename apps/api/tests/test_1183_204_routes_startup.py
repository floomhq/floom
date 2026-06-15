"""#1183 — CRITICAL: 204 No-Content routes must not break app startup.

Root cause: with ``from __future__ import annotations`` active in a module,
Python stores return annotations as the string ``"None"`` instead of
``type(None)``.  FastAPI (>=0.111) resolves the annotation via
``get_typed_annotation`` and, when the annotation evaluates to a truthy
non-``None`` value (e.g. the string ``"None"`` in older FastAPI builds), it
treats it as a *response model* and then asserts that a body-bearing model is
incompatible with ``status_code=204``.  The resulting ``AssertionError`` fires
at import time and prevents the app from starting.

Fix: every ``status_code=204`` endpoint must use ``response_class=Response``
and return ``Response(status_code=204)`` explicitly so that FastAPI never
infers a response model from the return annotation.

This test:
1. Verifies that each affected router can be imported without an
   ``AssertionError`` (regression gate — importing *would* crash on main
   before the fix because FastAPI evaluates all routes at import time).
2. Verifies that each 204 route is registered with ``response_class=Response``
   and carries *no* response model (the invariant the fix enforces).
3. Verifies that the full app (``main``) starts without raising an exception.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _routes_for(router) -> list:
    """Return all APIRoute objects registered on *router*."""
    from fastapi.routing import APIRoute
    return [r for r in router.routes if isinstance(r, APIRoute)]


def _204_routes(router) -> list:
    """Return routes whose default status code is 204."""
    return [r for r in _routes_for(router) if r.status_code == 204]


# ---------------------------------------------------------------------------
# The 8 affected routes, grouped by router module
# ---------------------------------------------------------------------------

AFFECTED = {
    "routers.auth": {
        "router_attr": "auth_router",
        "paths": {
            "/users/{uid}",
            "/auth/tokens/{token_id}",
        },
    },
    "routers.share": {
        "router_attr": "share_router",
        "paths": {
            "/share/grants/{grant_id}",
        },
    },
    "routers.worker_telemetry": {
        "router_attr": "worker_telemetry_router",
        "paths": {
            "/workers/{worker_id}/alerts/{alert_id}",
            "/workers/{worker_id}/feedback/{feedback_id}",
        },
    },
    "routers.workspace": {
        "router_attr": "workspace_router",
        "paths": {
            "/workspace/tokens/{token_id}",
            "/workspace/secrets/{name}",
            "/workspace/settings/{key}",
        },
    },
}


@pytest.mark.parametrize("module_name,cfg", list(AFFECTED.items()))
def test_router_imports_without_assertion_error(module_name, cfg):
    """Importing the router must not raise AssertionError (the startup crash)."""
    # Force re-import so we catch import-time errors even in cached test runs.
    sys.modules.pop(module_name, None)
    try:
        mod = importlib.import_module(module_name)
    except AssertionError as exc:
        pytest.fail(
            f"{module_name}: AssertionError on import — 204 route still has a "
            f"response model (the #1183 bug): {exc}"
        )
    assert hasattr(mod, cfg["router_attr"]), (
        f"{module_name} does not expose {cfg['router_attr']}"
    )


@pytest.mark.parametrize("module_name,cfg", list(AFFECTED.items()))
def test_204_routes_use_response_class_and_no_model(module_name, cfg):
    """Every status_code=204 route must have response_class=Response and no
    response_model — the invariant that prevents the AssertionError."""
    from starlette.responses import Response

    mod = importlib.import_module(module_name)
    router = getattr(mod, cfg["router_attr"])

    routes_204 = _204_routes(router)
    assert routes_204, f"{module_name}: no 204 routes found — test is stale?"

    for route in routes_204:
        if route.path not in cfg["paths"]:
            continue  # only check the routes listed in the issue
        assert route.response_class is Response, (
            f"{module_name} {route.path}: response_class must be Response, "
            f"got {route.response_class!r}"
        )
        assert route.response_model is None, (
            f"{module_name} {route.path}: response_model must be None "
            f"(got {route.response_model!r}) — FastAPI would AssertionError on "
            f"startup if a 204 route has a non-None response model"
        )


def test_full_app_starts_without_assertion_error():
    """The full FastAPI app (main.py) must import cleanly — no AssertionError."""
    sys.modules.pop("main", None)
    try:
        import main  # noqa: F401  (side-effect: registers all routes)
    except AssertionError as exc:
        pytest.fail(
            f"main.py raised AssertionError at import time — a 204 route still "
            f"has a response model (the #1183 startup crash): {exc}"
        )
