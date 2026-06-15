"""#264 — MCP read tools must not leak another tenant's worker via the shared
filesystem in cloud mode.

Root cause: the PUBLIC_STOCK_WORKER_IDS on-disk bypass in services.worker_access
(_list_visible_workers -> _stock_workers_from_filesystem, _get_visible_worker,
_worker_hidden_from_api, _worker_source_visible_to_api) read the engine's
vendored WORKERS_DIR unconditionally. On cloud that shared directory holds the
vendored engine tenant's bundles (localtest), so a PAT scoped to an UNRELATED,
empty workspace received those workers — including full source — through
workers.list / workers.get.

These tests pin the fix at the access-layer (the single choke point every MCP
read tool funnels through), so they need no Supabase: a stub Repositories that
returns ZERO DB workers means anything that surfaces is, by definition, the
filesystem bypass leaking.

Run: cd apps/api && python -m pytest tests/test_mcp_cross_tenant_fs_leak_264.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


_ENGINE_WORKERS_DIR = API_DIR.parents[1] / "workers"


@pytest.fixture(autouse=True)
def _pin_engine_workers_dir(monkeypatch):
    """Make these tests hermetic regardless of sibling-test ordering.

    The full suite has tests that repoint FLOOM_WORKERS_DIR / reload
    worker_registry, leaving WORKERS_DIR (bound at import time) and the
    discover_workers cache pointing somewhere else. Pin both to this checkout's
    real engine workers/ dir and clear the caches so the on-disk stock workers
    are deterministically present (the whole point of an FS-leak test).
    """
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(_ENGINE_WORKERS_DIR))
    import worker_registry as _wr

    importlib.reload(_wr)
    _wr.discover_workers.cache_clear() if hasattr(_wr.discover_workers, "cache_clear") else None
    yield


@pytest.fixture()
def wa():
    wa_mod = importlib.import_module("services.worker_access")
    wa_mod._tracked_worker_ids.cache_clear()
    return wa_mod


class _EmptyWorkerRepo:
    """A workspace-scoped repo for a tenant that owns ZERO workers."""

    def list(self, *, user_id, role=None):
        return []

    def get(self, *, user_id, worker_id, role=None):
        return None

    def get_any(self, *, worker_id):
        # get_any is a global existence check; the grants path is not exercised
        # here (no grants seeded), so return None.
        return None

    def get_owner(self, *, worker_id):
        return None


class _StubRepos:
    def __init__(self):
        self.workers = _EmptyWorkerRepo()


def _a_stock_id(wa):
    from core.config import PUBLIC_STOCK_WORKER_IDS

    # Pick a stock id that actually exists on disk in this checkout.
    from worker_registry import discover_workers

    on_disk = {w["id"] for w in discover_workers(use_cache=False)}
    candidates = sorted(PUBLIC_STOCK_WORKER_IDS & on_disk)
    assert candidates, "no PUBLIC_STOCK_WORKER_IDS present on disk to test with"
    return candidates[0]


# ---------------------------------------------------------------------------
# Gating predicate
# ---------------------------------------------------------------------------

def test_stock_fs_disabled_on_cloud(wa, monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    assert wa._stock_filesystem_workers_allowed() is False


def test_stock_fs_enabled_off_cloud(wa, monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    assert wa._stock_filesystem_workers_allowed() is True


# ---------------------------------------------------------------------------
# workers.list path (_list_visible_workers)
# ---------------------------------------------------------------------------

def test_list_visible_workers_no_fs_leak_on_cloud(wa, monkeypatch):
    """A tenant with zero DB workers must see NOTHING on cloud — the on-disk
    stock workers belong to the vendored engine tenant, not this workspace."""
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    wa._tracked_worker_ids.cache_clear()
    visible = wa._list_visible_workers(user_id="lonely-tenant", repos=_StubRepos())
    assert visible == [], (
        f"cross-tenant FS workers leaked into workers.list on cloud: "
        f"{[w.get('id') for w in visible]}"
    )


def test_list_visible_workers_shows_stock_off_cloud(wa, monkeypatch):
    """Off-cloud (OSS single-tenant) the stock-template UX is preserved."""
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    wa._tracked_worker_ids.cache_clear()
    stock_id = _a_stock_id(wa)
    visible = wa._list_visible_workers(user_id="federico", repos=_StubRepos())
    ids = {w["id"] for w in visible}
    assert stock_id in ids, (
        f"stock template {stock_id} must still surface off-cloud; got {sorted(ids)}"
    )


# ---------------------------------------------------------------------------
# workers.get path (_get_visible_worker)
# ---------------------------------------------------------------------------

def test_get_visible_worker_denied_on_cloud(wa, monkeypatch):
    """workers.get for a stock id by a non-owner tenant must 404 (None) on cloud
    instead of returning the vendored engine tenant's worker + full source."""
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    wa._tracked_worker_ids.cache_clear()
    stock_id = _a_stock_id(wa)
    got = wa._get_visible_worker(stock_id, user_id="lonely-tenant", repos=_StubRepos())
    assert got is None, (
        f"workers.get leaked cross-tenant FS worker {stock_id!r} on cloud"
    )


def test_get_visible_worker_allowed_off_cloud(wa, monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    wa._tracked_worker_ids.cache_clear()
    stock_id = _a_stock_id(wa)
    got = wa._get_visible_worker(stock_id, user_id="federico", repos=_StubRepos())
    assert got is not None and got.get("id") == stock_id


# ---------------------------------------------------------------------------
# source disclosure + hidden-from-api predicates
# ---------------------------------------------------------------------------

def test_stock_source_hidden_on_cloud(wa, monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    wa._tracked_worker_ids.cache_clear()
    stock_id = _a_stock_id(wa)
    assert wa._worker_source_visible_to_api(stock_id) is False


def test_stock_source_visible_off_cloud(wa, monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    wa._tracked_worker_ids.cache_clear()
    stock_id = _a_stock_id(wa)
    assert wa._worker_source_visible_to_api(stock_id) is True


def test_stock_workers_from_filesystem_empty_on_cloud(wa, monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    assert wa._stock_workers_from_filesystem(use_cache=False) == []


def test_stock_workers_from_filesystem_nonempty_off_cloud(wa, monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    assert len(wa._stock_workers_from_filesystem(use_cache=False)) > 0
