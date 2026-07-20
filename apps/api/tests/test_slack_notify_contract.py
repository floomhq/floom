from __future__ import annotations

from types import SimpleNamespace

import pytest

from models import WorkerContract, worker_contract_to_worker_config
from runner_sandbox.agent_driver import AgentDriver


def test_modern_worker_contract_preserves_slack_approval_target() -> None:
    contract = WorkerContract.model_validate(
        {
            "schema_version": "0.3",
            "name": "slack-approval-test",
            "title": "Slack approval test",
            "description": "Verifies notification contract persistence.",
            "version": "0.1.0",
            "exec": {"command": "python run.py"},
            "notify": {
                "slack_channel_id": "C0123456789",
                "on": ["pending_approval"],
            },
        }
    )

    dumped = contract.model_dump(mode="json", exclude_none=True)

    assert dumped["notify"] == {
        "on": ["pending_approval"],
        "slack_channel_id": "C0123456789",
    }

    projected = worker_contract_to_worker_config(contract, "wrk_slack_test")
    assert projected.notify is not None
    assert projected.notify.slack_channel_id == "C0123456789"


def test_worker_create_record_preserves_unquoted_yaml_on_event() -> None:
    from services.worker_create import _worker_record_from_worker_yml

    record = _worker_record_from_worker_yml(
        "slack-approval-test",
        """\
schema_version: "0.3"
name: slack-approval-test
title: Slack approval test
description: Verifies notification contract persistence.
version: "0.1.0"
exec:
  command: python run.py
notify:
  slack_channel_id: C0123456789
  on:
    - pending_approval
""",
    )

    expected = {
        "on": ["pending_approval"],
        "slack_channel_id": "C0123456789",
    }
    assert record["manifest"]["notify"] == expected
    assert record["config"]["notify"]["on"] == ["pending_approval"]
    assert record["config"]["notify"]["slack_channel_id"] == "C0123456789"


@pytest.mark.asyncio
async def test_agent_tool_pending_approval_calls_shared_slack_hook(monkeypatch) -> None:
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    approval_rows: list[dict[str, object]] = []
    slack_calls: list[dict[str, str]] = []

    class Approvals:
        def create(self, **fields):
            approval_rows.append(dict(fields))

        def get(self, **_fields):
            return {"status": "approved"}

    class Runs:
        def update_status(self, **_fields):
            return None

    repos = SimpleNamespace(
        approvals=Approvals(),
        runs=Runs(),
        workers=SimpleNamespace(
            get_any=lambda **_fields: {"name": "Offer reviewer"}
        ),
    )

    import channels.common as channel_common
    import db
    import run_service
    import runner_sandbox.agent_driver as agent_driver

    monkeypatch.setattr(db, "get_repositories", lambda: repos)
    monkeypatch.setattr(run_service, "publish_run_part", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_publish_sse", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        channel_common,
        "notify_pending_approval_via_whatsapp",
        lambda **_fields: None,
    )
    monkeypatch.setattr(
        channel_common,
        "notify_pending_approval_via_slack",
        lambda **fields: slack_calls.append(dict(fields)),
    )
    monkeypatch.setattr(agent_driver.asyncio, "sleep", lambda _seconds: _async_noop())

    result = await AgentDriver()._request_approval_async(
        {"title": "Send offer", "description": "Review the proposed offer"},
        run_id="run_slack_agent",
        worker_id="offer-reviewer",
        user_id="user_123",
        log_fn=lambda *_args: None,
        timeout_seconds=30,
    )

    assert result["approved"] is True
    assert len(approval_rows) == 1
    assert slack_calls == [
        {
            "owner_id": "user_123",
            "run_id": "run_slack_agent",
            "worker_name": "Offer reviewer",
            "label": "Send offer",
            "approval_id": approval_rows[0]["id"],
        }
    ]


@pytest.mark.asyncio
async def test_agent_tool_pending_approval_does_not_call_slack_hook_locally(monkeypatch) -> None:
    slack_calls: list[dict[str, str]] = []

    class Approvals:
        def create(self, **_fields):
            return None

        def get(self, **_fields):
            return {"status": "approved"}

    repos = SimpleNamespace(
        approvals=Approvals(),
        runs=SimpleNamespace(update_status=lambda **_fields: None),
        workers=SimpleNamespace(get_any=lambda **_fields: {"name": "Offer reviewer"}),
    )

    import channels.common as channel_common
    import db
    import run_service
    import runner_sandbox.agent_driver as agent_driver

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setattr(db, "get_repositories", lambda: repos)
    monkeypatch.setattr(run_service, "publish_run_part", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(run_service, "_publish_sse", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        channel_common,
        "notify_pending_approval_via_whatsapp",
        lambda **_fields: None,
    )
    monkeypatch.setattr(
        channel_common,
        "notify_pending_approval_via_slack",
        lambda **fields: slack_calls.append(dict(fields)),
    )
    monkeypatch.setattr(agent_driver.asyncio, "sleep", lambda _seconds: _async_noop())

    result = await AgentDriver()._request_approval_async(
        {"title": "Send offer", "description": "Review the proposed offer"},
        run_id="run_slack_local",
        worker_id="offer-reviewer",
        user_id="user_123",
        log_fn=lambda *_args: None,
        timeout_seconds=30,
    )

    assert result["approved"] is True
    assert slack_calls == []


async def _async_noop() -> None:
    return None
