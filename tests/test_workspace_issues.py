"""Regression tests for GitHub-backed workspace issues (issue #1773).

Covers the versioned metadata marker, the GitHub-issue projection, the thin
github_api issue adapter (PR filtering), the "GitHub not connected" guard, and
the HTTP router round-trip with a faked GitHub backend.
"""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

# Point at the API source before importing backend modules.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name
os.environ.pop("FLOOM_SECRET", None)  # dev mode — no auth header needed

import db  # noqa: E402
db.DB_PATH = _tmp_db.name

import github_api  # noqa: E402
import services.workspace_issues as wi  # noqa: E402


# ---------------------------------------------------------------------------
# Metadata marker (versioned, stable)
# ---------------------------------------------------------------------------

def test_marker_roundtrip_recovers_all_fields():
    marker = wi.build_metadata_marker("ws_1", "worker", "gmail-inbox-manager", "run_failure")
    assert "floom:issue" in marker
    parsed = wi.parse_metadata_marker(f"some body text\n\n{marker}")
    assert parsed == {
        "version": wi.MARKER_VERSION,
        "workspace_id": "ws_1",
        "asset_type": "worker",
        "asset_id": "gmail-inbox-manager",
        "source": "run_failure",
    }


def test_marker_omits_empty_fields():
    marker = wi.build_metadata_marker(workspace_id="ws_1")
    parsed = wi.parse_metadata_marker(marker)
    assert parsed == {"version": wi.MARKER_VERSION, "workspace_id": "ws_1"}
    assert "asset_type" not in parsed


def test_parse_marker_absent_returns_none():
    assert wi.parse_metadata_marker("just a plain issue body") is None
    assert wi.parse_metadata_marker("") is None
    assert wi.parse_metadata_marker(None) is None


def test_parse_marker_tolerates_unknown_version():
    body = "<!-- floom:issue\nversion: 99\nworkspace_id: ws_x\nfuture_field: hi\n-->"
    parsed = wi.parse_metadata_marker(body)
    assert parsed["version"] == 99
    assert parsed["workspace_id"] == "ws_x"
    assert parsed["future_field"] == "hi"


def test_strip_marker_leaves_clean_body():
    marker = wi.build_metadata_marker("ws_1", "context", "policies/refund.md")
    assert wi.strip_metadata_marker(f"This file is stale.\n\n{marker}") == "This file is stale."


def test_compose_body_is_idempotent_on_marker():
    """Re-composing a body that already has a marker must not stack markers."""
    once = wi.compose_issue_body("hello", "ws_1", "worker", "w1", "src")
    twice = wi.compose_issue_body(once, "ws_1", "worker", "w1", "src")
    assert twice.count("floom:issue") == 1
    assert wi.parse_metadata_marker(twice)["asset_id"] == "w1"


# ---------------------------------------------------------------------------
# Labels + projection
# ---------------------------------------------------------------------------

def test_derive_labels_dedups_and_includes_base():
    labels = wi.derive_labels("worker", ["needs-attention", "floom"])
    assert labels == ["floom", "workspace", "worker", "needs-attention"]


def test_project_issue_uses_marker_binding():
    marker = wi.build_metadata_marker("ws_marker", "worker", "gmail", "run_failure")
    raw = {
        "number": 42,
        "title": "Worker failed twice",
        "body": f"It failed again.\n\n{marker}",
        "state": "open",
        "html_url": "https://github.com/o/r/issues/42",
        "labels": [{"name": "floom"}, {"name": "worker"}],
        "user": {"login": "alice"},
        "created_at": "t1",
        "updated_at": "t2",
    }
    issue = wi.project_issue(raw, workspace_id="ws_fallback")
    assert issue.github_issue_number == 42
    assert issue.workspace_id == "ws_marker"  # marker wins over fallback
    assert issue.asset_type == "worker"
    assert issue.asset_id == "gmail"
    assert issue.source == "run_failure"
    assert issue.body == "It failed again."  # marker stripped from display body
    assert issue.created_by == "alice"


