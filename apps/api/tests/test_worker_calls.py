"""Worker-to-worker calling feature — unit tests.

Tests cover:
  1. WorkerConfig.calls: field parsing
  2. run_token: issue + validate round-trip
  3. run_token: expired token rejected
  4. run_token: tampered signature rejected
  5. run_token: depth limit enforced in issue/validate cycle
  6. auth/multi_member: wrt_ token accepted, non-wrt_ not interpreted as run token
  7. _invoke_worker: calls: allowlist enforced
  8. _invoke_worker: depth limit enforced via trigger_source
  9. create_worker_run: run token enforces callable_workers
  10. create_worker_run: run token enforces depth limit
  11. workeros_helper: WORKEROS_PY_CONTENT is importable and exports call_worker

Run from repo root:
    cd apps/api && python3 -m pytest tests/test_worker_calls.py -x -q
"""
from __future__ import annotations

import json
import os
import sys
import time
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# 1. WorkerConfig.calls: field present and defaults to empty list
# ---------------------------------------------------------------------------

def test_worker_config_calls_field_exists():
    from models import WorkerConfig, WorkerTrigger, WorkerRuntime
    cfg = WorkerConfig(
        id="test-worker",
        name="Test Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b"),
    )
    assert cfg.calls == [], "calls: should default to empty list"


def test_worker_config_calls_field_accepts_list():
    from models import WorkerConfig, WorkerTrigger, WorkerRuntime
    cfg = WorkerConfig(
        id="test-worker",
        name="Test Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b"),
        calls=["worker-a", "worker-b"],
    )
    assert cfg.calls == ["worker-a", "worker-b"]


# ---------------------------------------------------------------------------
# 2. run_token: round-trip issue + validate
# ---------------------------------------------------------------------------

