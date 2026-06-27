from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_required_approval_proposal_gets_declared_secrets_but_not_connections(monkeypatch):
    import run_service
    import runner_utils
    from models import (
        WorkerApprovals,
        WorkerConfig,
        WorkerContractCapabilities,
        WorkerResult,
        WorkerRuntime,
        WorkerTrigger,
    )

    config = WorkerConfig(
        id="approval-worker",
        name="Approval Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python", runner="e2b", mode="pure-script"),
        inputs=[],
        outputs=[],
        secrets=[],
        capabilities=WorkerContractCapabilities(secrets=["REAL_API_KEY"]),
        connections=["github"],
        approvals=WorkerApprovals(required=True, label="Approve first"),
    )

    approvals_created = []
    statuses = []
    logs = []
    driver_calls = []

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

    class _Driver:
        def run(self, **kwargs):
            driver_calls.append(kwargs)
            return WorkerResult(
                status="success",
                outputs={"summary": "ready"},
                artifacts=[],
                decision_required={"label": "Approve first", "preview": "ready"},
            )

    monkeypatch.setattr(run_service, "_load_worker_recipe", lambda *_args, **_kwargs: (None, config, {"enabled": True}))
    monkeypatch.setattr(run_service, "_worker_owner_id", lambda *_args, **_kwargs: "owner-1")
    monkeypatch.setattr(run_service, "_is_engine_approved_execution_run", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(run_service, "add_log", lambda _run_id, msg, level="info", **_kwargs: logs.append((msg, level)))
    monkeypatch.setattr(run_service, "publish_run_part", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_publish_sse", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_emit_approval_requested", lambda **_kwargs: None)
    monkeypatch.setattr(run_service, "_mark_active_run_stage", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "get_secrets_for_worker", lambda *_args, **_kwargs: {"REAL_API_KEY": "secret-value"})
    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *_args, **_kwargs: _Driver())
    monkeypatch.setattr(
        runner_utils,
        "_resolve_connections",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("connections resolved before approval")
        ),
    )

    run_service.execute_run("run-approval", "approval-worker", {"text": "send it"}, user_id="owner-1", repos=repos)

    assert len(driver_calls) == 1
    assert driver_calls[0]["secrets"] == {"REAL_API_KEY": "secret-value"}
    assert driver_calls[0]["connection_ids"] == {}
    assert approvals_created
    assert approvals_created[0]["status"] == "pending"
    assert approvals_created[0]["label"] == "Approve first"
    assert statuses[-1]["status"] == "pending_approval"
    assert any("Run awaiting approval" in msg for msg, _level in logs)
