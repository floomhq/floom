from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient


def _boot(tmp_path: Path):
    os.environ["WORKEROS_DB"] = str(tmp_path / "workeros.db")
    os.environ["FLOOM_DB"] = str(tmp_path / "workeros.db")
    os.environ["FLOOM_CONTEXTS_DIR"] = str(tmp_path / "contexts")
    os.environ["WORKEROS_DEPLOY"] = "local"
    os.environ["WORKEROS_USER_ID"] = "local-user"
    os.environ["FLOOM_SECRET"] = "workspace-profile-test-secret"
    import contexts
    import db
    import main

    importlib.reload(contexts)
    importlib.reload(db)
    db.init_db()
    db.get_repositories.cache_clear()
    for module_name in [x for x in list(sys.modules) if x.startswith("routers")]:
        sys.modules.pop(module_name, None)
    importlib.reload(main)
    return main, TestClient(main.app)


def _manifest(worker_id: str, title: str) -> dict[str, object]:
    return {
        "schema_version": "0.3",
        "name": worker_id,
        "title": title,
        "description": "Cleans Gmail and drafts replies.",
        "version": "0.1.0",
        "trigger": {"type": "manual"},
        "exec": {
            "entry": "run.py",
            "runtime": "python311",
            "runner": "e2b",
            "command": "python run.py",
        },
        "inputs": [],
        "outputs": [],
        "connections": ["gmail"],
        "secrets": ["GMAIL_REFRESH_TOKEN"],
    }


def test_public_workspace_profile_lists_only_public_workers_without_sensitive_fields():
    with tempfile.TemporaryDirectory(prefix="floom-workspace-profile-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        from auth.local_workspaces import ensure_default_workspace, update_local_workspace

        ensure_default_workspace("local-user")
        update_local_workspace("local-user", "local-default", name="Fede Secretary")
        repos = main.get_repositories()
        repos.workers.create(
            user_id="local-user",
            worker_id="gmail-inbox-cleaner",
            workspace_id="local-default",
            name="Gmail Inbox Cleaner",
            manifest_json=_manifest("gmail-inbox-cleaner", "Gmail Inbox Cleaner"),
        )
        repos.workers.create(
            user_id="local-user",
            worker_id="private-worker",
            workspace_id="local-default",
            name="Private Worker",
            manifest_json=_manifest("private-worker", "Private Worker"),
        )
        with main.get_db() as conn:
            conn.execute(
                "UPDATE workers SET visibility = 'public' WHERE id = ?",
                ("gmail-inbox-cleaner",),
            )

        resp = client.get("/workspaces/public/fede-secretary")

        assert resp.status_code == 200, resp.text
        assert resp.headers["x-robots-tag"] == "noindex, nofollow"
        body = resp.json()
        assert body["entity_type"] == "workspace_profile"
        assert body["workspace"] == {
            "id": "local-default",
            "name": "Fede Secretary",
            "handle": "fede-secretary",
            "profile_path": "/@fede-secretary",
        }
        assert body["counts"] == {"workers": 1, "assets": 1}
        assert body["assets"][0]["type"] == "worker"
        assert body["assets"][0]["share_path"].startswith("/w/gmail-inbox-cleaner?token=")
        assert body["workers"][0]["name"] == "Gmail Inbox Cleaner"
        assert body["workers"][0]["connections"] == ["gmail"]
        assert "private-worker" not in resp.text
        assert "local-user" not in resp.text
        assert "email" not in body.get("shared_by", {})
        assert "owner_id" not in resp.text
        assert "GMAIL_REFRESH_TOKEN" not in resp.text


def test_public_workspace_profile_404s_workspace_with_no_public_assets():
    with tempfile.TemporaryDirectory(prefix="floom-workspace-profile-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        from auth.local_workspaces import ensure_default_workspace, update_local_workspace

        ensure_default_workspace("local-user")
        update_local_workspace("local-user", "local-default", name="Private Secretary")
        repos = main.get_repositories()
        repos.workers.create(
            user_id="local-user",
            worker_id="private-worker",
            workspace_id="local-default",
            name="Private Worker",
            manifest_json=_manifest("private-worker", "Private Worker"),
        )

        resp = client.get("/workspaces/public/private-secretary")

        assert resp.status_code == 404
        assert "Private Secretary" not in resp.text
        assert "private-worker" not in resp.text


def test_public_workspace_profile_404s_unknown_handle():
    with tempfile.TemporaryDirectory(prefix="floom-workspace-profile-", ignore_cleanup_errors=True) as td:
        _main, client = _boot(Path(td))

        resp = client.get("/workspaces/public/missing-workspace")

        assert resp.status_code == 404


def _seed_public_and_private(main):
    """Create one public + one private worker in a named workspace. Returns handle."""
    from auth.local_workspaces import ensure_default_workspace, update_local_workspace

    ensure_default_workspace("local-user")
    update_local_workspace("local-user", "local-default", name="Fede Secretary")
    repos = main.get_repositories()
    repos.workers.create(
        user_id="local-user",
        worker_id="gmail-inbox-cleaner",
        workspace_id="local-default",
        name="Gmail Inbox Cleaner",
        manifest_json=_manifest("gmail-inbox-cleaner", "Gmail Inbox Cleaner"),
    )
    repos.workers.create(
        user_id="local-user",
        worker_id="private-worker",
        workspace_id="local-default",
        name="Private Worker",
        manifest_json=_manifest("private-worker", "Private Worker"),
    )
    with main.get_db() as conn:
        conn.execute(
            "UPDATE workers SET visibility = 'public' WHERE id = ?",
            ("gmail-inbox-cleaner",),
        )
    return "fede-secretary"


def test_public_worker_permalink_returns_public_card_only():
    with tempfile.TemporaryDirectory(prefix="floom-permalink-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        resp = client.get("/workers/public/by-handle/fede-secretary/gmail-inbox-cleaner")

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["entity_type"] == "worker_permalink"
        assert body["worker"]["name"] == "Gmail Inbox Cleaner"
        assert body["public_slug"] == "gmail-inbox-cleaner"
        assert body["permalink"] == "/@fede-secretary/gmail-inbox-cleaner"
        assert body["workspace"]["handle"] == "fede-secretary"
        # No sensitive leakage.
        assert "GMAIL_REFRESH_TOKEN" not in resp.text
        assert "owner_id" not in resp.text
        assert "local-user" not in resp.text


def test_public_worker_permalink_404s_private_worker():
    with tempfile.TemporaryDirectory(prefix="floom-permalink-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        # private-worker exists but is NOT public -> 404 (never confirms existence).
        resp = client.get("/workers/public/by-handle/fede-secretary/private-worker")

        assert resp.status_code == 404
        assert "Private Worker" not in resp.text
        assert "private-worker" not in resp.text


def test_public_worker_permalink_404s_unknown_handle_or_slug():
    with tempfile.TemporaryDirectory(prefix="floom-permalink-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        assert client.get("/workers/public/by-handle/nobody/gmail-inbox-cleaner").status_code == 404
        assert client.get("/workers/public/by-handle/fede-secretary/no-such-worker").status_code == 404
