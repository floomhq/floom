"""Tests for the sensitive context flag.

Sensitive is the DEFAULT for all contexts. Writes to sensitive contexts
are never committed to git. Toggle sensitive=False to opt in to git tracking.
Covers:
  - is_context_sensitive() defaults to True (absent key)
  - set_context_metadata(sensitive=...) persists correctly
  - ContextSummary.sensitive field in list and get responses
  - PATCH /contexts/{name}/sensitive endpoint
  - _git_commit_context skips git for sensitive contexts
  - _git_commit_context commits for explicitly non-sensitive contexts
"""
from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# ---------------------------------------------------------------------------
# Unit tests — contexts.py helpers (no HTTP)
# ---------------------------------------------------------------------------

def test_is_context_sensitive_defaults_true(tmp_path, monkeypatch):
    """No metadata file → sensitive by default."""
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path))
    for mod in [k for k in sys.modules if k.startswith("contexts")]:
        sys.modules.pop(mod)
    from contexts import is_context_sensitive
    assert is_context_sensitive("my-pack") is True


def test_is_context_sensitive_absent_key_is_true(tmp_path, monkeypatch):
    """Metadata exists but no 'sensitive' key → still True."""
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path))
    (tmp_path / ".workeros-contexts.json").write_text(
        json.dumps({"my-pack": {"writeable": True}}), encoding="utf-8"
    )
    for mod in [k for k in sys.modules if k.startswith("contexts")]:
        sys.modules.pop(mod)
    from contexts import is_context_sensitive
    assert is_context_sensitive("my-pack") is True


def test_is_context_sensitive_explicit_true(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path))
    (tmp_path / ".workeros-contexts.json").write_text(
        json.dumps({"my-pack": {"sensitive": True}}), encoding="utf-8"
    )
    for mod in [k for k in sys.modules if k.startswith("contexts")]:
        sys.modules.pop(mod)
    from contexts import is_context_sensitive
    assert is_context_sensitive("my-pack") is True


def test_is_context_sensitive_explicit_false(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path))
    (tmp_path / ".workeros-contexts.json").write_text(
        json.dumps({"my-pack": {"sensitive": False}}), encoding="utf-8"
    )
    for mod in [k for k in sys.modules if k.startswith("contexts")]:
        sys.modules.pop(mod)
    from contexts import is_context_sensitive
    assert is_context_sensitive("my-pack") is False


def test_set_context_metadata_sensitive(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path))
    (tmp_path / "my-pack").mkdir()
    for mod in [k for k in sys.modules if k.startswith("contexts")]:
        sys.modules.pop(mod)
    from contexts import set_context_metadata, is_context_sensitive

    # Default: sensitive
    assert is_context_sensitive("my-pack") is True

    # Opt in to git tracking
    set_context_metadata("my-pack", sensitive=False)
    assert is_context_sensitive("my-pack") is False

    # Opt back out
    set_context_metadata("my-pack", sensitive=True)
    assert is_context_sensitive("my-pack") is True


def test_set_context_metadata_sensitive_preserves_other_fields(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(tmp_path))
    (tmp_path / "my-pack").mkdir()
    (tmp_path / ".workeros-contexts.json").write_text(
        json.dumps({"my-pack": {"writeable": True, "owner_id": "alice"}}),
        encoding="utf-8",
    )
    for mod in [k for k in sys.modules if k.startswith("contexts")]:
        sys.modules.pop(mod)
    from contexts import set_context_metadata, load_context_metadata

    set_context_metadata("my-pack", sensitive=False)
    meta = load_context_metadata()
    assert meta["my-pack"]["writeable"] is True
    assert meta["my-pack"]["owner_id"] == "alice"
    assert meta["my-pack"]["sensitive"] is False


# ---------------------------------------------------------------------------
# API tests — full HTTP client
# ---------------------------------------------------------------------------

@pytest.fixture()
def client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    pack = contexts_dir / "alpha"
    pack.mkdir()
    (pack / "notes.txt").write_text("hello\n", encoding="utf-8")
    (contexts_dir / ".workeros-contexts.json").write_text(
        json.dumps({"alpha": {"writeable": True, "owner_id": "testuser"}}),
        encoding="utf-8",
    )

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("WORKEROS_USER_ID", "testuser")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))

    for name in list(sys.modules):
        if any(name == m or name.startswith(m + ".") for m in [
            "main", "db", "models", "files", "worker_registry", "runner_utils",
            "run_service", "webhook_service", "composio_client", "scheduler",
            "auth", "contexts", "chat_service", "git_ops", "github_api",
            "alerting", "mcp_server",
        ]):
            sys.modules.pop(name)

    stub_names = [
        "e2b", "e2b.sandbox", "openai", "anthropic", "composio_openai",
        "composio_core", "slowapi", "slowapi.util", "slowapi.errors",
        "resend", "supabase", "gotrue",
    ]
    for stub in stub_names:
        if stub not in sys.modules:
            sys.modules[stub] = types.ModuleType(stub)

    git_ops_stub = types.ModuleType("git_ops")
    git_ops_stub.commit_paths = MagicMock(return_value=None)
    git_ops_stub.push_background = MagicMock(return_value=None)
    git_ops_stub.get_log = MagicMock(return_value=[])
    git_ops_stub.get_file_at_sha = MagicMock(return_value=None)
    git_ops_stub.list_files_at_sha = MagicMock(return_value=[])
    git_ops_stub.checkout_path = MagicMock(return_value=None)
    git_ops_stub.GitOpsError = Exception
    git_ops_stub.ensure_repo = MagicMock(return_value=None)
    git_ops_stub.get_active_workspace_id = MagicMock(return_value=None)
    sys.modules["git_ops"] = git_ops_stub

    import importlib
    main_mod = importlib.import_module("main")
    from fastapi.testclient import TestClient
    with TestClient(main_mod.app) as test_client:
        yield test_client, main_mod, git_ops_stub
    sys.modules.pop("git_ops", None)


