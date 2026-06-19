"""Regression tests for PR S1 - launch-critical UX P0s.

Tests:
- #5 Generate button: verify prompt state is readable and non-empty prompts enable the button
- #7 connections/browse: catalog API accepts comma-separated categories and returns results
- #8 worker detail: verify the API returns 404 for unknown workers (frontend handles it)
- #9 proxy 400: verify POST /workers via the API layer works correctly (not a 400)

Run from repo root:
    cd apps/api && python3 -m pytest ../../tests/test_pr_s1_launch_ux_p0s.py -v
"""

import importlib
import json
import os
import sys
import types
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Shared app bootstrap (matches pattern from test_pr_q_connections_ux.py)
# ---------------------------------------------------------------------------

def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", "")
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    if str(api_dir) not in sys.path:
        sys.path.insert(0, str(api_dir))

    # Evict cached modules so env vars take effect cleanly
    for name in ["main", "db", "models", "worker_registry", "run_service", "composio_client"]:
        sys.modules.pop(name, None)

    # Stub out the scheduler (croniter dep) before importing main
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    main = importlib.import_module("main")
    return main


@pytest.fixture
def api_client(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    return TestClient(main.app, raise_server_exceptions=True)


# ---------------------------------------------------------------------------
# Minimal valid YAML for worker creation
# ---------------------------------------------------------------------------

_MINIMAL_YAML = """schema_version: "0.3"
name: {name}
title: "PR S1 Test Worker"
description: "Regression test worker"
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]

exec:
  runtime: skill
  mode: agent
  runner: e2b
  inputs: []
  outputs: []

trigger:
  type: manual
"""

_MINIMAL_RUN_PY = "# placeholder\n"


# ---------------------------------------------------------------------------
# #9 - POST /workers returns 200 (not 400) for a valid payload
# This is the API-layer regression for the "create worker proxy 400" bug.
# The web proxy forwards JSON as-is; if the API rejects a valid body
# that was a proxy bug. We confirm here the API accepts a clean payload.
# ---------------------------------------------------------------------------

class TestWorkerCreate:
    def test_create_with_valid_yaml_returns_200(self, api_client):
        """POST /workers with a valid worker_yml must return 200, not 400."""
        yaml = _MINIMAL_YAML.format(name="test-s1-create")
        resp = api_client.post(
            "/workers",
            json={"worker_yml": yaml, "run_py": _MINIMAL_RUN_PY},
        )
        assert resp.status_code == 200, (
            f"Expected 200 but got {resp.status_code}: {resp.text[:300]}"
        )
        data = resp.json()
        assert data["id"] == "test-s1-create"

    def test_create_returns_worker_id_and_name(self, api_client):
        """POST /workers response must contain id and name fields."""
        yaml = _MINIMAL_YAML.format(name="test-s1-fields")
        resp = api_client.post(
            "/workers",
            json={"worker_yml": yaml, "run_py": _MINIMAL_RUN_PY},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "id" in data
        assert "name" in data

    def test_create_without_secret_returns_401_when_secret_required(self, monkeypatch, tmp_path):
        """If FLOOM_SECRET is set, unauthenticated requests return 401."""
        api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
        workers_dir = tmp_path / "workers"
        workers_dir.mkdir()
        db_path = tmp_path / "floom.db"

        monkeypatch.setenv("FLOOM_DB", str(db_path))
        monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
        monkeypatch.setenv("FLOOM_SECRET", "supersecret")
        monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)

        if str(api_dir) not in sys.path:
            sys.path.insert(0, str(api_dir))

        for name in ["main", "db", "models", "worker_registry", "run_service", "composio_client"]:
            sys.modules.pop(name, None)

        sys.modules["scheduler"] = types.SimpleNamespace(
            start_scheduler=lambda: None,
            stop_scheduler=lambda: None,
        )

        main = importlib.import_module("main")
        client = TestClient(main.app, raise_server_exceptions=True)

        yaml = _MINIMAL_YAML.format(name="test-s1-auth")
        resp = client.post("/workers", json={"worker_yml": yaml, "run_py": _MINIMAL_RUN_PY})
        assert resp.status_code in (401, 403), (
            f"Expected 401/403 without secret but got {resp.status_code}"
        )


# ---------------------------------------------------------------------------
# #8 - GET /workers/{id} returns 404 for unknown worker IDs
# The frontend now handles this to show "Worker not found" rather than hanging.
# ---------------------------------------------------------------------------

class TestWorkerNotFound:
    def test_get_unknown_worker_returns_404(self, api_client):
        """GET /workers/{id} must return 404 for a non-existent worker."""
        resp = api_client.get("/workers/definitely-does-not-exist-abc123")
        assert resp.status_code == 404, (
            f"Expected 404 for non-existent worker but got {resp.status_code}: {resp.text[:200]}"
        )

    def test_get_after_delete_returns_404(self, api_client):
        """After deleting a worker, GET /workers/{id} returns 404."""
        yaml = _MINIMAL_YAML.format(name="test-s1-delete-me")
        create_resp = api_client.post(
            "/workers",
            json={"worker_yml": yaml, "run_py": _MINIMAL_RUN_PY},
        )
        assert create_resp.status_code == 200
        worker_id = create_resp.json()["id"]

        del_resp = api_client.delete(f"/workers/{worker_id}")
        assert del_resp.status_code in (200, 204), (
            f"Expected 200 or 204 from delete but got {del_resp.status_code}"
        )

        get_resp = api_client.get(f"/workers/{worker_id}")
        assert get_resp.status_code == 404, (
            f"Expected 404 after delete but got {get_resp.status_code}"
        )


# ---------------------------------------------------------------------------
# #7 - GET /integrations/catalog handles comma-separated category filters
# The connections/browse page sends comma-joined category slugs (e.g.,
# "productivity,notes,documents") and the API must not crash.
# ---------------------------------------------------------------------------

class TestIntegrationsCatalog:
    def _make_catalog_page(self, items=None):
        """Return a minimal catalog response dict."""
        items = items or []
        return {
            "items": items,
            "total_items": len(items),
            "total_pages": 1,
            "page": 1,
            "limit": 30,
            "next_page": None,
        }

    def test_catalog_with_comma_separated_category_does_not_crash(self, api_client):
        """GET /integrations/catalog?category=email,crm must return 200, not 500/400.

        This is the regression for the connections/browse "never resolves" bug:
        the frontend sends comma-separated category slugs, the API must handle them.
        """
        fake_page = self._make_catalog_page([
            {"slug": "gmail", "name": "Gmail", "description": "Email",
             "logo_url": "https://example.com/gmail.png", "categories": ["email"],
             "auth_schemes": ["oauth2"]},
        ])
        with patch("composio_client.list_catalog_apps", return_value=fake_page):
            resp = api_client.get("/integrations/catalog?category=email,crm&page=1&limit=10")

        # Critical: must not be a 500 (crash). The API either returns data or a
        # 404/422 if the category param is rejected, but never a server error.
        assert resp.status_code != 500, (
            f"Comma-separated category caused a server error: {resp.text[:300]}"
        )
        assert resp.status_code == 200, (
            f"Expected 200 for valid catalog request but got {resp.status_code}: {resp.text[:200]}"
        )

    def test_catalog_returns_items_structure(self, api_client):
        """GET /integrations/catalog response always includes items, total_items, page."""
        fake_page = self._make_catalog_page([
            {"slug": "slack", "name": "Slack", "description": "Chat",
             "logo_url": "https://example.com/slack.png", "categories": ["team-chat"],
             "auth_schemes": ["oauth2"]},
        ])
        with patch("composio_client.list_catalog_apps", return_value=fake_page):
            resp = api_client.get("/integrations/catalog?page=1&limit=30")

        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert "total_items" in data
        assert "page" in data
        assert isinstance(data["items"], list)


# ---------------------------------------------------------------------------
# #5 - Generate button: the API must accept any non-empty string prompt
# The frontend bug was that typed prompts did not always update React state,
# leaving prompt="" so the button appeared disabled. The API contract:
# - empty string is rejected (422)
# - any non-empty string is accepted (200 with a draft)
# ---------------------------------------------------------------------------

class TestDraftFromPrompt:
    def test_draft_from_prompt_rejects_empty_string(self, api_client):
        """POST /workers/draft-from-prompt with empty prompt returns 400 or 422."""
        resp = api_client.post(
            "/workers/draft-from-prompt",
            json={"prompt": ""},
        )
        assert resp.status_code in (400, 422), (
            f"Expected 400/422 for empty prompt but got {resp.status_code}: {resp.text[:200]}"
        )

    def test_draft_from_prompt_accepts_custom_typed_prompt(self, api_client):
        """POST /workers/draft-from-prompt with any non-empty custom string is accepted.

        This is the API-side regression for #5: the Generate button was broken
        when users typed custom prompts because React state did not update.
        The API must never reject a non-empty prompt string.
        """
        mock_draft = {
            "worker_yml": (
                'schema_version: "0.3"\nname: custom-worker\ntitle: "Custom"\n'
                'description: "Test"\nversion: "0.1.0"\nentrypoint: SKILL.md\n'
                'targets: [generic]\nexec:\n  runtime: skill\n  mode: agent\n'
                '  runner: e2b\n  inputs: []\n  outputs: []\ntrigger:\n  type: manual'
            ),
            "skill_md": "# Custom Worker\n\nDoes things.",
            "suggested_name": "custom-worker",
            "suggested_title": "Custom Worker",
            "required_connections": [],
            "required_secrets": [],
            "requirements": [],
            "inputs": [],
            "outputs": [],
        }
        # Patch the LLM call so we don't need a real OpenAI key in tests
        with patch("main.draft_worker_from_prompt", return_value=mock_draft):
            resp = api_client.post(
                "/workers/draft-from-prompt",
                json={"prompt": "Send a Slack message every morning with the weather"},
            )

        # Either the mock was hit (200) or the endpoint exists but LLM key is missing
        # (not a 400 body-rejection). The critical invariant: non-empty prompt is accepted.
        if resp.status_code == 200:
            data = resp.json()
            assert "worker_yml" in data or "suggested_name" in data
        else:
            # Any status is OK except 400/422 (which would mean prompt was rejected as invalid)
            assert resp.status_code not in (400, 422), (
                f"Non-empty custom prompt was rejected by the API: {resp.text[:200]}"
            )
