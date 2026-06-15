"""Cloud-side regression for issue #264: FS stock-worker cross-tenant leak.

The engine fix gates the on-disk ``PUBLIC_STOCK_WORKER_IDS`` bypass behind
``_stock_filesystem_workers_allowed()`` (== ``not _is_cloud_deploy()``) in
``engine/apps/api/services/worker_access.py``. On cloud the shared WORKERS_DIR
holds the vendored engine tenant's bundles, so a non-member must NOT be able to
read those private workers / source / secret-names via the FS resolver.

The engine ships its own regression test; this cloud-side test pins the contract
against the vendored engine the cloud actually deploys, so a future engine bump
cannot silently re-enable the FS bypass on cloud. The conftest already forces
WORKEROS_DEPLOY=cloud and resets the cloud caches; we assert the deploy gate
explicitly so the test is self-documenting.
"""

from __future__ import annotations

import os

import pytest

from apps.api import _engine

# Put the vendored engine's apps/api on sys.path (same hook the existing cloud
# engine-workers-dir test relies on) before importing engine modules.
_engine.ensure_engine_api_path()

from services.worker_access import (  # noqa: E402  (after sys.path mutation)
    PUBLIC_STOCK_WORKER_IDS,
    _get_visible_worker,
    _is_cloud_deploy,
    _stock_filesystem_workers_allowed,
    _stock_workers_from_filesystem,
)


class _StubWorkerRepo:
    """Minimal workers repo: every lookup misses (no DB row, no owner).

    Mirrors a non-member querying the workspace-scoped Supabase repos: nothing is
    owned by or shared with them, so each method returns None / []. This forces
    ``_get_visible_worker`` down the FS-bypass path, which #264 must close on
    cloud.
    """

    def get(self, *args, **kwargs):  # repos.workers.get(...)
        return None

    def get_any(self, *args, **kwargs):  # repos.workers.get_any(...)
        return None

    def get_owner(self, *args, **kwargs):  # _worker_hidden_from_api owner probe
        return None

    def list(self, *args, **kwargs):
        return []


class _StubRepos:
    """Minimal Repositories stub exposing only what the resolver touches."""

    def __init__(self) -> None:
        self.workers = _StubWorkerRepo()
        self.asset_access = None  # _worker_permissions falls back; unused here


@pytest.fixture()
def cloud_deploy_gate():
    """Make the cloud deploy gate explicit and verified for this test."""
    assert (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud"
    assert _is_cloud_deploy() is True
    return True


def test_fs_stock_bypass_disabled_on_cloud(cloud_deploy_gate):
    # (1) The FS stock-worker bypass is OFF on cloud.
    assert _stock_filesystem_workers_allowed() is False


def test_no_stock_workers_materialized_from_disk_on_cloud(cloud_deploy_gate):
    # (2) No stock workers are enumerated off the shared WORKERS_DIR on cloud,
    # even with the discovery cache bypassed.
    assert _stock_workers_from_filesystem(use_cache=False) == []


def test_non_member_cannot_read_vendored_tenant_worker_via_fs(cloud_deploy_gate):
    # (3) A non-member resolving a PUBLIC stock id gets None: no DB row, the FS
    # bypass is gated off on cloud, grants are off, and the shared-FS fallback is
    # cloud-disabled. So the vendored tenant's worker / source / secret-names
    # never leak across workspaces.
    assert PUBLIC_STOCK_WORKER_IDS, "engine must ship at least one public stock id"
    stock_id = sorted(PUBLIC_STOCK_WORKER_IDS)[0]
    repos = _StubRepos()

    result = _get_visible_worker(
        stock_id,
        user_id="lonely-non-member",
        repos=repos,
    )

    assert result is None
