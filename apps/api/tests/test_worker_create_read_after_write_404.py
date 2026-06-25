"""Regression test for the worker-create read-after-write 404 (workeros-cloud#735).

Root cause: after the worker rows are persisted, _create_worker_from_parsed_payload
reads the worker back via _build_worker_detail. On the hosted (Supabase REST)
backend that immediate read can transiently return zero rows (read-after-write
consistency lag on a pooled PostgREST connection), so _build_worker_detail raises
HTTPException(404, "Worker not found"). The create route then re-raised the 404 and
its finally-block rollback DELETED the just-written worker, leaving an orphan
skill_version and a 404 for a worker that was momentarily fully created.

_build_worker_detail_after_write fixes this: because the persist already succeeded,
a 404 here can only be a transient miss, so it retries a bounded number of times
before giving up. A non-404 error, and a 404 that survives every retry, still
propagate unchanged (so a genuinely broken create still fails loud + rolls back).
"""

from __future__ import annotations

import os
import sys

import pytest
from fastapi import HTTPException

API_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from services import worker_create  # noqa: E402


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Don't actually sleep between retries in tests."""
    monkeypatch.setattr(worker_create.time, "sleep", lambda *_a, **_k: None)


def _flaky_detail(fail_times: int, sentinel: object):
    """Return a fake _build_worker_detail that raises 404 `fail_times` times
    then returns `sentinel`."""
    state = {"n": 0}

    def _fn(worker_id, *, user_id, repos):
        if state["n"] < fail_times:
            state["n"] += 1
            raise HTTPException(status_code=404, detail="Worker not found")
        return sentinel

    return _fn, state


def test_retries_transient_404_then_succeeds(monkeypatch):
    sentinel = object()
    fn, state = _flaky_detail(fail_times=2, sentinel=sentinel)
    monkeypatch.setattr(worker_create, "_build_worker_detail", fn)

    out = worker_create._build_worker_detail_after_write(
        "wkr-1", user_id="u", repos=object()
    )

    assert out is sentinel
    # 2 failures + 1 success
    assert state["n"] == 2


def test_succeeds_first_try_no_retry(monkeypatch):
    sentinel = object()
    calls = {"n": 0}

    def _fn(worker_id, *, user_id, repos):
        calls["n"] += 1
        return sentinel

    monkeypatch.setattr(worker_create, "_build_worker_detail", _fn)
    out = worker_create._build_worker_detail_after_write(
        "wkr-1", user_id="u", repos=object()
    )
    assert out is sentinel
    assert calls["n"] == 1


def test_persistent_404_eventually_raises(monkeypatch):
    """A 404 that NEVER clears must still propagate (so a genuinely broken
    create fails loud and rolls back) — but only after exhausting the retry
    budget."""
    calls = {"n": 0}

    def _always_404(worker_id, *, user_id, repos):
        calls["n"] += 1
        raise HTTPException(status_code=404, detail="Worker not found")

    monkeypatch.setattr(worker_create, "_build_worker_detail", _always_404)

    with pytest.raises(HTTPException) as excinfo:
        worker_create._build_worker_detail_after_write(
            "wkr-1", user_id="u", repos=object()
        )
    assert excinfo.value.status_code == 404
    # initial attempt + _READ_AFTER_WRITE_RETRIES retries
    assert calls["n"] == worker_create._READ_AFTER_WRITE_RETRIES + 1


def test_non_404_propagates_immediately(monkeypatch):
    """A non-404 (e.g. a real 500) must NOT be retried — it propagates on the
    first attempt."""
    calls = {"n": 0}

    def _raise_500(worker_id, *, user_id, repos):
        calls["n"] += 1
        raise HTTPException(status_code=500, detail="boom")

    monkeypatch.setattr(worker_create, "_build_worker_detail", _raise_500)

    with pytest.raises(HTTPException) as excinfo:
        worker_create._build_worker_detail_after_write(
            "wkr-1", user_id="u", repos=object()
        )
    assert excinfo.value.status_code == 500
    assert calls["n"] == 1
