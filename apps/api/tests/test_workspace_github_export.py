"""Focused tests for POST /workspace/export-to-github."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-workspace-github-export"
OWNER = "export-owner"
OWNER_SECRET_ENV_KEYS = (
    "__WORKEROS_SECRET___EXPORT_OWNER_GITHUB_TOKEN",
    "__WORKEROS_SECRET___EXPORT_OWNER_GH_TOKEN",
    "__WORKEROS_SECRET___EXPORT_OWNER_GITHUB_PAT",
)


@pytest.fixture
def app_env(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_SHARED_SECRET_ROLE", "admin")
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(workspace))
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)
    for name in ("GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT"):
        monkeypatch.delenv(name, raising=False)
    for name in OWNER_SECRET_ENV_KEYS:
        monkeypatch.delenv(name, raising=False)

    for name in list(sys.modules):
        if (
            name == "main"
            or name == "db"
            or name.startswith("db.")
            or name == "auth"
            or name.startswith("auth.")
            or name.startswith("routers")
            or name.startswith("services")
            or name in {"git_ops", "github_api"}
        ):
            sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    git_service = importlib.import_module("services.git_service")
    client = TestClient(
        main.app,
        headers={"x-floom-secret": SECRET},
        raise_server_exceptions=False,
    )
    try:
        yield client, main, workspace
    finally:
        git_service.set_workspace_git_bundle_restore_resolver(None)
        for name in OWNER_SECRET_ENV_KEYS:
            monkeypatch.delenv(name, raising=False)
        db.get_repositories.cache_clear()


def _seed_pat(main) -> None:
    repos = main.get_repositories()
    repos.secrets.set(user_id=OWNER, name="GITHUB_TOKEN", value="pat-test")


def _mock_github(monkeypatch):
    github_api = importlib.import_module("github_api")
    calls: list[tuple[str, object]] = []

    def validate_pat(pat: str) -> dict:
        calls.append(("validate", pat))
        return {"login": "octocat"}

    def create_workeros_repo(pat: str, name: str) -> dict:
        calls.append(("create", (pat, name)))
        return {
            "full_name": f"octocat/workeros-{name}",
            "url": f"https://github.com/octocat/workeros-{name}",
        }

    monkeypatch.setattr(github_api, "validate_pat", validate_pat)
    monkeypatch.setattr(github_api, "create_workeros_repo", create_workeros_repo)
    return calls


def _mock_git(monkeypatch):
    git_ops = importlib.import_module("git_ops")
    calls: list[tuple[str, object]] = []

    def commit_paths(workspace_dir, rel_paths, message, author_name="Floom", author_email="workeros@local"):
        calls.append(("commit", (workspace_dir, rel_paths, message, author_name, author_email)))
        return "abc1234"

    def configure_remote(workspace_dir, remote_url):
        calls.append(("remote", (workspace_dir, remote_url)))

    def push_with_github_token(workspace_dir, token):
        calls.append(("push", (workspace_dir, token)))

    monkeypatch.setattr(git_ops, "commit_paths", commit_paths)
    monkeypatch.setattr(git_ops, "configure_remote", configure_remote)
    monkeypatch.setattr(git_ops, "push_with_github_token", push_with_github_token)
    return calls


def test_export_with_present_repo_pushes(app_env, monkeypatch):
    client, main, workspace = app_env
    (workspace / ".git").mkdir()
    _seed_pat(main)
    gh_calls = _mock_github(monkeypatch)
    git_calls = _mock_git(monkeypatch)

    resp = client.post(
        "/workspace/export-to-github",
        json={"repo_full_name": "octocat/existing-workspace"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {
        "repo_full_name": "octocat/existing-workspace",
        "html_url": "https://github.com/octocat/existing-workspace",
        "pushed_ref": "abc1234",
        "restored_from_bundle": False,
    }
    assert gh_calls == [("validate", "pat-test")]
    assert [name for name, _ in git_calls] == ["commit", "remote", "push"]
    remote_url = git_calls[1][1][1]
    assert remote_url == "https://github.com/octocat/existing-workspace.git"
    assert git_calls[2][1][1] == "pat-test"
    assert "pat-test" not in resp.text


def test_export_with_missing_repo_restores_from_bundle_then_pushes(app_env, monkeypatch):
    client, main, workspace = app_env
    _seed_pat(main)
    gh_calls = _mock_github(monkeypatch)
    git_calls = _mock_git(monkeypatch)
    git_service = importlib.import_module("services.git_service")
    restore_calls: list[tuple[object, Path]] = []

    def restore(workspace_id, workspace_dir):
        restore_calls.append((workspace_id, workspace_dir))
        (workspace_dir / ".git").mkdir(parents=True)
        return True

    git_service.set_workspace_git_bundle_restore_resolver(restore)

    resp = client.post(
        "/workspace/export-to-github",
        json={"repo_name": "restored-export"},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["repo_full_name"] == "octocat/workeros-restored-export"
    assert body["html_url"] == "https://github.com/octocat/workeros-restored-export"
    assert body["pushed_ref"] == "abc1234"
    assert body["restored_from_bundle"] is True
    assert restore_calls == [(None, workspace)]
    assert gh_calls == [
        ("validate", "pat-test"),
        ("create", ("pat-test", "restored-export")),
    ]
    assert [name for name, _ in git_calls] == ["commit", "remote", "push"]


def test_export_without_pat_returns_connect_first_error(app_env, monkeypatch):
    client, _main, workspace = app_env
    (workspace / ".git").mkdir()
    github_api = importlib.import_module("github_api")
    git_ops = importlib.import_module("git_ops")

    def unexpected(*_args, **_kwargs):
        raise AssertionError("GitHub or git was called without a PAT")

    monkeypatch.setattr(github_api, "validate_pat", unexpected)
    monkeypatch.setattr(git_ops, "push", unexpected)

    resp = client.post(
        "/workspace/export-to-github",
        json={"repo_full_name": "octocat/existing-workspace"},
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Connect GitHub first before exporting this workspace"