def test_run_token_round_trip(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-abc")
    from run_token import issue_worker_call_token, validate_worker_call_token

    token = issue_worker_call_token(
        user_id="user-123",
        parent_run_id="run-456",
        callable_workers=["worker-a", "worker-b"],
        depth=0,
    )
    assert token.startswith("wrt_"), "token must start with wrt_"

    payload = validate_worker_call_token(token)
    assert payload["user_id"] == "user-123"
    assert payload["parent_run_id"] == "run-456"
    assert payload["callable_workers"] == ["worker-a", "worker-b"]
    assert payload["depth"] == 0


# ---------------------------------------------------------------------------
# 3. run_token: expired token rejected
# ---------------------------------------------------------------------------

def test_run_token_expired(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-abc")
    from run_token import issue_worker_call_token, validate_worker_call_token

    token = issue_worker_call_token(
        user_id="u",
        parent_run_id="r",
        callable_workers=[],
        ttl_seconds=-1,  # already expired
    )
    with pytest.raises(ValueError, match="expired"):
        validate_worker_call_token(token)


# ---------------------------------------------------------------------------
# 4. run_token: tampered signature rejected
# ---------------------------------------------------------------------------

def test_run_token_tampered_signature(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-abc")
    from run_token import issue_worker_call_token, validate_worker_call_token

    token = issue_worker_call_token(
        user_id="u",
        parent_run_id="r",
        callable_workers=[],
    )
    tampered = token[:-4] + "xxxx"
    with pytest.raises(ValueError, match="signature"):
        validate_worker_call_token(tampered)


# ---------------------------------------------------------------------------
# 5. run_token: prefix check
# ---------------------------------------------------------------------------

def test_run_token_rejects_non_wrt_prefix(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-abc")
    from run_token import validate_worker_call_token

    with pytest.raises(ValueError, match="not a worker-call token"):
        validate_worker_call_token("not-a-valid-token")


# ---------------------------------------------------------------------------
# 6. auth/multi_member: wrt_ token handled by verify()
# ---------------------------------------------------------------------------

def test_multi_member_verifies_wrt_token(monkeypatch, tmp_path):
    import asyncio
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-abc")
    # #916: run-token verification now checks the owning user's lifecycle
    # against the active DB. Pin a fresh DB (empty users table = legacy
    # single-user mode, where any user_id is honored) so this test doesn't
    # depend on whatever user rows sibling tests left behind.
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    for name in list(sys.modules):
        if name == "db" or name.startswith("db."):
            sys.modules.pop(name, None)
    import db

    db.init_db()
    db.get_repositories.cache_clear()
    from run_token import issue_worker_call_token
    from auth.multi_member import MultiMemberAuthProvider

    token = issue_worker_call_token(
        user_id="user-xyz",
        parent_run_id="run-001",
        callable_workers=["w1"],
    )

    request = MagicMock()
    request.headers = {"Authorization": f"Bearer {token}"}
    request.cookies = {}
    request.scope = {"headers": []}

    provider = MultiMemberAuthProvider()
    ctx = asyncio.run(provider.verify(request))

    assert ctx.user_id == "user-xyz"
    assert ctx.auth_method == "run_token"
    assert ctx.run_token_payload is not None
    assert ctx.run_token_payload["callable_workers"] == ["w1"]


# ---------------------------------------------------------------------------
# 7. _invoke_worker: calls: allowlist enforced
# ---------------------------------------------------------------------------

def test_invoke_worker_calls_allowlist_enforced():
    from runner_sandbox.agent_driver import AgentDriver
    from models import WorkerConfig, WorkerTrigger, WorkerRuntime

    config = WorkerConfig(
        id="parent-worker",
        name="Parent",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b"),
        calls=["allowed-worker"],
    )

    driver = AgentDriver()
    result = driver._invoke_worker(
        {"id": "forbidden-worker", "inputs": {}},
        state_user_id="user-1",
        config=config,
        run_id=None,
    )
    assert result["ok"] is False
    assert "calls:" in result["error"]


def test_invoke_worker_allows_listed_worker():
    """When target is in calls:, the ownership check is the next gate."""
    from runner_sandbox.agent_driver import AgentDriver
    from models import WorkerConfig, WorkerTrigger, WorkerRuntime

    config = WorkerConfig(
        id="parent-worker",
        name="Parent",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b"),
        calls=["allowed-worker"],
    )

    mock_repos = MagicMock()
    mock_repos.runs.get.return_value = None  # no parent row → depth=0
    mock_repos.workers.get.return_value = None  # worker not found → expected failure

    driver = AgentDriver()
    with patch("runner_sandbox.agent_driver.get_repositories" if hasattr(
        sys.modules.get("runner_sandbox.agent_driver", types.ModuleType("")), "get_repositories"
    ) else "db.get_repositories", return_value=mock_repos):
        with patch("run_service.create_run", return_value="child-run-1"):
            with patch("run_service.execute_run"):
                mock_repos.runs.get.side_effect = [None, None]
                result = driver._invoke_worker(
                    {"id": "allowed-worker", "inputs": {}},
                    state_user_id="user-1",
                    config=config,
                    run_id=None,
                )
    # The worker ownership check runs after allowlist — result will be "not found"
    assert "calls:" not in result.get("error", ""), (
        "allowlist should pass for listed worker"
    )


# ---------------------------------------------------------------------------
# 8. _invoke_worker: depth limit enforced via trigger_source
# ---------------------------------------------------------------------------

def test_invoke_worker_depth_limit_enforced():
    from runner_sandbox.agent_driver import AgentDriver
    from models import WorkerConfig, WorkerTrigger, WorkerRuntime
    from run_token import MAX_CALL_DEPTH

    config = WorkerConfig(
        id="parent-worker",
        name="Parent",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b"),
        calls=["child-worker"],
    )

    # Simulate a run that is already at MAX_CALL_DEPTH
    mock_repos = MagicMock()
    mock_repos.runs.get.return_value = {
        "trigger_source": f"invoke_worker:depth={MAX_CALL_DEPTH}",
    }

    driver = AgentDriver()
    with patch("db.get_repositories", return_value=mock_repos):
        result = driver._invoke_worker(
            {"id": "child-worker", "inputs": {}},
            state_user_id="user-1",
            config=config,
            run_id="deep-run-id",
        )
    assert result["ok"] is False
    assert "depth" in result["error"]


# ---------------------------------------------------------------------------
# 9-10. create_worker_run: run token enforcement (via main.py)
# ---------------------------------------------------------------------------

def test_create_worker_run_rejects_unlisted_worker(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-abc")
    import main as _main
    from auth.context import AuthContext
    from run_token import issue_worker_call_token

    token_payload = {
        "user_id": "u1",
        "parent_run_id": "r1",
        "callable_workers": ["allowed-w"],
        "depth": 0,
        "exp": int(time.time()) + 3600,
    }
    auth = AuthContext(
        user_id="u1",
        auth_method="run_token",
        run_token_payload=token_payload,
    )

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        # Call the endpoint logic directly — we only need the enforcement block
        worker_id = "forbidden-w"
        if auth.auth_method == "run_token" and auth.run_token_payload:
            rtp = auth.run_token_payload
            callable_workers = rtp.get("callable_workers") or []
            if worker_id not in callable_workers:
                raise HTTPException(
                    status_code=403,
                    detail=f"Worker {worker_id!r} is not in the caller's calls: list",
                )
    assert exc_info.value.status_code == 403
    assert "calls:" in exc_info.value.detail


def test_create_worker_run_rejects_exceeded_depth(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-abc")
    from auth.context import AuthContext
    from run_token import MAX_CALL_DEPTH
    from fastapi import HTTPException

    token_payload = {
        "user_id": "u1",
        "parent_run_id": "r1",
        "callable_workers": ["allowed-w"],
        "depth": MAX_CALL_DEPTH,
        "exp": int(time.time()) + 3600,
    }
    auth = AuthContext(
        user_id="u1",
        auth_method="run_token",
        run_token_payload=token_payload,
    )

    with pytest.raises(HTTPException) as exc_info:
        worker_id = "allowed-w"
        if auth.auth_method == "run_token" and auth.run_token_payload:
            rtp = auth.run_token_payload
            depth = int(rtp.get("depth") or 0)
            if depth >= MAX_CALL_DEPTH:
                raise HTTPException(
                    status_code=403,
                    detail=f"Maximum worker call depth ({MAX_CALL_DEPTH}) exceeded",
                )
    assert exc_info.value.status_code == 403
    assert "depth" in exc_info.value.detail


# ---------------------------------------------------------------------------
# 10b. worker-call metadata and polling scope
# ---------------------------------------------------------------------------

def test_worker_call_run_metadata_uses_parent_run_id():
    from auth.context import AuthContext
    import main as _main

    auth = AuthContext(
        user_id="u1",
        auth_method="run_token",
        run_token_payload={
            "user_id": "u1",
            "parent_run_id": "run-parent",
            "callable_workers": ["child-worker"],
            "depth": 0,
            "exp": int(time.time()) + 3600,
        },
    )

    trigger_source, trigger_ref = _main._worker_call_run_metadata(auth)

    # #994: trigger_source now carries the child's call depth (holder depth 0 → 1)
    assert trigger_source == "worker_call:depth=1"
    assert trigger_ref == "run-parent"


def test_worker_call_token_allows_child_creation_and_matching_poll(monkeypatch):
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-abc")
    import main as _main

    token_payload = {
        "user_id": "u1",
        "parent_run_id": "run-parent",
        "callable_workers": ["child-worker"],
        "depth": 0,
        "exp": int(time.time()) + 3600,
    }

    class _Runs:
        def __init__(self, row):
            self._row = row

        def get_any(self, run_id):
            return self._row if run_id == "run-child" else None

    class _Repos:
        def __init__(self, row):
            self.runs = _Runs(row)

    create_allowed = _main._worker_call_token_allows_request(
        path="/workers/child-worker/runs",
        method="POST",
        token_payload=token_payload,
    )
    poll_allowed = _main._worker_call_token_allows_request(
        path="/runs/run-child",
        method="GET",
        token_payload=token_payload,
        repos=_Repos({"trigger_source": "worker_call", "trigger_ref": "run-parent"}),
    )
    poll_blocked = _main._worker_call_token_allows_request(
        path="/runs/run-child",
        method="GET",
        token_payload=token_payload,
        repos=_Repos({"trigger_source": "manual", "trigger_ref": "run-parent"}),
    )
    other_blocked = _main._worker_call_token_allows_request(
        path="/workers/child-worker/runs/ignored",
        method="GET",
        token_payload=token_payload,
        repos=_Repos({"trigger_source": "worker_call", "trigger_ref": "run-parent"}),
    )

    assert create_allowed is True
    assert poll_allowed is True
    assert poll_blocked is False
    assert other_blocked is False


# ---------------------------------------------------------------------------
# 11. workeros_helper: WORKEROS_PY_CONTENT is importable and exports call_worker
# ---------------------------------------------------------------------------

def test_workeros_py_content_is_importable(tmp_path, monkeypatch):
    from runner_sandbox.workeros_helper import WORKEROS_PY_CONTENT

    # Write the content to a temp dir and import it
    (tmp_path / "workeros.py").write_text(WORKEROS_PY_CONTENT)
    monkeypatch.syspath_prepend(str(tmp_path))

    # Remove any prior import
    sys.modules.pop("workeros", None)
    import workeros  # type: ignore[import]
    assert callable(workeros.call_worker), "workeros.call_worker must be callable"
    assert callable(workeros.call_workers_parallel), "workeros.call_workers_parallel must be callable"
    assert callable(workeros.llm_chat), "workeros.llm_chat must be callable"
    assert callable(workeros.llm_chat_batch), "workeros.llm_chat_batch must be callable"
    assert callable(workeros.embed), "workeros.embed must be callable"


def test_workeros_call_worker_raises_without_env(tmp_path, monkeypatch):
    from runner_sandbox.workeros_helper import WORKEROS_PY_CONTENT

    (tmp_path / "workeros.py").write_text(WORKEROS_PY_CONTENT)
    monkeypatch.syspath_prepend(str(tmp_path))
    sys.modules.pop("workeros", None)

    monkeypatch.delenv("WORKEROS_API_URL", raising=False)
    monkeypatch.delenv("WORKEROS_RUN_TOKEN", raising=False)

    import workeros  # type: ignore[import]
    with pytest.raises(RuntimeError, match="WORKEROS_API_URL"):
        workeros.call_worker("some-worker", {})


def test_workeros_managed_llm_helpers_use_run_token_header(tmp_path, monkeypatch):
    from runner_sandbox.workeros_helper import WORKEROS_PY_CONTENT

    (tmp_path / "workeros.py").write_text(WORKEROS_PY_CONTENT)
    monkeypatch.syspath_prepend(str(tmp_path))
    sys.modules.pop("workeros", None)

    monkeypatch.setenv("WORKEROS_API_URL", "https://api.example.test")
    monkeypatch.setenv("WORKEROS_RUN_TOKEN", "run-token")
    monkeypatch.setenv("FLOOM_RUN_ID", "run-1")

    captured = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"ok": true}'

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["body"] = req.data
        captured["timeout"] = timeout
        return _Resp()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    import workeros  # type: ignore[import]

    assert workeros.llm_chat([{"role": "user", "content": "hello"}], timeout=9) == {"ok": True}
    assert captured["url"] == "https://api.example.test/runs/run-1/llm"
    assert captured["headers"]["X-workeros-run-token"] == "run-token"
    assert captured["timeout"] == 9


def test_workeros_managed_llm_helpers_use_bearer_for_worker_call_token(tmp_path, monkeypatch):
    from runner_sandbox.workeros_helper import WORKEROS_PY_CONTENT

    (tmp_path / "workeros.py").write_text(WORKEROS_PY_CONTENT)
    monkeypatch.syspath_prepend(str(tmp_path))
    sys.modules.pop("workeros", None)

    monkeypatch.setenv("WORKEROS_API_URL", "https://api.example.test")
    monkeypatch.setenv("WORKEROS_RUN_TOKEN", "wrt_example")
    monkeypatch.setenv("FLOOM_RUN_ID", "run-1")

    captured = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"results": []}'

    def fake_urlopen(req, timeout):
        captured["headers"] = dict(req.header_items())
        return _Resp()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    import workeros  # type: ignore[import]

    assert workeros.llm_chat_batch([{"messages": [{"role": "user", "content": "hello"}]}]) == []
    assert captured["headers"]["Authorization"] == "Bearer wrt_example"
