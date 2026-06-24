"""#1967 — infra/config errors must not become public approval cards.

Run:
  cd apps/api && python -m pytest tests/test_approval_proposal_hygiene_1967.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_infra_error_decision_required_fails_run_without_approval():
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
        "preview": (
            "Token source per account: personal1:input\n"
            '{"http_error":429,"error":"RATE_LIMIT_EXCEEDED"}\n'
            "channel 'youtube' not connected in personal-2"
        ),
    }

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
