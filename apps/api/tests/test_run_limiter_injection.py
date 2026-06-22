"""Pluggable distributed run-limiter seam.

The in-process threading.Semaphore in run_service only bounds concurrency within
one process; a horizontally-scaled deployment injects a distributed limiter so
the E2B sandbox budget is honored across all processes. This verifies the
injection seam: when a limiter is registered for a budget, _get_semaphore /
_get_llm_semaphore return it (and the free-slot helper uses it); when cleared,
they fall back to the in-process semaphore (OSS/single-node default unchanged).

Run: cd apps/api && python -m pytest tests/test_run_limiter_injection.py -q
"""
from __future__ import annotations

import importlib
import sys
import threading
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture()
def run_service():
    rs = importlib.import_module("run_service")
    rs.clear_run_limiters()
    yield rs
    rs.clear_run_limiters()  # never leak an injected limiter into other tests


class _FakeLimiter:
    """Minimal threading.Semaphore-contract limiter that records calls."""

    def __init__(self, capacity: int):
        self.capacity = capacity
        self.held = 0
        self.acquires = 0
        self.releases = 0
        self._lock = threading.Lock()

    def acquire(self, blocking: bool = False) -> bool:
        with self._lock:
            self.acquires += 1
            if self.held >= self.capacity:
                return False
            self.held += 1
            return True

    def release(self) -> None:
        with self._lock:
            self.releases += 1
            self.held = max(0, self.held - 1)

    def available_count(self) -> int:
        with self._lock:
            return max(0, self.capacity - self.held)


def test_default_is_in_process_semaphore(run_service):
    assert isinstance(run_service._get_semaphore(), threading.Semaphore)
    assert isinstance(run_service._get_llm_semaphore(), threading.Semaphore)


def test_injected_limiter_is_used(run_service):
    runs = _FakeLimiter(2)
    llm = _FakeLimiter(1)
    run_service.register_run_limiter("runs", runs)
    run_service.register_run_limiter("llm_runs", llm)

    assert run_service._get_semaphore() is runs
    assert run_service._get_llm_semaphore() is llm

    # acquire/release delegate to the injected object
    assert run_service._get_semaphore().acquire(blocking=False) is True
    assert run_service._get_semaphore().acquire(blocking=False) is True
    assert run_service._get_semaphore().acquire(blocking=False) is False  # cap=2
    run_service._get_semaphore().release()
    assert run_service._get_semaphore().acquire(blocking=False) is True
    assert runs.acquires == 4 and runs.releases == 1


def test_available_count_uses_injected(run_service):
    runs = _FakeLimiter(5)
    run_service.register_run_limiter("runs", runs)
    assert run_service._semaphore_available_count() == 5
    runs.acquire()
    runs.acquire()
    assert run_service._semaphore_available_count() == 3


class _MinimalLimiter:
    """Contract-minimal limiter: only acquire/release, no optional
    available_count() (the seam documents available_count as optional)."""

    def acquire(self, blocking: bool = False) -> bool:
        return True

    def release(self) -> None:
        pass


class _RaisingCountLimiter(_MinimalLimiter):
    """Limiter whose optional available_count() raises (best-effort path)."""

    def available_count(self) -> int:
        raise RuntimeError("backend unavailable")


def test_available_count_unknown_without_optional_method(run_service):
    # A limiter honoring only the required acquire/release contract has no
    # countable free-slot source, so the helper reports -1 (unknown) instead
    # of reaching into the injected object's internals.
    run_service.register_run_limiter("runs", _MinimalLimiter())
    assert run_service._semaphore_available_count() == -1


def test_available_count_unknown_when_optional_method_raises(run_service):
    # available_count() is best-effort: a raising backend must not propagate;
    # the helper degrades to -1 (unknown).
    run_service.register_run_limiter("runs", _RaisingCountLimiter())
    assert run_service._semaphore_available_count() == -1


def test_clear_reverts_to_semaphore(run_service):
    run_service.register_run_limiter("runs", _FakeLimiter(1))
    assert isinstance(run_service._get_semaphore(), _FakeLimiter)
    run_service.clear_run_limiters()
    assert isinstance(run_service._get_semaphore(), threading.Semaphore)