def test_project_issue_falls_back_to_label_when_no_marker():
    raw = {
        "number": 5,
        "title": "Filed on GitHub directly",
        "body": "no marker here",
        "state": "closed",
        "html_url": "https://github.com/o/r/issues/5",
        "labels": [{"name": "floom"}, {"name": "run"}],
    }
    issue = wi.project_issue(raw, workspace_id="ws_fallback")
    assert issue.asset_type == "run"  # recovered from label
    assert issue.asset_id is None
    assert issue.workspace_id == "ws_fallback"


# ---------------------------------------------------------------------------
# github_api issue adapter
# ---------------------------------------------------------------------------

def test_list_issues_excludes_pull_requests(monkeypatch):
    captured = {}

    def fake_call(method, path, pat, body=None, timeout=15):
        captured["path"] = path
        return [
            {"number": 1, "title": "real issue"},
            {"number": 2, "title": "a PR", "pull_request": {"url": "x"}},
        ]

    monkeypatch.setattr(github_api, "_call", fake_call)
    out = github_api.list_issues("pat", "o/r", state="open", labels=["floom"])
    assert [i["number"] for i in out] == [1]
    assert "state=open" in captured["path"]
    assert "labels=floom" in captured["path"]


def test_update_issue_rejects_bad_state(monkeypatch):
    monkeypatch.setattr(github_api, "_call", lambda *a, **k: {})
    with pytest.raises(github_api.GitHubAPIError):
        github_api.update_issue("pat", "o/r", 1, state="bogus")


def test_list_issues_follows_pagination(monkeypatch):
    # Two full pages of 2 then a short page -> all collected, stops after short.
    pages = {
        "1": [{"number": 1}, {"number": 2}],
        "2": [{"number": 3}, {"number": 4}],
        "3": [{"number": 5}],
    }
    seen_pages: list[str] = []

    def fake_call(method, path, pat, body=None, timeout=15):
        import urllib.parse as _u
        page = _u.parse_qs(_u.urlparse(path).query)["page"][0]
        seen_pages.append(page)
        return pages.get(page, [])

    monkeypatch.setattr(github_api, "_call", fake_call)
    out = github_api.list_issues("pat", "o/r", per_page=2)
    assert [i["number"] for i in out] == [1, 2, 3, 4, 5]
    assert seen_pages == ["1", "2", "3"]  # stopped on the short page


def test_ensure_labels_ignores_already_exists(monkeypatch):
    attempted: list[str] = []

    def fake_create_label(pat, repo, name, color="ededed", description=None):
        attempted.append(name)
        if name == "floom":  # simulate "already exists"
            raise github_api.GitHubAPIError("already_exists", 422)
        return {"name": name}

    monkeypatch.setattr(github_api, "create_label", fake_create_label)
    # 422 is swallowed; the loop still tries every label.
    github_api.ensure_labels("pat", "o/r", ["floom", "workspace"])
    assert attempted == ["floom", "workspace"]


def test_ensure_labels_propagates_non_422(monkeypatch):
    def fake_create_label(pat, repo, name, color="ededed", description=None):
        raise github_api.GitHubAPIError("server error", 500)

    monkeypatch.setattr(github_api, "create_label", fake_create_label)
    with pytest.raises(github_api.GitHubAPIError):
        github_api.ensure_labels("pat", "o/r", ["floom"])


# ---------------------------------------------------------------------------
# Service: connection guard + create
# ---------------------------------------------------------------------------

def test_resolve_connection_raises_without_pat(monkeypatch):
    from services import git_service

    monkeypatch.setattr(git_service, "_git_cfg_get", lambda uid: None)
    with pytest.raises(wi.GitHubNotConnected):
        wi.resolve_connection("u1")


