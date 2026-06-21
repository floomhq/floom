"""Regression guard for worker-author registration smoke placement."""
from __future__ import annotations

import inspect
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service  # noqa: E402
from services.run_authoring import _register_authored_worker  # noqa: E402


def test_worker_author_smoke_runs_only_after_worker_id_exists():
    src = inspect.getsource(run_service)
    created_idx = src.index("if created_worker_id:")
    smoke_idx = src.index("smoke_and_gate_generated_worker(")
    else_idx = src.index('outputs["worker_creation_failed"] = True', created_idx)

    assert created_idx < smoke_idx < else_idx


def test_worker_author_registration_logs_missing_bundle_artifact():
    logs: list[tuple[str, str]] = []

    created = _register_authored_worker(
        "run-missing-bundle",
        {"bundle": "out/bundle.json"},
        [{"name": "bundle.json", "relative_path": "out/bundle.json", "path": "/tmp/does-not-exist"}],
        user_id="user-1",
        repos=None,
        log_fn=lambda message, level="info": logs.append((level, message)),
    )

    assert created is None
    assert any("worker-author registration: entered" in message for _level, message in logs)
    assert any("worker-author produced no bundle.json" in message for _level, message in logs)
    assert any("exists=False" in message for _level, message in logs)

