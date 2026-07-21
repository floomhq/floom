"""Regression coverage for #2277 connection probe and list semantics."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from routers import connections as connection_routes


class _ConnectionsRepo:
    def __init__(self) -> None:
        self.row = {
            "id": "conn-2277",
            "user_id": "workspace-2277",
            "app_name": "github",
            "composio_connection_id": "ca_2277",
            "kind": "composio",
            "status": "active",
            "created_at": "2026-07-20T00:00:00Z",
            "updated_at": "2026-07-20T00:00:00Z",
        }
        self.updates: list[dict] = []

    def get(self, *, user_id: str, composio_id: str):
        return self.row if user_id == self.row["user_id"] and composio_id == self.row["id"] else None

    def list_all(self):
        return [self.row]

    def update(self, **kwargs):
        self.updates.append(kwargs)
        self.row.update({k: v for k, v in kwargs.items() if k not in {"user_id", "composio_id"}})


def _repos(repo: _ConnectionsRepo):
    return SimpleNamespace(connections=repo)


def test_connection_probe_is_non_mutating_unless_record_is_explicit(monkeypatch):
    repo = _ConnectionsRepo()
    monkeypatch.setattr("composio_client.check_status", lambda _connection_id: "failed")

    result = connection_routes.test_connection(
        repo.row["id"],
        auth=SimpleNamespace(user_id=repo.row["user_id"]),
        repos=_repos(repo),
    )

    assert result.status == "failed"
    assert repo.updates == []
    assert repo.row["status"] == "active"

    connection_routes.test_connection(
        repo.row["id"],
        record=True,
        auth=SimpleNamespace(user_id=repo.row["user_id"]),
        repos=_repos(repo),
    )

    assert repo.updates[-1]["last_check_status"] == "failed"
    assert "status" not in repo.updates[-1]
    assert "updated_at" not in repo.updates[-1]
    assert repo.row["status"] == "active"


def test_connection_list_separates_configuration_from_recorded_health():
    item = connection_routes._public_connection_item({
        "id": "conn-2277",
        "user_id": "workspace-2277",
        "app_name": "github",
        "status": "active",
        "created_at": "2026-07-20T00:00:00Z",
        "updated_at": "2026-07-20T00:00:00Z",
        "last_checked_at": "2026-07-21T00:00:00Z",
        "last_check_status": "failed",
    })

    assert item.status == "active"
    assert item.configuration_status == "active"
    assert item.health_status == "unhealthy"

    unchecked = connection_routes._public_connection_item({
        "id": "conn-unchecked",
        "user_id": "workspace-2277",
        "app_name": "slack",
        "status": "active",
        "created_at": "2026-07-20T00:00:00Z",
        "updated_at": "2026-07-20T00:00:00Z",
    })
    assert unchecked.health_status == "never_checked"
