"""Tests for the run-authenticated Composio tool-execute proxy
(POST /runs/{run_id}/composio-execute/{tool_slug}).

Security focus (2026-05-29 referee FIX 1):
  - The connection fallback MUST resolve the run-OWNER's active connection,
    never "first active connection for the app". Single-tenant must keep
    working; multi-tenant must not cross owners.
  - An unknown/garbage run_id MUST be rejected (404), never fall through to
    picking some connection.
  - A run that is not RUNNING MUST be rejected (403).

Run from repo root:
    cd apps/api && python3 -m pytest ../../tests/test_composio_execute_owner_scope.py -x -q
"""

import importlib
import sys
import types
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


AUTH_HEADERS = {"x-floom-secret": "test-secret-composio-exec"}


def _load_api(monkeypatch, tmp_path):
    api_dir = Path(__file__).resolve().parents[1] / "apps" / "api"
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-key")
    monkeypatch.setenv("FLOOM_SECRET", AUTH_HEADERS["x-floom-secret"])

    sys.path.insert(0, str(api_dir))
    for name in ["main", "db", "models", "worker_registry", "run_service", "composio_client"]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    main = importlib.import_module("main")
    return main


def _valid_manifest(worker_id: str) -> dict:
    import yaml as _yaml

    return _yaml.safe_load(
        f"""\
schema_version: "0.3"
name: {worker_id}
title: "{worker_id}"
description: "owner-scope proxy test worker"
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]

exec:
  runtime: skill
  mode: agent
  runner: e2b
  entrypoint: SKILL.md
  inputs: []
  outputs: []

trigger:
  type: manual
"""
    )


def _seed_worker(main, *, owner_id: str) -> str:
    """Create a worker owned by ``owner_id``; return its id."""
    repos = main.get_repositories()
    worker_id = f"wk{uuid.uuid4().hex[:8]}"
    repos.workers.upsert(
        user_id=owner_id,
        worker_id=worker_id,
        name=worker_id,
        manifest_json=_valid_manifest(worker_id),
        trigger_type="manual",
    )
    return worker_id


def _seed_running_run(main, *, owner_id: str, worker_id: str) -> str:
    """Create a RUNNING run for ``worker_id``; return run id."""
    repos = main.get_repositories()
    run_id = f"run_{uuid.uuid4().hex[:8]}"
    repos.runs.create(
        user_id=owner_id,
        worker_id=worker_id,
        run_id=run_id,
        status=main.RunStatus.RUNNING.value,
        trigger_source="manual",
        runner="local",
    )
    return run_id


def _seed_connection(main, *, owner_id: str, app_name: str, composio_connection_id: str) -> None:
    """Insert an active Composio connection for ``owner_id``."""
    repos = main.get_repositories()
    repos.connections.upsert(
        user_id=owner_id,
        id=f"conn_{uuid.uuid4().hex[:8]}",
        app_name=app_name,
        composio_connection_id=composio_connection_id,
        status="active",
    )


def _patch_composio_post():
    """Patch the outbound requests.post Composio call; capture the body sent."""
    captured = {}

    class _FakeResp:
        def json(self):
            return {"ok": True}

    def _fake_post(url, headers=None, json=None, timeout=None):  # noqa: A002
        captured["url"] = url
        captured["json"] = json
        return _FakeResp()

    return captured, _fake_post


class TestComposioExecuteOwnerScope:
    def test_resolves_run_owners_connection_not_first_active(self, monkeypatch, tmp_path):
        """The fallback must pick the RUN-OWNER's connection, even when another
        owner has an active connection for the same app."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        # Owner A owns the run; Owner B is a different tenant with their OWN
        # active gmail connection that must NEVER be selected for A's run.
        owner_a = "federico"  # single-tenant bootstrap owner
        owner_b = "other-tenant"

        worker_a = _seed_worker(main, owner_id=owner_a)
        run_a = _seed_running_run(main, owner_id=owner_a, worker_id=worker_a)
        _seed_connection(main, owner_id=owner_b, app_name="gmail", composio_connection_id="CONN_B_SHOULD_NOT_BE_USED")
        _seed_connection(main, owner_id=owner_a, app_name="gmail", composio_connection_id="CONN_A_CORRECT")

        captured, fake_post = _patch_composio_post()
        with patch("requests.post", side_effect=fake_post):
            resp = client.post(
                f"/runs/{run_a}/composio-execute/GMAIL_SEND_EMAIL",
                json={"arguments": {"to": "x@example.com"}},
            )

        assert resp.status_code == 200, resp.text
        # Single-tenant still works AND the OWNER's connection is used.
        assert captured["json"]["connected_account_id"] == "CONN_A_CORRECT"
        assert captured["json"]["connected_account_id"] != "CONN_B_SHOULD_NOT_BE_USED"

    def test_unknown_run_id_rejected(self, monkeypatch, tmp_path):
        """A garbage run_id must 404, never fall through to a connection lookup."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)
        # Seed an unrelated active connection so a buggy fallback would have
        # something to grab.
        _seed_connection(main, owner_id="federico", app_name="gmail", composio_connection_id="CONN_X")

        captured, fake_post = _patch_composio_post()
        with patch("requests.post", side_effect=fake_post):
            resp = client.post(
                f"/runs/nonexistent_{uuid.uuid4().hex}/composio-execute/GMAIL_SEND_EMAIL",
                json={"arguments": {}},
            )

        assert resp.status_code == 404, resp.text
        # Proxy must NOT have been called.
        assert "url" not in captured

    def test_non_running_run_rejected(self, monkeypatch, tmp_path):
        """A run that exists but is not RUNNING must 403."""
        main = _load_api(monkeypatch, tmp_path)
        client = TestClient(main.app, raise_server_exceptions=True)

        owner = "federico"
        worker = _seed_worker(main, owner_id=owner)
        repos = main.get_repositories()
        run_id = f"run_{uuid.uuid4().hex[:8]}"
        repos.runs.create(
            user_id=owner,
            worker_id=worker,
            run_id=run_id,
            status=main.RunStatus.COMPLETED.value,
            trigger_source="manual",
            runner="local",
        )

        captured, fake_post = _patch_composio_post()
        with patch("requests.post", side_effect=fake_post):
            resp = client.post(
                f"/runs/{run_id}/composio-execute/GMAIL_SEND_EMAIL",
                json={"arguments": {}},
            )

        assert resp.status_code == 403, resp.text
        assert "url" not in captured
