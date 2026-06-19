"""#994 — worker-to-worker call depth cap is actually enforced.

Before: every child token was minted with depth=0 and token-path child runs
got trigger_source "worker_call" (no depth), so the cap never accumulated and
script workers could recurse without bound. Now depth threads through the
token + trigger_source, the API boundary rejects child creation once the
holder token is at the cap, and minting beyond the cap raises.

Run: cd apps/api && python -m pytest tests/test_994_call_depth_cap.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


class TestParseCallDepth:
    def test_both_markers_parse(self):
        from run_token import parse_call_depth

        assert parse_call_depth("worker_call:depth=2") == 2
        assert parse_call_depth("invoke_worker:depth=3") == 3
        assert parse_call_depth("worker_call") == 0
        assert parse_call_depth("manual") == 0
        assert parse_call_depth(None) == 0
        assert parse_call_depth("worker_call:depth=garbage") == 0


class TestMintBackstop:
    def test_issue_rejects_beyond_cap(self, monkeypatch):
        from run_token import issue_worker_call_token, WorkerCallDepthExceeded, MAX_CALL_DEPTH

        monkeypatch.setenv("FLOOM_SECRET", "s")
        # at the cap is allowed (that run still holds a valid token; it just
        # can't create more children — enforced at the API boundary)
        issue_worker_call_token(user_id="u", parent_run_id="r", callable_workers=["w"], depth=MAX_CALL_DEPTH)
        # beyond the cap is refused
        with pytest.raises(WorkerCallDepthExceeded):
            issue_worker_call_token(user_id="u", parent_run_id="r", callable_workers=["w"], depth=MAX_CALL_DEPTH + 1)

    def test_depth_round_trips_in_token(self, monkeypatch):
        from run_token import issue_worker_call_token, validate_worker_call_token

        monkeypatch.setenv("FLOOM_SECRET", "s")
        tok = issue_worker_call_token(user_id="u", parent_run_id="r", callable_workers=["w"], depth=2)
        assert validate_worker_call_token(tok)["depth"] == 2


class TestApiBoundaryGate:
    def _allows(self, depth):
        import main
        from run_token import MAX_CALL_DEPTH  # noqa

        return main._worker_call_token_allows_request(
            path="/workers/child/runs",
            method="POST",
            token_payload={"depth": depth, "parent_run_id": "r"},
            repos=None,
        )

    def test_under_cap_allowed(self, monkeypatch, tmp_path):
        _boot(monkeypatch, tmp_path)
        assert self._allows(0) is True
        assert self._allows(2) is True

    def test_at_or_over_cap_rejected(self, monkeypatch, tmp_path):
        _boot(monkeypatch, tmp_path)
        from run_token import MAX_CALL_DEPTH

        assert self._allows(MAX_CALL_DEPTH) is False
        assert self._allows(MAX_CALL_DEPTH + 5) is False


class TestChildTriggerSourceCarriesDepth:
    def test_metadata_increments_depth(self, monkeypatch, tmp_path):
        main = _boot(monkeypatch, tmp_path)
        import types

        auth = types.SimpleNamespace(
            auth_method="run_token",
            run_token_payload={"parent_run_id": "r1", "depth": 1},
        )
        ts, ref = main._worker_call_run_metadata(auth)
        assert ts == "worker_call:depth=2"  # holder depth 1 → child depth 2
        assert ref == "r1"

    def test_root_call_is_depth_1(self, monkeypatch, tmp_path):
        main = _boot(monkeypatch, tmp_path)
        import types

        auth = types.SimpleNamespace(
            auth_method="run_token",
            run_token_payload={"parent_run_id": "r0", "depth": 0},
        )
        ts, _ = main._worker_call_run_metadata(auth)
        assert ts == "worker_call:depth=1"


def _boot(monkeypatch, tmp_path):
    import importlib
    import types

    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    (tmp_path / "workers").mkdir(exist_ok=True)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", "s")
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service") or name.startswith(("routers", "services", "core", "db", "auth", "contexts", "runner_sandbox")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(start_scheduler=lambda: None, stop_scheduler=lambda: None)
    return importlib.import_module("main")
