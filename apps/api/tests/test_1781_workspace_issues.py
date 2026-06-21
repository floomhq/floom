"""#1781: git-backed workspace issues stored under .floom/issues/.

Covers the acceptance criteria end-to-end with no network:
  - create an issue -> a committed file appears under .floom/issues/
  - each workspace has an independent ISSUE-NNNN namespace
  - attach an issue to a worker/context/run
  - list + filter by status/label/asset_type/asset_id
  - comment, close, reopen
  - Emily tools answer "what issues are open?" and "create an issue for this worker"
  - issues are git-tracked, so export/import + cloud bundle preserve them
"""

from __future__ import annotations

import importlib
import subprocess
import sys
import types
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _purge_api_modules() -> None:
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "chat_service", "git_ops") or name.startswith(
            ("routers", "services", "core", "db", "auth", "contexts")
        ):
            sys.modules.pop(name, None)


def _init_git(workspace: Path) -> None:
    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=workspace, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=workspace, check=True)


def _git_tracked(workspace: Path, rel_path: str) -> bool:
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", rel_path],
        cwd=workspace,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _install_app(monkeypatch, tmp_path: Path, *, workers_dir: Path, workspace_dir: Path):
    if "fcntl" not in sys.modules:
        _fcntl = types.ModuleType("fcntl")
        for attr in ("LOCK_EX", "LOCK_SH", "LOCK_UN", "LOCK_NB"):
            setattr(_fcntl, attr, 0)
        _fcntl.flock = lambda fd, op: None
        sys.modules["fcntl"] = _fcntl

    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(workspace_dir))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "dev")
    monkeypatch.setenv("WORKEROS_SHARED_SECRET_ROLE", "admin")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    _purge_api_modules()
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")

    from fastapi.testclient import TestClient

    return TestClient(main.app, headers={"x-floom-secret": "dev"}, raise_server_exceptions=False), main


