"""Regression guard for worker-author registration smoke placement."""
from __future__ import annotations

import inspect
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service  # noqa: E402


def test_worker_author_smoke_runs_only_after_worker_id_exists():
    src = inspect.getsource(run_service)
    created_idx = src.index("if created_worker_id:")
    smoke_idx = src.index("smoke_and_gate_generated_worker(")
    else_idx = src.index('outputs["worker_creation_failed"] = True', created_idx)

    assert created_idx < smoke_idx < else_idx

