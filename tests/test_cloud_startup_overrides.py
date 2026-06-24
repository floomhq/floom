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


def test_cloud_memory_context_pack_uploads_to_storage(monkeypatch, tmp_path):
    """Memory packs must reach Storage on create so Library survives restarts."""
    import contexts as engine_contexts_module

    cloud_startup._override_memory_context_persistence_for_cloud()
    memory_context = cloud_startup.import_engine_module("runner_sandbox.memory_context")
    models = cloud_startup.import_engine_module("models")

    contexts_root = tmp_path / "contexts"
    monkeypatch.setattr(engine_contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(memory_context._contexts_module, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(
        cloud_startup.engine_contexts,
        "CONTEXTS_DIR",
        contexts_root,
        raising=False,
    )

    uploads: list[tuple[str, str]] = []
    metadata_uploads: list[str] = []

    def _fake_upload_background(workspace_id, context_name, context_dir):
        uploads.append((workspace_id, context_name))

    def _fake_upload_metadata(workspace_id, root):
        metadata_uploads.append(workspace_id)

    monkeypatch.setattr(
        "apps.api.cloud_contexts.upload_context_background",
        _fake_upload_background,
    )
    monkeypatch.setattr(
        "apps.api.cloud_contexts.upload_context_metadata",
        _fake_upload_metadata,
    )

    config = models.WorkerConfig(
        id="audit-worker",
        name="Audit Worker",
        trigger={"type": "manual"},
        runtime={"type": "python311", "command": "python run.py", "mode": "pure-script"},
        outputs=[],
    )

    with active_workspace("ws_memory_1"):
        name = memory_context.ensure_memory_context_pack(
            config=config,
            user_id="user_1",
            log_fn=lambda _msg, _level="info": None,
        )

    assert name == "memory-audit-worker"
    assert uploads == [("ws_memory_1", "memory-audit-worker")]
    assert metadata_uploads == ["ws_memory_1"]
