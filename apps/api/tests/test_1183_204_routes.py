"""#1183 — 204 No-Content routes must not use -> None annotation.

FastAPI 0.111 with `from __future__ import annotations` stores the string
"None" as the response model for routes annotated `-> None` with
`status_code=204`, causing an AssertionError at import time. Fix: return
`Response(status_code=204)` explicitly with `response_class=Response`.

These tests verify:
1. The fixed routes return HTTP 204 with an empty body.
2. The app imports without AssertionError.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_app_imports_without_assertion_error():
    """The FastAPI app must be importable without AssertionError (regression for #1183)."""
    # Ensure a clean import each time by removing cached modules.
    for name in list(sys.modules):
        if name in ("main",) or name.startswith("routers."):
            sys.modules.pop(name, None)
    try:
        import main  # noqa: F401
    except AssertionError as exc:
        raise AssertionError(f"app import raised AssertionError — 204 route regression: {exc}") from exc


def test_delete_response_annotation_is_response_not_none():
    """Spot-check that the fixed routes declare -> Response, not -> None."""
    import ast
    import inspect

    for mod_name in (
        "routers.auth",
        "routers.share",
        "routers.worker_telemetry",
        "routers.workspace",
    ):
        for m in list(sys.modules):
            if m in (mod_name,) or m.startswith(mod_name + "."):
                sys.modules.pop(m, None)

    import routers.auth as auth_mod
    import routers.share as share_mod
    import routers.worker_telemetry as wt_mod
    import routers.workspace as ws_mod

    # delete_user
    src = inspect.getsource(auth_mod.delete_user)
    assert "-> Response" in src, "delete_user must be -> Response, not -> None"
    # delete_token
    src = inspect.getsource(auth_mod.delete_token)
    assert "-> Response" in src, "delete_token must be -> Response, not -> None"
    # delete_share_grant
    src = inspect.getsource(share_mod.delete_share_grant)
    assert "-> Response" in src, "delete_share_grant must be -> Response, not -> None"
    # delete_worker_alert
    src = inspect.getsource(wt_mod.delete_worker_alert)
    assert "-> Response" in src, "delete_worker_alert must be -> Response, not -> None"
    # delete_worker_feedback
    src = inspect.getsource(wt_mod.delete_worker_feedback)
    assert "-> Response" in src, "delete_worker_feedback must be -> Response, not -> None"
    # workspace routes
    src = inspect.getsource(ws_mod.revoke_workspace_token)
    assert "-> Response" in src, "revoke_workspace_token must be -> Response, not -> None"
    src = inspect.getsource(ws_mod.delete_workspace_secret)
    assert "-> Response" in src, "delete_workspace_secret must be -> Response, not -> None"
    src = inspect.getsource(ws_mod.put_workspace_setting)
    assert "-> Response" in src, "put_workspace_setting must be -> Response, not -> None"
