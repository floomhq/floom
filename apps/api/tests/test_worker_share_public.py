from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

_TEST_DIR = Path(tempfile.mkdtemp(prefix="workeros-worker-share-test-"))
os.environ["WORKEROS_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["FLOOM_DB"] = str(_TEST_DIR / "workeros.db")
os.environ["WORKEROS_DEPLOY"] = "local"
os.environ["WORKEROS_API_ENV_FILE"] = str(_TEST_DIR / "api.env")
os.environ["FLOOM_SECRET"] = "worker-share-test-secret"

import main  # noqa: E402


# A full worker dict as repos.workers.get_any would return it: it intentionally
# carries fields that MUST NOT leak to the public surface (secrets, source,
# owner_id, webhook config, MCP urls/env).
_WORKER = {
    "id": "weekly-digest",
    "owner_id": "local-user",
    "name": "Weekly Digest",
    "description": "Sends a weekly digest.",
    "long_description": "A worker that compiles a weekly digest from your inbox.",
    "use_cases": ["Monday morning recap"],
    "how_it_works": "Reads Gmail, summarizes, emails you.",
    "is_example": False,
    "tags": ["email", "digest"],
    "trigger_type": "schedule",
    "runner": "e2b",
    "enabled": True,
    "config": {
        "id": "weekly-digest",
        "name": "Weekly Digest",
        "trigger": {"type": "schedule", "cron": "0 9 * * 1"},
        "runtime": {
            "type": "skill",
            "entrypoint": "run.py",
            # Sensitive internals that must never reach the public response:
            "bundle_path": "/opt/workeros/workers/weekly-digest",
            "system_prompt": "INTERNAL SYSTEM PROMPT — do not leak",
            "model": "claude-opus",
        },
        "secrets": ["OPENAI_API_KEY", "INTERNAL_TOKEN"],
        "connections": [
            "gmail",
            {
                "mcp": {
                    "label": "internal-tools",
                    "url": "https://secret-internal.example.com/mcp",
                    "env": {"API_KEY": "sk-super-secret"},
                    "auth": "bearer:INTERNAL_TOKEN",
                }
            },
        ],
        "contexts": [],
        "inputs": [
            {
                "name": "topic",
                "label": "Topic",
                "type": "string",
                "required": True,
                "description": "What to summarize",
            }
        ],
        "outputs": [
            {"name": "digest", "label": "Digest", "type": "markdown"}
        ],
    },
}


class _WorkersRepo:
    def get_any(self, *, worker_id: str):
        return _WORKER if worker_id == _WORKER["id"] else None


class _Repos:
    workers = _WorkersRepo()


def _client() -> TestClient:
    main.app.dependency_overrides[main.get_repos] = lambda: _Repos()
    return TestClient(main.app)


def _clear():
    main.app.dependency_overrides.clear()


def test_valid_token_returns_only_safe_allowlisted_fields():
    token = main._worker_public_token(_WORKER)
    try:
        client = _client()
        resp = client.get(f"/workers/public/{_WORKER['id']}?token={token}")
    finally:
        _clear()

    assert resp.status_code == 200
    body = resp.json()

    # Allow-listed fields present and correct.
    assert body["id"] == "weekly-digest"
    assert body["name"] == "Weekly Digest"
    assert body["description"] == "Sends a weekly digest."
    assert body["long_description"].startswith("A worker that compiles")
    assert body["use_cases"] == ["Monday morning recap"]
    assert body["how_it_works"].startswith("Reads Gmail")
    assert body["tags"] == ["email", "digest"]
    assert body["trigger_type"] == "schedule"
    assert body["runtime"] == "skill"
    # Connections: Composio slug + MCP LABEL only (no url/env/auth).
    assert body["connections"] == ["gmail", "internal-tools"]
    assert [i["name"] for i in body["inputs"]] == ["topic"]
    assert body["outputs"][0]["type"] == "markdown"

    # The public payload is a strict allow-list — these keys must be absent.
    forbidden_keys = {
        "owner_id", "secrets", "config", "files", "run_py", "run_py_content",
        "skill_md_content", "manifest_yaml", "recent_runs", "webhook_url",
        "public_link", "new_webhook_secret",
    }
    assert forbidden_keys.isdisjoint(body.keys()), body.keys()

    # And no sensitive VALUE leaks anywhere in the serialized response.
    blob = resp.text
    for needle in (
        "OPENAI_API_KEY", "INTERNAL_TOKEN", "sk-super-secret", "sk-leak-me",
        "secret-internal.example.com", "INTERNAL SYSTEM PROMPT",
        "/opt/workeros/workers", "local-user", "bundle_path", "system_prompt",
    ):
        assert needle not in blob, f"leaked: {needle}"


def test_bad_token_is_rejected():
    try:
        client = _client()
        resp = client.get(f"/workers/public/{_WORKER['id']}?token={'0' * 64}")
    finally:
        _clear()
    assert resp.status_code == 401


def test_missing_token_is_rejected():
    try:
        client = _client()
        resp = client.get(f"/workers/public/{_WORKER['id']}")
    finally:
        _clear()
    # Query param is required (min_length=16) -> 422 validation error.
    assert resp.status_code == 422


def test_unknown_worker_is_not_found_even_with_a_token():
    # A token computed for a non-existent worker still 404s (worker resolves first).
    token = main._worker_public_token({"id": "ghost", "owner_id": "local-user"})
    try:
        client = _client()
        resp = client.get(f"/workers/public/ghost?token={token}")
    finally:
        _clear()
    assert resp.status_code == 404


def test_token_is_bound_to_owner():
    # Same id, different owner -> token mismatch -> 401. Guards against a link
    # minted for owner A resolving a same-id worker owned by B.
    other_owner_token = main._worker_public_token(
        {"id": _WORKER["id"], "owner_id": "someone-else"}
    )
    try:
        client = _client()
        resp = client.get(f"/workers/public/{_WORKER['id']}?token={other_owner_token}")
    finally:
        _clear()
    assert resp.status_code == 401
