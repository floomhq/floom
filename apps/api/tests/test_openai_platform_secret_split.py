"""OPENAI_API_KEY split: worker key (user-settable) vs platform key (reserved).

Background: a worker that declares `secrets: [OPENAI_API_KEY]` was un-runnable for
any user who didn't already own that key, because:
  - the run/card gate flagged OPENAI_API_KEY "missing", and
  - the secrets API refused to let the user add it ("platform infrastructure
    secret"), and
  - `_available_secret_names_for_user` tried to count env platform secrets but
    imported a function (`_platform_worker_secret_names`) that does not exist, so
    the ImportError was silently swallowed.

Fix (cloud-safe, non-diverging — see ARCHITECTURE.md):
  - OPENAI_API_KEY is a NORMAL per-owner user secret (settable via the UI). Each
    owner brings their own; works identically in OSS and cloud.
  - The platform's OWN key moves to PLATFORM_OPENAI_API_KEY (reserved, env-managed,
    falling back to OPENAI_API_KEY for back-compat) and never reaches a sandbox.

Run from repo root:
    cd apps/api && python -m pytest tests/test_openai_platform_secret_split.py -x -q
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import main  # noqa: E402
import run_service  # noqa: E402


# ---------------------------------------------------------------------------
# Reserved-name membership: OPENAI_API_KEY user-settable, PLATFORM_* reserved
# ---------------------------------------------------------------------------

def test_openai_api_key_is_not_reserved():
    # Un-reserved -> upsert_secret / delete / test no longer 400 on it, and it
    # shows up in the operator secrets list as a normal user secret.
    assert "OPENAI_API_KEY" not in main.PLATFORM_SECRETS


def test_platform_openai_api_key_is_reserved():
    assert "PLATFORM_OPENAI_API_KEY" in main.PLATFORM_SECRETS


def test_platform_openai_spec_declares_fallback():
    spec = next(s for s in main.PLATFORM_SECRET_SPECS if s["name"] == "PLATFORM_OPENAI_API_KEY")
    assert spec["fallback"] == "OPENAI_API_KEY"
    assert spec["required"] is True
    # The old OPENAI_API_KEY platform spec is gone.
    assert all(s["name"] != "OPENAI_API_KEY" for s in main.PLATFORM_SECRET_SPECS)


# ---------------------------------------------------------------------------
# Platform key resolution: canonical name first, back-compat fallback, else None
# ---------------------------------------------------------------------------

def test_platform_openai_key_prefers_canonical(monkeypatch):
    monkeypatch.setenv("PLATFORM_OPENAI_API_KEY", "sk-platform")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-legacy")
    assert main._platform_openai_api_key() == "sk-platform"


def test_platform_openai_key_falls_back_to_legacy(monkeypatch):
    monkeypatch.delenv("PLATFORM_OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-legacy")
    assert main._platform_openai_api_key() == "sk-legacy"


def test_platform_openai_key_none_when_unset(monkeypatch):
    monkeypatch.delenv("PLATFORM_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert main._platform_openai_api_key() is None


# ---------------------------------------------------------------------------
# The gate is DB-only now: no swallowed ImportError, no env augmentation
# ---------------------------------------------------------------------------

def test_available_secret_names_is_db_only_and_does_not_crash(monkeypatch):
    # Even with the platform key set in env, availability is the user's DB secrets
    # ONLY — env platform keys must not silently make a worker "runnable".
    monkeypatch.setenv("OPENAI_API_KEY", "sk-legacy")
    monkeypatch.setenv("PLATFORM_OPENAI_API_KEY", "sk-platform")
    repos = MagicMock()
    repos.secrets.list_names.return_value = {"SLACK_BOT_TOKEN", "NOTION_API_KEY"}
    names = main._available_secret_names_for_user("user-1", repos)
    assert names == {"SLACK_BOT_TOKEN", "NOTION_API_KEY"}
    assert "OPENAI_API_KEY" not in names
    assert "PLATFORM_OPENAI_API_KEY" not in names


def test_available_secret_names_includes_db_openai(monkeypatch):
    # Once the owner adds OPENAI_API_KEY in the UI it lands in the DB and counts.
    repos = MagicMock()
    repos.secrets.list_names.return_value = {"OPENAI_API_KEY"}
    assert "OPENAI_API_KEY" in main._available_secret_names_for_user("user-1", repos)


# ---------------------------------------------------------------------------
# Sandbox isolation: the platform key can never reach a worker sandbox; the
# user-managed OPENAI_API_KEY still can (so workers that declare it work).
# ---------------------------------------------------------------------------

def test_platform_openai_key_is_denied_from_sandbox():
    assert "PLATFORM_OPENAI_API_KEY" in run_service._PLATFORM_SECRET_NAMES


def test_user_openai_key_is_not_denied_from_sandbox():
    assert "OPENAI_API_KEY" not in run_service._PLATFORM_SECRET_NAMES


# ---------------------------------------------------------------------------
# Platform health honours the fallback (OSS deploys set only OPENAI_API_KEY)
# ---------------------------------------------------------------------------

def test_platform_config_satisfied_by_legacy_key(monkeypatch):
    # OSS deploy: only OPENAI_API_KEY in env -> PLATFORM_OPENAI_API_KEY must count
    # as satisfied via its fallback, not reported missing.
    monkeypatch.delenv("PLATFORM_OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-legacy")
    # Satisfy the other required platform secrets so we isolate the OpenAI one.
    for s in main.PLATFORM_SECRET_SPECS:
        if s["required"] and s["name"] not in ("PLATFORM_OPENAI_API_KEY",):
            monkeypatch.setenv(s["name"], "set")
    cfg = main.platform_config(auth=None)
    assert "PLATFORM_OPENAI_API_KEY" not in cfg.missing


def test_platform_config_reports_missing_when_no_openai(monkeypatch):
    monkeypatch.delenv("PLATFORM_OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    for s in main.PLATFORM_SECRET_SPECS:
        if s["required"] and s["name"] != "PLATFORM_OPENAI_API_KEY":
            monkeypatch.setenv(s["name"], "set")
    cfg = main.platform_config(auth=None)
    assert "PLATFORM_OPENAI_API_KEY" in cfg.missing
