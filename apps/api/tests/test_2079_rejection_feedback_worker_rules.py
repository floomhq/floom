"""#2079: scoped approval rejection feedback becomes durable worker rules."""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

OWNER = "local-user"
SECRET = "test-secret-2079"
WORKER_ID = "approval-rules-worker"


@pytest.fixture()
def app_env(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    contexts_dir = tmp_path / "contexts"
    artifacts_dir = tmp_path / "artifacts"
    for path in (workers_dir, contexts_dir, artifacts_dir):
        path.mkdir()
    worker_dir = workers_dir / WORKER_ID
    worker_dir.mkdir()
    (worker_dir / "SKILL.md").write_text("Write concise approval drafts.\n", encoding="utf-8")
    (worker_dir / "run.py").write_text("print('unused')\n", encoding="utf-8")

    db_path = tmp_path / "floom.db"
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "contexts",
        "worker_registry",
        "runner_utils",
        "run_service",
        "main",
        "services.worker_rules",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers.")]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    import contexts as contexts_mod
    import runner_utils as runner_utils_mod
    from runner_sandbox import agent_capabilities as agent_capabilities_mod
    from runner_sandbox import agent_driver as agent_driver_mod
    from runner_sandbox import memory_context as memory_context_mod

    importlib.reload(contexts_mod)
    importlib.reload(runner_utils_mod)
    importlib.reload(memory_context_mod)
    importlib.reload(agent_capabilities_mod)
    importlib.reload(agent_driver_mod)
    repos = db.get_repositories()
    repos.workers.create(
        user_id=OWNER,
        worker_id=WORKER_ID,
        name="Approval Rules Worker",
        manifest_json={
            "id": WORKER_ID,
            "name": WORKER_ID,
            "version": "0.1.0",
            "trigger": {"type": "manual"},
            "runtime": {
                "type": "agent",
                "entrypoint": "SKILL.md",
                "runner": "e2b",
                "mode": "agent",
            },
            "inputs": [],
            "outputs": [],
            "secrets": [],
        },
        bundle_path=f"workers/{WORKER_ID}",
    )
    client = TestClient(main.app, headers={"x-floom-secret": SECRET, "x-floom-user": OWNER})
    yield {
        "main": main,
        "db": db,
        "repos": repos,
        "client": client,
        "workers_dir": workers_dir,
        "contexts_dir": contexts_dir,
        "artifacts_dir": artifacts_dir,
    }
    db.get_repositories.cache_clear()


def _seed_pending_approval(main, repos, *, run_id: str, approval_id: str, kind: str | None = None) -> None:
    repos.runs.create(
        user_id=OWNER,
        run_id=run_id,
        worker_id=WORKER_ID,
        status=main.RunStatus.PENDING_APPROVAL.value,
        trigger_source="manual",
        runner="e2b",
        input_json={},
        output_json={"draft": "candidate output"},
    )
    decision_input = {"kind": kind} if kind else {}
    repos.approvals.create(
        owner_id=OWNER,
        id=approval_id,
        run_id=run_id,
        worker_id=WORKER_ID,
        status="pending",
        label="Review draft",
        preview="candidate output",
        decision_input_json=json.dumps(decision_input),
        created_at="2026-06-28T00:00:00Z",
    )


def test_scope_classifier_is_deterministic():
    from services.worker_rules import rejection_feedback_scope, rejection_feedback_text

    assert rejection_feedback_scope(None) == "asset"
    assert rejection_feedback_scope("asset") == "asset"
    assert rejection_feedback_scope("GLOBAL") == "global"
    with pytest.raises(ValueError):
        rejection_feedback_scope("sometimes")
    assert rejection_feedback_text(
        reason="Always include source links.",
        annotations={"text": [{"quote": "draft", "comment": "Use bullets."}]},
    ) == "Always include source links.\n\nUse bullets. (about: draft)"


def test_global_reject_persists_rule_and_next_agent_context(app_env):
    main = app_env["main"]
    repos = app_env["repos"]
    client = app_env["client"]
    _seed_pending_approval(main, repos, run_id="run_global", approval_id="apr_global")

    resp = client.post(
        "/runs/run_global/reject",
        json={"reason": "Always cite the source URL beside each claim.", "scope": "global"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "rejected", "run_id": "run_global"}

    rows = repos.worker_rules.list_active(workspace_id="local-default", worker_id=WORKER_ID)
    assert len(rows) == 1
    assert rows[0]["rule_text"] == "Always cite the source URL beside each claim."
    assert rows[0]["approval_id"] == "apr_global"

    memory_dir = app_env["contexts_dir"] / OWNER / f"memory-{WORKER_ID}"
    rules_md = memory_dir / "APPROVAL_RULES.md"
    audit_jsonl = memory_dir / "approval-rules.jsonl"
    assert "Always cite the source URL" in rules_md.read_text(encoding="utf-8")
    assert len(audit_jsonl.read_text(encoding="utf-8").splitlines()) == 1

    from runner_sandbox.agent_driver import AgentDriver
    from models import WorkerConfig

    worker_row = repos.workers.get(user_id=OWNER, worker_id=WORKER_ID)
    config = worker_row["config"]
    if isinstance(config, dict):
        config = WorkerConfig(**config)
    context_root = app_env["artifacts_dir"] / "run_next" / "context"
    context_root.mkdir(parents=True)
    driver = AgentDriver()
    staged = driver._stage_contexts(
        config=config,
        context_root=context_root,
        user_id=OWNER,
        log_fn=lambda *_args, **_kwargs: None,
    )
    assert f"memory-{WORKER_ID}" in staged
    staged_rules = context_root / f"memory-{WORKER_ID}" / "APPROVAL_RULES.md"
    assert "Always cite the source URL" in staged_rules.read_text(encoding="utf-8")

    prompt = driver._load_system_prompt(
        app_env["workers_dir"] / WORKER_ID,
        config,
        staged,
        worker_id=WORKER_ID,
        user_id=OWNER,
    )
    assert "## Worker feedback rules" in prompt
    assert "Always cite the source URL beside each claim." in prompt


def test_asset_reject_stays_one_off(app_env):
    main = app_env["main"]
    repos = app_env["repos"]
    client = app_env["client"]
    _seed_pending_approval(main, repos, run_id="run_asset", approval_id="apr_asset")

    resp = client.post(
        "/runs/run_asset/reject",
        json={"reason": "This particular draft mentions the wrong customer.", "scope": "asset"},
    )
    assert resp.status_code == 200, resp.text
    row = repos.approvals.get(owner_id=OWNER, approval_id="apr_asset")
    assert row["reason"] == "This particular draft mentions the wrong customer."
    assert repos.worker_rules.list_active(workspace_id="local-default", worker_id=WORKER_ID) == []


def test_global_rule_persistence_is_idempotent(app_env):
    main = app_env["main"]
    repos = app_env["repos"]
    client = app_env["client"]
    _seed_pending_approval(main, repos, run_id="run_idem", approval_id="apr_idem")

    body = {"reason": "Never publish rows without the email column.", "scope": "global"}
    resp = client.post("/runs/run_idem/reject", json=body)
    assert resp.status_code == 200, resp.text

    from services.worker_rules import record_rejection_feedback_rule

    record_rejection_feedback_rule(
        repos=repos,
        owner_id=OWNER,
        worker_id=WORKER_ID,
        workspace_id="local-default",
        approval_id="apr_idem",
        run_id="run_idem",
        reason=body["reason"],
        annotations=None,
        scope="global",
        approval_kind="run",
    )
    rows = repos.worker_rules.list_active(workspace_id="local-default", worker_id=WORKER_ID)
    assert len(rows) == 1
    audit = app_env["contexts_dir"] / OWNER / f"memory-{WORKER_ID}" / "approval-rules.jsonl"
    assert len(audit.read_text(encoding="utf-8").splitlines()) == 1


def test_agent_tool_reject_can_persist_global_rule(app_env):
    main = app_env["main"]
    repos = app_env["repos"]
    client = app_env["client"]
    _seed_pending_approval(main, repos, run_id="run_tool", approval_id="apr_tool", kind="agent_tool")

    resp = client.post(
        "/approvals/apr_tool/reject",
        json={"reason": "Ask before deleting spreadsheet rows.", "scope": "global"},
    )
    assert resp.status_code == 200, resp.text
    rows = repos.worker_rules.list_active(workspace_id="local-default", worker_id=WORKER_ID)
    assert len(rows) == 1
    assert rows[0]["rule_text"] == "Ask before deleting spreadsheet rows."
