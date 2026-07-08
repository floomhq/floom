"""Transient cancel-flag read failures must not cancel a run.

Regression for the 2026-07-08 cloud incident: agent runs died mid-turn with
"Run cancelled by user" while their DB row had cancel_requested=false —
``run_cancel_requested`` treated every failed/blank repository read as a
cancel signal, and the streaming loop polls it constantly. Only a streak of
consecutive failures may cancel; one successful read resets the streak.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _fresh_cancellation():
    sys.modules.pop("runner_sandbox.cancellation", None)
    return importlib.import_module("runner_sandbox.cancellation")


def _install_fake_db(monkeypatch, get_any):
    runs = types.SimpleNamespace(get_any=get_any)
    repos = types.SimpleNamespace(runs=runs)
    fake_db = types.SimpleNamespace(get_repositories=lambda: repos)
    monkeypatch.setitem(sys.modules, "db", fake_db)


def test_single_read_exception_does_not_cancel(monkeypatch):
    cancellation = _fresh_cancellation()
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    calls = {"n": 0}

    def get_any(run_id):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("transient pool blip")
        return {"id": run_id, "cancel_requested": False}

    _install_fake_db(monkeypatch, get_any)

    assert cancellation.run_cancel_requested("run_x") is False  # blip swallowed
    assert cancellation.run_cancel_requested("run_x") is False  # healthy read


def test_streak_of_failures_cancels(monkeypatch):
    cancellation = _fresh_cancellation()
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    def get_any(run_id):
        raise ConnectionError("persistent outage")

    _install_fake_db(monkeypatch, get_any)

    threshold = cancellation._CANCEL_READ_FAILURE_STREAK_THRESHOLD
    for _ in range(threshold - 1):
        assert cancellation.run_cancel_requested("run_x") is False
    assert cancellation.run_cancel_requested("run_x") is True


def test_successful_read_resets_streak(monkeypatch):
    cancellation = _fresh_cancellation()
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    calls = {"n": 0}

    def get_any(run_id):
        calls["n"] += 1
        # fail, fail, succeed, fail, fail, succeed, ... never 3 in a row
        if calls["n"] % 3 != 0:
            raise ConnectionError("intermittent")
        return {"id": run_id, "cancel_requested": False}

    _install_fake_db(monkeypatch, get_any)

    for _ in range(9):
        assert cancellation.run_cancel_requested("run_x") is False


def test_missing_row_in_cloud_needs_streak(monkeypatch):
    cancellation = _fresh_cancellation()
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    _install_fake_db(monkeypatch, lambda run_id: None)

    threshold = cancellation._CANCEL_READ_FAILURE_STREAK_THRESHOLD
    for _ in range(threshold - 1):
        assert cancellation.run_cancel_requested("run_x") is False
    assert cancellation.run_cancel_requested("run_x") is True


def test_missing_row_outside_cloud_never_cancels(monkeypatch):
    cancellation = _fresh_cancellation()
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")

    _install_fake_db(monkeypatch, lambda run_id: None)

    for _ in range(10):
        assert cancellation.run_cancel_requested("run_x") is False


def test_real_cancel_flag_still_fires_immediately(monkeypatch):
    cancellation = _fresh_cancellation()
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    _install_fake_db(monkeypatch, lambda run_id: {"id": run_id, "cancel_requested": True})

    assert cancellation.run_cancel_requested("run_x") is True


def test_streaks_are_per_run(monkeypatch):
    cancellation = _fresh_cancellation()
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    def get_any(run_id):
        raise ConnectionError("outage")

    _install_fake_db(monkeypatch, get_any)

    threshold = cancellation._CANCEL_READ_FAILURE_STREAK_THRESHOLD
    for _ in range(threshold - 1):
        assert cancellation.run_cancel_requested("run_a") is False
    # run_b's streak is independent of run_a's accumulated failures
    assert cancellation.run_cancel_requested("run_b") is False
