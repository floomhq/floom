"""#1967 — infra/config errors must not become public approval cards.

Run:
  cd apps/api && python -m pytest tests/test_approval_proposal_hygiene_1967.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _purge_run_modules() -> None:
    for name in list(sys.modules):
        if name in {"run_service", "worker_registry", "db"} or name.startswith("db."):
            sys.modules.pop(name, None)


def test_infra_error_decision_required_fails_run_without_approval(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    _purge_run_modules()
    import run_service

    created_approvals: list[dict] = []
    status_updates: list[dict] = []
    logs: list[tuple[str, str]] = []

    class ApprovalsRepo:
        def create(self, **kwargs):
            created_approvals.append(kwargs)

    class RunsRepo:
        def get(self, **kwargs):
            return {}

        def update_status(self, **kwargs):
            status_updates.append(kwargs)

    class Repos:
        approvals = ApprovalsRepo()
        runs = RunsRepo()

    decision_required = {
        "label": "content-pub-cp2",
        "error": {
            "code": "RATE_LIMIT_EXCEEDED",
            "message": (
                "Token source per account: personal1:input\n"
                '{"http_error":429,"error":"RATE_LIMIT_EXCEEDED"}\n'
                "channel 'youtube' not connected in personal-2"
            ),
        },
        "preview": "Public preview text",
    }

    try:
        run_service._pause_run_for_required_approval(
            run_id="run_1967",
            worker_id="content-pub-cp2",
            owner_id="owner_1967",
            config=object(),
            effective_inputs={},
            decision_required=decision_required,
            outputs={},
            repos_obj=Repos(),
            log_fn=lambda message, level="info": logs.append((message, level)),
        )

        assert created_approvals == []
        assert status_updates
        assert status_updates[-1]["status"] == run_service.RunStatus.FAILED.value
        assert status_updates[-1]["error_code"] == "approval_proposal_config_error"
        assert "configuration error" in status_updates[-1]["error"]
        assert any(level == "error" and "configuration error" in message for message, level in logs)
    finally:
        _purge_run_modules()


def test_human_preview_with_error_words_still_creates_pending_approval(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    _purge_run_modules()
    import run_service

    monkeypatch.setattr(run_service, "publish_run_part", lambda *args, **kwargs: None)
    monkeypatch.setattr(run_service, "_publish_sse", lambda *args, **kwargs: None)
    monkeypatch.setattr(run_service, "_emit_approval_requested", lambda *args, **kwargs: None)

    created_approvals: list[dict] = []
    status_updates: list[dict] = []
    logs: list[tuple[str, str]] = []

    class ApprovalsRepo:
        def create(self, **kwargs):
            created_approvals.append(kwargs)

    class RunsRepo:
        def get(self, **kwargs):
            return {}

        def update_status(self, **kwargs):
            status_updates.append(kwargs)

    class WorkersRepo:
        def get_any(self, **kwargs):
            return {"name": "Content Publisher"}

    class Repos:
        approvals = ApprovalsRepo()
        runs = RunsRepo()
        workers = WorkersRepo()

    decision_required = {
        "label": "Publish incident post",
        "preview": (
            "Token source per account: personal1:input\n"
            '{"http_error":429,"error":"RATE_LIMIT_EXCEEDED"}\n'
            "channel 'youtube' not connected in personal-2"
        ),
    }

    try:
        run_service._pause_run_for_required_approval(
            run_id="run_1967_content",
            worker_id="content-pub-cp2",
            owner_id="owner_1967",
            config=SimpleNamespace(approvals=SimpleNamespace(label="Approve action")),
            effective_inputs={"caption": decision_required["preview"]},
            decision_required=decision_required,
            outputs={},
            repos_obj=Repos(),
            log_fn=lambda message, level="info": logs.append((message, level)),
        )

        assert len(created_approvals) == 1
        assert created_approvals[0]["status"] == "pending"
        assert status_updates
        assert status_updates[-1]["status"] == run_service.RunStatus.PENDING_APPROVAL.value
        assert any("awaiting approval" in message for message, _level in logs)
    finally:
        _purge_run_modules()
