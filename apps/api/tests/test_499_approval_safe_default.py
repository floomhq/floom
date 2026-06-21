from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_required_approval_pauses_before_secrets_connections_or_sandbox(monkeypatch):
    import run_service
    from models import WorkerApprovals, WorkerConfig, WorkerRuntime, WorkerTrigger

    config = WorkerConfig(
        id="approval-worker",
        name="Approval Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b", mode="pure-script"),
        inputs=[],
        outputs=[],
        secrets=["REAL_API_KEY"],
        connections=[],
        approvals=WorkerApprovals(required=True, label="Approve first"),
    )

    approvals_created = []
    statuses = []
    logs = []

    class _Runs:
        def get_any(self, *, run_id):
            return {"id": run_id, "status": "running"}

        def update_status(self, **kwargs):
            statuses.append(kwargs)

    repos = SimpleNamespace(
        runs=_Runs(),
        approvals=SimpleNamespace(create=lambda **kwargs: approvals_created.append(kwargs)),
        workers=SimpleNamespace(get_any=lambda **_kwargs: {"name": "Approval Worker"}),
    )

    monkeypatch.setattr(run_service, "_load_worker_recipe", lambda *_args, **_kwargs: (None, config, {"enabled": True}))
    monkeypatch.setattr(run_service, "_worker_owner_id", lambda *_args, **_kwargs: "owner-1")
    monkeypatch.setattr(run_service, "_is_engine_approved_execution_run", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(run_service, "add_log", lambda _run_id, msg, level="info", **_kwargs: logs.append((msg, level)))
    monkeypatch.setattr(run_service, "publish_run_part", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_publish_sse", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_emit_approval_requested", lambda **_kwargs: None)
    monkeypatch.setattr(run_service, "_mark_active_run_stage", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "get_secrets_for_worker", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("secrets resolved before approval")))
    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("sandbox started before approval")))

    run_service.execute_run("run-approval", "approval-worker", {"text": "send it"}, user_id="owner-1", repos=repos)

    assert approvals_created
    assert approvals_created[0]["status"] == "pending"
    assert approvals_created[0]["label"] == "Approve first"
    assert statuses[-1]["status"] == "pending_approval"
    assert any("Run awaiting approval" in msg for msg, _level in logs)
