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
    os.environ["FLOOM_WORKERS_DIR"] = str(tmp_path / "workers")
    os.environ["WORKEROS_DEPLOY"] = "local"
    os.environ["WORKEROS_USER_ID"] = "local-user"
    os.environ["FLOOM_SECRET"] = "workspace-profile-test-secret"
    for module_name in ("worker_registry", "services.worker_registry_ops"):
        sys.modules.pop(module_name, None)
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
        # URL consistency (Fede 2026-07-06): a public worker's card always
        # points at its canonical /@handle/slug permalink now, never the
        # legacy /w/<id>?token=<hmac> link, every asset here is already
        # confirmed public (list_public_for_workspace only returns
        # visibility='public' rows), so there's no access-control reason to
        # keep minting the legacy HMAC form.
        assert body["assets"][0]["share_path"] == "/@fede-secretary/gmail-inbox-cleaner"
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


def test_import_from_permalink_refuses_private_worker():
    with tempfile.TemporaryDirectory(prefix="floom-permalink-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        # A private worker must not be clonable via its handle+slug even by an
        # authed caller (the endpoint only ever resolves visibility='public').
        resp = client.post(
            "/workers/import-from-permalink",
            headers={"x-floom-secret": "workspace-profile-test-secret"},
            json={"handle": "fede-secretary", "worker_slug": "private-worker"},
        )
        assert resp.status_code == 404
        assert "private-worker" not in resp.text


def test_register_worker_from_files_persists_only_new_worker():
    with tempfile.TemporaryDirectory(prefix="floom-register-one-", ignore_cleanup_errors=True) as td:
        main, _client = _boot(Path(td))
        from models import DraftFile
        from services.worker_registry_ops import _register_worker_from_files
        from worker_registry import WORKERS_DIR

        stale_dir = WORKERS_DIR / "stale-import"
        stale_dir.mkdir(parents=True)
        stale_dir.joinpath("worker.yml").write_text(
            """
schema_version: "0.3"
name: stale-import
title: Stale Import
description: Old import directory
version: 0.1.0
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
trigger:
  type: manual
""".strip()
            + "\n",
            encoding="utf-8",
        )

        created_id = _register_worker_from_files(
            [
                DraftFile(
                    path="worker.yml",
                    content="""
schema_version: "0.3"
name: fresh-import
title: Fresh Import
description: New import directory
version: 0.1.0
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
trigger:
  type: manual
""".strip()
                    + "\n",
                )
            ],
            user_id="local-user",
            repos=main.get_repositories(),
            dedupe_id=True,
        )

        rows = main.get_repositories().workers.list(user_id="local-user")
        assert created_id == "fresh-import"
        assert [row["id"] for row in rows] == ["fresh-import"]


def test_import_from_permalink_is_idempotent_for_same_workspace_and_source():
    with tempfile.TemporaryDirectory(prefix="floom-permalink-import-idem-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        first = client.post(
            "/workers/import-from-permalink",
            headers=_auth_headers(),
            json={"handle": "fede-secretary", "worker_slug": "gmail-inbox-cleaner"},
        )
        assert first.status_code == 200, first.text

        second = client.post(
            "/workers/import-from-permalink",
            headers=_auth_headers(),
            json={"handle": "@fede-secretary", "worker_slug": "gmail-inbox-cleaner"},
        )
        assert second.status_code == 200, second.text
        assert second.json()["worker_id"] == first.json()["worker_id"]

        imported = []
        for row in main.get_repositories().workers.list(user_id="local-user"):
            manifest = row.get("manifest_json") or row.get("manifest") or {}
            if isinstance(manifest, dict) and manifest.get("import_source", {}).get("kind") == "permalink":
                imported.append(row)
        assert [row["id"] for row in imported] == [first.json()["worker_id"]]


# --- One URL per worker forever: ?share=<token> unguessable-key access -----
# (Fede 2026-07-06: "access is a property, not a URL namespace")


def _auth_headers():
    return {"x-floom-secret": "workspace-profile-test-secret"}


def test_private_worker_permalink_404s_bare_identical_to_unknown_slug():
    """A private worker's bare permalink 404s exactly like a nonexistent slug
    (no share token); the response body must not differ, so existence is
    never confirmed either way."""
    with tempfile.TemporaryDirectory(prefix="floom-permalink-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        private_resp = client.get("/workers/public/by-handle/fede-secretary/private-worker")
        unknown_resp = client.get("/workers/public/by-handle/fede-secretary/does-not-exist")

        assert private_resp.status_code == 404 == unknown_resp.status_code
        assert private_resp.json() == unknown_resp.json()


def test_private_worker_permalink_with_valid_share_token_resolves():
    with tempfile.TemporaryDirectory(prefix="floom-permalink-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        mint = client.post(
            "/workers/private-worker/share-link",
            headers=_auth_headers(),
        )
        assert mint.status_code == 200, mint.text
        token = mint.json()["token"]
        share_url = mint.json()["url"]
        assert share_url.endswith(f"/@fede-secretary/private-worker?share={token}")

        resp = client.get(f"/workers/public/by-handle/fede-secretary/private-worker?share={token}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["worker"]["name"] == "Private Worker"
        assert body["access"] == "shared_link"
        assert "GMAIL_REFRESH_TOKEN" not in resp.text
        assert "local-user" not in resp.text


def test_private_worker_permalink_with_invalid_share_token_404s_identically():
    with tempfile.TemporaryDirectory(prefix="floom-permalink-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        bad_token_resp = client.get(
            "/workers/public/by-handle/fede-secretary/private-worker?share=fls_totally-bogus-token-value"
        )
        no_token_resp = client.get("/workers/public/by-handle/fede-secretary/private-worker")

        assert bad_token_resp.status_code == 404 == no_token_resp.status_code
        assert bad_token_resp.json() == no_token_resp.json()


def test_share_token_does_not_unlock_a_different_worker():
    """A valid token for worker A must not grant access to worker B's slug:
    the token is checked against THIS worker's (entity_id, owner_id), not just
    "any live token"."""
    with tempfile.TemporaryDirectory(prefix="floom-permalink-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)
        repos = main.get_repositories()
        repos.workers.create(
            user_id="local-user",
            worker_id="other-private-worker",
            workspace_id="local-default",
            name="Other Private Worker",
            manifest_json=_manifest("other-private-worker", "Other Private Worker"),
        )

        mint = client.post("/workers/private-worker/share-link", headers=_auth_headers())
        token = mint.json()["token"]

        resp = client.get(f"/workers/public/by-handle/fede-secretary/other-private-worker?share={token}")
        assert resp.status_code == 404


def test_revoking_share_link_locks_out_the_permalink():
    with tempfile.TemporaryDirectory(prefix="floom-permalink-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        mint = client.post("/workers/private-worker/share-link", headers=_auth_headers())
        token = mint.json()["token"]
        assert client.get(f"/workers/public/by-handle/fede-secretary/private-worker?share={token}").status_code == 200

        revoke = client.delete("/workers/private-worker/share-link", headers=_auth_headers())
        assert revoke.status_code == 200 and revoke.json()["revoked"] is True

        resp = client.get(f"/workers/public/by-handle/fede-secretary/private-worker?share={token}")
        assert resp.status_code == 404


def test_visibility_flip_does_not_break_an_already_issued_share_link():
    """Visibility flips never change the URL (Fede 2026-07-06): making a
    worker public then private again must not invalidate a share token that
    was already issued while it was private; the two access paths are backed
    by independent state (the visibility column vs. the share-link table)."""
    with tempfile.TemporaryDirectory(prefix="floom-permalink-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        mint = client.post("/workers/private-worker/share-link", headers=_auth_headers())
        token = mint.json()["token"]
        assert client.get(f"/workers/public/by-handle/fede-secretary/private-worker?share={token}").status_code == 200

        # Flip public, then back to private.
        with main.get_db() as conn:
            conn.execute("UPDATE workers SET visibility = 'public' WHERE id = ?", ("private-worker",))
        assert client.get("/workers/public/by-handle/fede-secretary/private-worker").status_code == 200
        with main.get_db() as conn:
            conn.execute("UPDATE workers SET visibility = 'private' WHERE id = ?", ("private-worker",))

        # Bare URL 404s again (private), but the share link issued earlier still works.
        assert client.get("/workers/public/by-handle/fede-secretary/private-worker").status_code == 404
        resp = client.get(f"/workers/public/by-handle/fede-secretary/private-worker?share={token}")
        assert resp.status_code == 200, resp.text
        assert resp.json()["access"] == "shared_link"


def test_worker_share_link_url_uses_canonical_permalink_shape():
    """The Share modal's mint endpoint (POST .../share-link) returns the
    /@handle/slug?share=<token> shape for a worker, not a bare /s/<token>
    link, same token/table, different presentation (Fede 2026-07-06)."""
    with tempfile.TemporaryDirectory(prefix="floom-permalink-share-", ignore_cleanup_errors=True) as td:
        main, client = _boot(Path(td))
        _seed_public_and_private(main)

        mint = client.post("/workers/private-worker/share-link", headers=_auth_headers())
        assert mint.status_code == 200, mint.text
        url = mint.json()["url"]
        assert "/@fede-secretary/private-worker?share=" in url
        assert "/s/" not in url

        # GET .../share-links (the "show existing link" re-display path) must
        # reconstruct the SAME shape, not the legacy /s/<token> form.
        listed = client.get("/workers/private-worker/share-links", headers=_auth_headers())
        assert listed.status_code == 200, listed.text
        assert listed.json()["links"][0]["url"] == url