def test_resolve_connection_raises_without_repo(monkeypatch):
    from services import git_service

    monkeypatch.setattr(git_service, "_git_cfg_get", lambda uid: {"github_pat": "pat"})
    with pytest.raises(wi.GitHubNotConnected) as exc:
        wi.resolve_connection("u1")
    assert "repository" in str(exc.value).lower()


def test_create_workspace_issue_embeds_marker_and_labels(monkeypatch):
    from services import git_service

    monkeypatch.setattr(
        git_service, "_git_cfg_get",
        lambda uid: {"github_pat": "pat", "repo_full_name": "o/r"},
    )
    monkeypatch.setattr(git_service, "_git_workspace_key", lambda uid: "ws_test")

    sent = {}

    def fake_create_issue(pat, repo, title, body, labels):
        sent.update(pat=pat, repo=repo, title=title, body=body, labels=labels)
        return {
            "number": 7,
            "title": title,
            "body": body,
            "state": "open",
            "html_url": "https://github.com/o/r/issues/7",
            "labels": [{"name": x} for x in labels],
        }

    ensured: list[list[str]] = []
    monkeypatch.setattr(github_api, "create_issue", fake_create_issue)
    monkeypatch.setattr(github_api, "ensure_labels", lambda pat, repo, labels: ensured.append(list(labels)))

    issue = wi.create_workspace_issue(
        "u1", title="Reconnect gmail", body="needs reconnect",
        asset_type="connection", asset_id="gmail", source="needs_attention",
    )
    assert issue.github_issue_number == 7
    assert issue.asset_type == "connection"
    assert issue.asset_id == "gmail"
    # marker embedded in what was sent to GitHub
    parsed = wi.parse_metadata_marker(sent["body"])
    assert parsed["workspace_id"] == "ws_test"
    assert parsed["asset_id"] == "gmail"
    assert "floom" in sent["labels"] and "connection" in sent["labels"]
    # labels are ensured to exist before the issue references them
    assert ensured and "floom" in ensured[0] and "connection" in ensured[0]


def _patch_floom_repo(monkeypatch):
    from services import git_service

    monkeypatch.setattr(
        git_service, "_git_cfg_get",
        lambda uid: {"github_pat": "pat", "repo_full_name": "o/r"},
    )
    monkeypatch.setattr(git_service, "_git_workspace_key", lambda uid: "ws_test")


def test_update_workspace_issue_preserves_floom_and_asset_label(monkeypatch):
    _patch_floom_repo(monkeypatch)

    # The existing issue is a worker-bound Floom issue (marker + labels).
    marker = wi.build_metadata_marker("ws_test", "worker", "w1")
    existing_raw = {
        "number": 1, "title": "t", "body": f"failed\n\n{marker}", "state": "open",
        "html_url": "https://github.com/o/r/issues/1",
        "labels": [{"name": "floom"}, {"name": "workspace"}, {"name": "worker"}],
    }

    sent = {}

    def fake_update_issue(pat, repo, number, title=None, body=None, state=None, labels=None):
        sent.update(labels=labels)
        return {
            "number": number, "title": "t", "body": "b", "state": "open",
            "html_url": "https://github.com/o/r/issues/1",
            "labels": [{"name": x} for x in (labels or [])],
        }

    monkeypatch.setattr(github_api, "get_issue", lambda *a, **k: existing_raw)
    monkeypatch.setattr(github_api, "update_issue", fake_update_issue)
    monkeypatch.setattr(github_api, "ensure_labels", lambda *a, **k: None)

    # Caller tries to set labels to just ['bug']; floom (visibility) and the
    # worker asset label (GitHub-native asset filtering) must both survive.
    wi.update_workspace_issue("u1", 1, labels=["bug"])
    assert "floom" in sent["labels"]
    assert "worker" in sent["labels"]
    assert "bug" in sent["labels"]


