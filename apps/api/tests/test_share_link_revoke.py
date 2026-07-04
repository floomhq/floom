"""#766 — DELETE share-link endpoints revoke a public link per asset.

standalone_share_links had a create path but no revoke; once a token was
minted the public link could not be disabled. These DELETE endpoints remove
the token row (frontend toggle-off); a later POST re-mints a fresh token.

Run: cd apps/api && python -m pytest tests/test_share_link_revoke.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-sharerevoke"

_YML = """\
schema_version: "0.3"
name: "shareable"
title: "Shareable Worker"
description: "A worker with a public link"
version: "0.1.0"
trigger:
  type: "manual"
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
inputs: []
connections: []
"""


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    wdir = workers_dir / "shareable"
    wdir.mkdir(parents=True)
    (wdir / "worker.yml").write_text(_YML, encoding="utf-8")
    (wdir / "run.py").write_text("print('hi')\n", encoding="utf-8")

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _rn in [x for x in list(sys.modules) if x.startswith('routers')]:
        sys.modules.pop(_rn, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET})
    yield client, main
    db.get_repositories.cache_clear()


def _token_count(main) -> int:
    with main.get_db() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM standalone_share_links WHERE entity_type='worker'"
        ).fetchone()["c"]


def test_create_then_revoke_worker_share_link(client_and_main):
    client, main = client_and_main
    created = client.post("/workers/shareable/share-link")
    assert created.status_code == 200, created.text
    first_token = created.json()["token"]
    assert _token_count(main) == 1

    revoked = client.delete("/workers/shareable/share-link")
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["revoked"] is True
    assert _token_count(main) == 0

    # idempotent: second revoke reports nothing to revoke
    again = client.delete("/workers/shareable/share-link")
    assert again.json()["revoked"] is False

    # re-create mints a FRESH token (toggle off -> on)
    recreated = client.post("/workers/shareable/share-link")
    assert recreated.status_code == 200
    assert recreated.json()["token"] != first_token
    assert _token_count(main) == 1


def test_reshare_keeps_prior_worker_link_until_revoke(client_and_main):
    client, main = client_and_main
    first = client.post("/workers/shareable/share-link")
    second = client.post("/workers/shareable/share-link")
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["token"] != second.json()["token"]
    assert _token_count(main) == 2

    from fastapi.testclient import TestClient
    anon = TestClient(client.app, raise_server_exceptions=False)
    assert anon.get(f"/s/{first.json()['token']}").status_code == 200
    assert anon.get(f"/s/{second.json()['token']}").status_code == 200

    revoked = client.delete("/workers/shareable/share-link")
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["revoked"] is True
    assert _token_count(main) == 0
    assert anon.get(f"/s/{first.json()['token']}").status_code == 404
    assert anon.get(f"/s/{second.json()['token']}").status_code == 404


def test_revoke_unknown_worker_404(client_and_main):
    client, _ = client_and_main
    assert client.delete("/workers/does-not-exist/share-link").status_code == 404


# --- Readable slug token tests ---

def test_slugged_token_matches_validation_regex_and_resolves(client_and_main):
    """Minted slugged token passes _load_standalone_share_row validation and resolves."""
    import re
    from services.share_links import _mint_standalone_share_token, _create_or_get_standalone_share_link, _load_standalone_share_row

    token = _mint_standalone_share_token(slug="shareable")
    # Must satisfy the validation regex: fls_ + 6..128 chars of [A-Za-z0-9_-]
    assert re.fullmatch(r"fls_[A-Za-z0-9_-]{6,128}", token), f"Token {token!r} fails regex"
    assert token.startswith("fls_shareable-"), f"Token {token!r} should embed slug"
    assert len(token) == len("fls_shareable-") + 8

    # Also verify old-format (no slug) tokens still pass
    old_token = _mint_standalone_share_token()
    assert re.fullmatch(r"fls_[A-Za-z0-9_-]{6,128}", old_token), f"Old token {old_token!r} fails regex"
    assert len(old_token) == len("fls_") + 24


def test_slugged_token_resolves_via_hash_lookup(client_and_main):
    """A slugged token inserted via _create_or_get resolves through _load_standalone_share_row."""
    from services.share_links import _create_or_get_standalone_share_link, _load_standalone_share_row

    result = _create_or_get_standalone_share_link(
        entity_type="worker",
        entity_id="shareable",
        owner_id="local-user",
        slug="shareable",
    )
    token = result["token"]
    assert "shareable" in token

    row = _load_standalone_share_row(token)
    assert row is not None
    assert row["entity_id"] == "shareable"
    assert row["entity_type"] == "worker"


def test_regenerate_mints_fresh_readable_token(client_and_main):
    """regenerate=True revokes old token and mints a new readable one."""
    client, main = client_and_main
    first = client.post("/workers/shareable/share-link")
    assert first.status_code == 200, first.text
    first_token = first.json()["token"]
    assert "shareable" in first_token

    regenerated = client.post("/workers/shareable/share-link", json={"regenerate": True})
    assert regenerated.status_code == 200, regenerated.text
    new_token = regenerated.json()["token"]
    assert new_token != first_token
    assert "shareable" in new_token

    # Old token no longer resolves; new token resolves
    from fastapi.testclient import TestClient
    anon = TestClient(client.app, raise_server_exceptions=False)
    assert anon.get(f"/s/{first_token}").status_code == 404
    assert anon.get(f"/s/{new_token}").status_code == 200


def test_clean_slug_strips_invalid_chars():
    """_clean_slug produces clean lowercase hyphenated output."""
    from services.share_links import _clean_slug

    assert _clean_slug("Construction Intel Weekly v2") == "construction-intel-weekly-v2"
    assert _clean_slug("b2b-saas--intel") == "b2b-saas-intel"
    assert _clean_slug("french_startup_funding_radar_v2") == "french-startup-funding-radar-v2"
    # Trim to 48 chars
    long = "a" * 60
    assert len(_clean_slug(long)) == 48