def _make_workspace(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    workers_dir = workspace / "workers"
    workers_dir.mkdir(parents=True)
    _init_git(workspace)
    return workspace, workers_dir


# ---------------------------------------------------------------------------
# HTTP lifecycle (router + service + git + models)
# ---------------------------------------------------------------------------

def test_create_issue_commits_a_file_under_floom_issues(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, _main = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)

    resp = client.post("/workspace/issues", json={"title": "Gmail inbox worker failed twice"})
    assert resp.status_code == 201, resp.text
    issue = resp.json()
    assert issue["id"] == "ISSUE-0001"
    assert issue["status"] == "open"
    assert issue["comment_count"] == 0

    md_path = workspace / ".floom" / "issues" / "ISSUE-0001.md"
    assert md_path.is_file()
    text = md_path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    assert "id: ISSUE-0001" in text
    assert "Gmail inbox worker failed twice" in text
    # Lives in git -> export/import + cloud bundle preserve it automatically.
    assert _git_tracked(workspace, ".floom/issues/ISSUE-0001.md")


def test_attach_filter_comment_close_reopen(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, _main = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)

    # Workspace-wide issue.
    client.post("/workspace/issues", json={"title": "Stale refund policy", "labels": ["needs-attention"]})
    # Issue attached to a worker.
    r2 = client.post(
        "/workspace/issues",
        json={
            "title": "gmail worker keeps failing",
            "asset_type": "worker",
            "asset_id": "gmail-inbox-manager",
            "source": "run_failure",
            "labels": ["worker", "needs-attention"],
        },
    )
    assert r2.status_code == 201, r2.text
    worker_issue = r2.json()
    assert worker_issue["id"] == "ISSUE-0002"
    assert worker_issue["asset_type"] == "worker"
    assert worker_issue["asset_id"] == "gmail-inbox-manager"

    # Filter by asset binding.
    by_worker = client.get(
        "/workspace/issues", params={"asset_type": "worker", "asset_id": "gmail-inbox-manager"}
    ).json()["issues"]
    assert [i["id"] for i in by_worker] == ["ISSUE-0002"]

    # Filter by label.
    by_label = client.get("/workspace/issues", params={"label": "worker"}).json()["issues"]
    assert [i["id"] for i in by_label] == ["ISSUE-0002"]

    # Comment.
    rc = client.post("/workspace/issues/ISSUE-0002/comments", json={"body": "Confirmed from run_123"})
    assert rc.status_code == 201, rc.text
    assert rc.json()["id"].startswith("cmt_")
    assert _git_tracked(workspace, ".floom/issues/ISSUE-0002.comments.ndjson")

    detail = client.get("/workspace/issues/ISSUE-0002").json()
    assert detail["comment_count"] == 1
    assert detail["comments"][0]["body"] == "Confirmed from run_123"

    # Close, then filter by status.
    rclose = client.patch("/workspace/issues/ISSUE-0002", json={"status": "closed"})
    assert rclose.status_code == 200, rclose.text
    assert rclose.json()["status"] == "closed"
    open_issues = client.get("/workspace/issues", params={"status": "open"}).json()["issues"]
    assert [i["id"] for i in open_issues] == ["ISSUE-0001"]
    closed_issues = client.get("/workspace/issues", params={"status": "closed"}).json()["issues"]
    assert [i["id"] for i in closed_issues] == ["ISSUE-0002"]

    # Reopen.
    rreopen = client.patch("/workspace/issues/ISSUE-0002", json={"status": "open"})
    assert rreopen.json()["status"] == "open"


def test_validation_and_not_found(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    client, _main = _install_app(monkeypatch, tmp_path, workers_dir=workers_dir, workspace_dir=workspace)

    # asset_type without asset_id -> 400.
    bad = client.post("/workspace/issues", json={"title": "x", "asset_type": "worker"})
    assert bad.status_code == 400, bad.text

    # Unknown asset_type -> 400.
    bad2 = client.post(
        "/workspace/issues", json={"title": "x", "asset_type": "banana", "asset_id": "y"}
    )
    assert bad2.status_code == 400, bad2.text

    # Missing title -> 422 (pydantic).
    bad3 = client.post("/workspace/issues", json={"body": "no title"})
    assert bad3.status_code == 422, bad3.text

    # Unknown issue -> 404.
    missing = client.get("/workspace/issues/ISSUE-9999")
    assert missing.status_code == 404, missing.text

    # Malformed id -> 400.
    malformed = client.get("/workspace/issues/not-an-id")
    assert malformed.status_code == 400, malformed.text


# ---------------------------------------------------------------------------
# Per-workspace namespace independence (service layer, two git roots)
# ---------------------------------------------------------------------------

def test_each_workspace_has_independent_issue_namespace(monkeypatch, tmp_path):
    ws_a = tmp_path / "ws_a"
    ws_b = tmp_path / "ws_b"
    for ws in (ws_a, ws_b):
        (ws / "workers").mkdir(parents=True)
        _init_git(ws)

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "dev")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(ws_a / "workers"))
    _purge_api_modules()
    issues = importlib.import_module("services.workspace_issues")

    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(ws_a))
    a1 = issues.create_issue(title="A first", created_by="user_a")
    a2 = issues.create_issue(title="A second", created_by="user_a")
    assert [a1["id"], a2["id"]] == ["ISSUE-0001", "ISSUE-0002"]

    # A different workspace restarts numbering at ISSUE-0001.
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(ws_b))
    b1 = issues.create_issue(title="B first", created_by="user_b")
    assert b1["id"] == "ISSUE-0001"
    assert [i["id"] for i in issues.list_issues()] == ["ISSUE-0001"]

    # ws_a is untouched by ws_b's writes.
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(ws_a))
    assert [i["id"] for i in issues.list_issues()] == ["ISSUE-0001", "ISSUE-0002"]


# ---------------------------------------------------------------------------
# Emily tools
# ---------------------------------------------------------------------------

def test_emily_tools_create_list_comment_close(monkeypatch, tmp_path):
    workspace, workers_dir = _make_workspace(tmp_path)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "dev")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(workspace))
    _purge_api_modules()
    impls = importlib.import_module("services.chat_tool_impls")

    # "create an issue for this worker"
    created = impls._tool_issues_create(
        {"title": "worker is flaky", "asset_type": "worker", "asset_id": "gmail-inbox-manager"},
        "local-user",
    )
    assert created["ok"] is True, created
    assert created["issue"]["id"] == "ISSUE-0001"

    # "what issues are open for this workspace?"
    listing = impls._tool_issues_list({"status": "open"}, "local-user")
    assert listing["ok"] is True
    assert listing["count"] == 1

    commented = impls._tool_issues_comment({"id": "ISSUE-0001", "body": "looking into it"}, "local-user")
    assert commented["ok"] is True
    assert commented["comment"]["created_by"] == "local-user"

    closed = impls._tool_issues_close({"id": "ISSUE-0001"}, "local-user")
    assert closed["ok"] is True
    assert closed["issue"]["status"] == "closed"

    reopened = impls._tool_issues_close({"id": "ISSUE-0001", "reopen": True}, "local-user")
    assert reopened["issue"]["status"] == "open"

    # Unknown issue is a soft error, not a crash.
    miss = impls._tool_issues_comment({"id": "ISSUE-4242", "body": "x"}, "local-user")
    assert miss["ok"] is False