def test_mutations_refuse_non_floom_issue(monkeypatch):
    _patch_floom_repo(monkeypatch)

    # A plain repo issue with no floom label and no marker.
    plain = {
        "number": 9, "title": "unrelated", "body": "regular issue", "state": "open",
        "html_url": "https://github.com/o/r/issues/9", "labels": [{"name": "bug"}],
    }
    monkeypatch.setattr(github_api, "get_issue", lambda *a, **k: plain)
    # If a mutation slipped through these would be called; make them explode.
    monkeypatch.setattr(github_api, "create_issue_comment", lambda *a, **k: pytest.fail("commented"))
    monkeypatch.setattr(github_api, "update_issue", lambda *a, **k: pytest.fail("updated"))

    with pytest.raises(ValueError):
        wi.comment_on_issue("u1", 9, "hi")
    with pytest.raises(ValueError):
        wi.update_workspace_issue("u1", 9, state="closed")


def test_mutations_allow_marker_only_issue(monkeypatch):
    """An issue with a marker but a stripped 'floom' label is still ours."""
    _patch_floom_repo(monkeypatch)

    marker = wi.build_metadata_marker("ws_test", "run", "run_1")
    raw = {
        "number": 3, "title": "t", "body": f"x\n\n{marker}", "state": "open",
        "html_url": "https://github.com/o/r/issues/3", "labels": [],
    }
    monkeypatch.setattr(github_api, "get_issue", lambda *a, **k: raw)
    called = {}

    def fake_comment(pat, repo, number, body):
        called["c"] = (number, body)
        return {"id": 1, "html_url": "u"}

    monkeypatch.setattr(github_api, "create_issue_comment", fake_comment)
    wi.comment_on_issue("u1", 3, "noted")
    assert called["c"] == (3, "noted")


# ---------------------------------------------------------------------------
# HTTP router round-trip (faked GitHub backend)
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    import main as app_module
    from fastapi.testclient import TestClient

    return TestClient(app_module.app, raise_server_exceptions=True)


def test_list_endpoint_explains_when_not_connected(client, monkeypatch):
    from services import git_service

    monkeypatch.setattr(git_service, "_git_cfg_get", lambda uid: None)
    resp = client.get("/workspace/issues")
    assert resp.status_code == 400
    assert "not connected" in resp.json()["detail"].lower()


def test_create_then_list_roundtrip(client, monkeypatch):
    from services import git_service

    store: list[dict] = []
    monkeypatch.setattr(
        git_service, "_git_cfg_get",
        lambda uid: {"github_pat": "pat", "repo_full_name": "o/r"},
    )

    def fake_create_issue(pat, repo, title, body, labels):
        row = {
            "number": len(store) + 1,
            "title": title,
            "body": body,
            "state": "open",
            "html_url": f"https://github.com/o/r/issues/{len(store) + 1}",
            "labels": [{"name": x} for x in labels],
        }
        store.append(row)
        return row

    def fake_list_issues(pat, repo, state="all", labels=None, per_page=100):
        return list(store)

    monkeypatch.setattr(github_api, "create_issue", fake_create_issue)
    monkeypatch.setattr(github_api, "list_issues", fake_list_issues)
    monkeypatch.setattr(github_api, "ensure_labels", lambda *a, **k: None)

    created = client.post(
        "/workspace/issues",
        json={"title": "Worker failed", "asset_type": "worker", "asset_id": "w1"},
    )
    assert created.status_code == 201, created.text
    assert created.json()["asset_id"] == "w1"

    listed = client.get("/workspace/issues", params={"asset_type": "worker", "asset_id": "w1"})
    assert listed.status_code == 200
    body = listed.json()
    assert len(body) == 1
    assert body[0]["github_issue_number"] == 1
    assert body[0]["asset_type"] == "worker"

    # filter that matches nothing returns empty
    none = client.get("/workspace/issues", params={"asset_id": "other"})
    assert none.json() == []
