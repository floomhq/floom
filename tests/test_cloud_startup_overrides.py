from __future__ import annotations

from types import SimpleNamespace

import apps.api.startup as cloud_startup
from apps.api.auth.workspace_context import active_workspace


class _ConnectionsRepo:
    def __init__(self, rows):
        self.rows = rows

    def list(self, *, user_id: str):
        return [row for row in self.rows if row.get("user_id") == user_id]


def test_cloud_resolve_connections_uses_active_app_level_connection(monkeypatch):
    cloud_startup._override_connection_resolution_for_cloud()
    runner_utils = cloud_startup.import_engine_module("runner_utils")
    models = cloud_startup.import_engine_module("models")
    config = models.WorkerConfig(
        id="gmail-worker",
        name="gmail-worker",
        trigger={"type": "manual"},
        runtime={"type": "python", "entrypoint": "run.py"},
        connections=[{"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}],
    )
    repos = SimpleNamespace(
        connections=_ConnectionsRepo(
            [
                {
                    "id": "conn_1",
                    "user_id": "user_1",
                    "app_name": "gmail",
                    "composio_connection_id": "ca_gmail_active",
                    "status": "active",
                    "scopes_json": [],
                    "updated_at": "2026-06-23T00:01:00+00:00",
                    "kind": "composio",
                }
            ]
        )
    )
    monkeypatch.setattr(cloud_startup.engine_db_factory, "get_repositories", lambda: repos)
    logs = []

    resolved, err = runner_utils._resolve_connections(
        "gmail-worker",
        lambda message, **kwargs: logs.append((message, kwargs)),
        config,
        user_id="user_1",
    )

    assert err is None
    assert resolved == {"gmail": "ca_gmail_active"}
    assert logs == []


def test_cloud_context_scope_for_user_prefers_active_workspace():
    cloud_startup._override_context_scope_for_cloud()

    with active_workspace("ws_context_1"):
        assert cloud_startup.engine_contexts.context_scope_for_user("user_1") == "ws_context_1"
