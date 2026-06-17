from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from services.worker_access import _get_worker_for_workspace_share_source


class _WorkersRepo:
    def __init__(self, row):
        self.row = row
        self.get_calls = []

    def get(self, *, user_id: str, worker_id: str, role: str | None = None):
        self.get_calls.append({"user_id": user_id, "worker_id": worker_id, "role": role})
        return self.row

    def get_any(self, *, worker_id: str):
        raise AssertionError("share-to-workspace source resolution must not use get_any")


class _Repos:
    def __init__(self, row):
        self.workers = _WorkersRepo(row)


def _auth(user_id: str, *, role: str = "member", is_admin: bool = False):
    return SimpleNamespace(user_id=user_id, role=role, is_admin=is_admin)


def test_workspace_share_source_does_not_fallback_to_unscoped_get_any():
    repos = _Repos(None)

    worker = _get_worker_for_workspace_share_source(
        "victim-worker",
        auth=_auth("admin-a", role="admin", is_admin=True),
        repos=repos,
        workspace_id="ws-a",
    )

    assert worker is None
    assert repos.workers.get_calls == [
        {"user_id": "admin-a", "worker_id": "victim-worker", "role": "admin"}
    ]


def test_workspace_share_source_rejects_worker_from_other_workspace():
    repos = _Repos(
        {
            "id": "victim-worker",
            "owner_id": "owner-b",
            "workspace_id": "ws-b",
            "visibility": "private",
        }
    )

    worker = _get_worker_for_workspace_share_source(
        "victim-worker",
        auth=_auth("admin-a", role="admin", is_admin=True),
        repos=repos,
        workspace_id="ws-a",
    )

    assert worker is None


def test_workspace_share_source_allows_same_workspace_owner():
    repos = _Repos(
        {
            "id": "own-worker",
            "owner_id": "owner-a",
            "workspace_id": "ws-a",
            "visibility": "private",
        }
    )

    worker = _get_worker_for_workspace_share_source(
        "own-worker",
        auth=_auth("owner-a"),
        repos=repos,
        workspace_id="ws-a",
    )

    assert worker and worker["id"] == "own-worker"


def test_workspace_share_source_allows_same_workspace_admin():
    repos = _Repos(
        {
            "id": "member-worker",
            "owner_id": "member-a",
            "workspace_id": "ws-a",
            "visibility": "private",
        }
    )

    worker = _get_worker_for_workspace_share_source(
        "member-worker",
        auth=_auth("admin-a", role="admin", is_admin=True),
        repos=repos,
        workspace_id="ws-a",
    )

    assert worker and worker["id"] == "member-worker"


def test_workspace_share_source_rejects_missing_workspace_id_in_cloud(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    repos = _Repos(
        {
            "id": "ambiguous-worker",
            "owner_id": "owner-a",
            "visibility": "private",
        }
    )

    worker = _get_worker_for_workspace_share_source(
        "ambiguous-worker",
        auth=_auth("owner-a"),
        repos=repos,
        workspace_id="ws-a",
    )

    assert worker is None