def _auth(client_tuple):
    c, _, _ = client_tuple
    return {"x-floom-secret": "test-secret"}


# ---------------------------------------------------------------------------
# PATCH /contexts/{name}/sensitive
# ---------------------------------------------------------------------------

def test_patch_sensitive_sets_false(client):
    c, main_mod, _ = client
    resp = c.patch(
        "/contexts/alpha/sensitive",
        json={"sensitive": False},
        headers=_auth(client),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["sensitive"] is False
    assert body["name"] == "alpha"


def test_patch_sensitive_sets_true(client):
    c, main_mod, _ = client
    # First opt in
    c.patch("/contexts/alpha/sensitive", json={"sensitive": False}, headers=_auth(client))
    # Then opt back out
    resp = c.patch("/contexts/alpha/sensitive", json={"sensitive": True}, headers=_auth(client))
    assert resp.status_code == 200
    assert resp.json()["sensitive"] is True


def test_patch_sensitive_missing_body_422(client):
    c, _, _ = client
    resp = c.patch("/contexts/alpha/sensitive", json={}, headers=_auth(client))
    assert resp.status_code == 422


def test_patch_sensitive_unknown_context_404(client):
    c, _, _ = client
    resp = c.patch(
        "/contexts/does-not-exist/sensitive",
        json={"sensitive": False},
        headers=_auth(client),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /contexts — sensitive field in ContextSummary
# ---------------------------------------------------------------------------

def test_context_list_sensitive_true_by_default(client):
    """New context with no explicit sensitive key → sensitive=True in response."""
    c, _, _ = client
    resp = c.get("/contexts", headers=_auth(client))
    assert resp.status_code == 200
    packs = {p["name"]: p for p in resp.json()}
    assert "alpha" in packs
    assert packs["alpha"]["sensitive"] is True


def test_context_list_sensitive_false_after_opt_in(client):
    c, _, _ = client
    c.patch("/contexts/alpha/sensitive", json={"sensitive": False}, headers=_auth(client))
    resp = c.get("/contexts", headers=_auth(client))
    packs = {p["name"]: p for p in resp.json()}
    assert packs["alpha"]["sensitive"] is False


# ---------------------------------------------------------------------------
# Git commit gating — sensitive contexts never trigger commit_paths
# ---------------------------------------------------------------------------

def test_put_context_file_sensitive_skips_git(client, tmp_path, monkeypatch):
    """PUT /contexts/{name}/files/... on a sensitive context must not call git."""
    c, main_mod, git_stub = client
    # alpha has no sensitive key → defaults to True (sensitive)
    git_stub.commit_paths.reset_mock()

    resp = c.put(
        "/contexts/alpha/files/readme.md",
        content=b"# Hello",
        headers={**_auth(client), "content-type": "text/plain"},
    )
    assert resp.status_code == 200
    git_stub.commit_paths.assert_not_called()


def test_put_context_file_non_sensitive_commits_git(client, tmp_path, monkeypatch):
    """PUT /contexts/{name}/files/... on a non-sensitive context must call git."""
    c, main_mod, git_stub = client

    # Mark as non-sensitive first
    c.patch("/contexts/alpha/sensitive", json={"sensitive": False}, headers=_auth(client))
    git_stub.commit_paths.reset_mock()

    resp = c.put(
        "/contexts/alpha/files/readme.md",
        content=b"# Hello",
        headers={**_auth(client), "content-type": "text/plain"},
    )
    assert resp.status_code == 200
    git_stub.commit_paths.assert_called_once()


def test_delete_context_file_sensitive_skips_git(client):
    """DELETE /contexts/{name}/files/... on sensitive context skips git."""
    c, _, git_stub = client
    # Write a file first (sensitive, so no git commit)
    c.put(
        "/contexts/alpha/files/to-delete.txt",
        content=b"bye",
        headers={**_auth(client), "content-type": "text/plain"},
    )
    git_stub.commit_paths.reset_mock()

    resp = c.delete("/contexts/alpha/files/to-delete.txt", headers=_auth(client))
    assert resp.status_code == 200
    git_stub.commit_paths.assert_not_called()


def test_delete_context_file_non_sensitive_commits_git(client):
    """DELETE /contexts/{name}/files/... on non-sensitive context commits git."""
    c, _, git_stub = client
    c.patch("/contexts/alpha/sensitive", json={"sensitive": False}, headers=_auth(client))
    c.put(
        "/contexts/alpha/files/to-delete.txt",
        content=b"bye",
        headers={**_auth(client), "content-type": "text/plain"},
    )
    git_stub.commit_paths.reset_mock()

    resp = c.delete("/contexts/alpha/files/to-delete.txt", headers=_auth(client))
    assert resp.status_code == 200
    git_stub.commit_paths.assert_called_once()
