"""#701 — env-provided secrets (OPENAI_API_KEY, E2B_API_KEY) must be seeded
into the user-scoped secrets DB so workers declaring them don't fail with
'Missing secrets' on a fresh install.

Investigation: _seed_bootstrap_secrets already runs on app startup (lifespan)
AND on /auth/setup (via _claim_bootstrap_assets_for_new_admin). These tests
lock in that behavior end to end (regression guard for #701).

Run: cd apps/api && python -m pytest tests/test_bootstrap_secret_seeding.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

OWNER = "federico"


def _load(monkeypatch, tmp_path, *, with_secret: bool = True):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_USER_ID", OWNER)
    if with_secret:
        monkeypatch.setenv("OPENAI_API_KEY", "sk-env-test-value")
        monkeypatch.setenv("E2B_API_KEY", "e2b-env-test-value")
    else:
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("E2B_API_KEY", raising=False)
    for name in list(sys.modules):
        if name in ("main", "db") or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def test_env_secret_seeded_into_db_on_startup(monkeypatch, tmp_path):
    main = _load(monkeypatch, tmp_path, with_secret=True)
    from fastapi.testclient import TestClient
    # entering the context manager runs the FastAPI lifespan (startup seeding)
    with TestClient(main.app):
        pass
    repos = main.get_repositories()
    row = repos.secrets.get(user_id=OWNER, name="OPENAI_API_KEY")
    assert row is not None
    assert row.get("value") == "sk-env-test-value"
    e2b = repos.secrets.get(user_id=OWNER, name="E2B_API_KEY")
    assert e2b is not None and e2b.get("value") == "e2b-env-test-value"


def test_seed_helper_is_idempotent_and_skips_when_absent(monkeypatch, tmp_path):
    main = _load(monkeypatch, tmp_path, with_secret=False)
    repos = main.get_repositories()
    # no env secret -> nothing seeded
    assert main._seed_bootstrap_secrets(OWNER, repos) == 0

    # set one, seed once
    monkeypatch.setenv("OPENAI_API_KEY", "sk-late")
    assert main._seed_bootstrap_secrets(OWNER, repos) == 1
    # second call is a no-op (already present with a value)
    assert main._seed_bootstrap_secrets(OWNER, repos) == 0
    assert repos.secrets.get(user_id=OWNER, name="OPENAI_API_KEY")["value"] == "sk-late"
