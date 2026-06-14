"""Regression test for #229A — shared-worker IDOR-write allow-list.

`/pause`, `/resume`, `/contexts`, `/contexts/{name}` mutate the worker OWNER's
manifest but were missing from `_is_owner_only_worker_write`, so the cloud
`member_write_guard` never ran for them and a non-owner member could toggle /
rewrite the contexts of a shared worker they don't own. These must now be
owner/admin-only, while member-permitted actions (runs, feedback) stay open.
"""

from __future__ import annotations

import importlib
import sys
import types

import pytest


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    # get_cloud_settings() validates presence of these at import time.
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_URL", "https://test-project.supabase.co")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_ANON_KEY", "test-anon-key")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    from cryptography.fernet import Fernet
    monkeypatch.setenv("WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.delenv("WORKEROS_RATE_LIMIT_DEV", raising=False)
    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_a, **_k: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)
    for name in [
        "apps.api.startup", "apps.api.main", "main", "db", "models",
        "worker_registry", "run_service", "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


# (method, suffix) pairs that MUST now be owner-only (the #229 IDOR-writes).
OWNER_ONLY_NEW = [
    ("POST", "/pause"),
    ("POST", "/resume"),
    ("POST", "/contexts"),
    ("DELETE", "/contexts/pentest-ctx"),
    ("PUT", "/contexts/foo"),
    ("PATCH", "/contexts/foo"),
    ("POST", "/contexts/foo"),
]

# Pre-existing owner-only paths that must keep returning True (no regression).
OWNER_ONLY_KEPT = [
    ("PATCH", ""),
    ("DELETE", ""),
    ("PUT", "/files"),
    ("PATCH", "/visibility"),
    ("POST", "/archive"),
    ("POST", "/restore"),
    ("POST", "/rollback/3"),
]

# Member-permitted actions on a shared worker that must STAY open (return False).
MEMBER_PERMITTED = [
    ("POST", "/runs"),                       # member may run a shared worker
    ("POST", "/runs/run_abc/replay"),        # engine-side (#229 item 2), not this band-aid
    ("POST", "/feedback"),
    ("GET", ""),                             # reads aren't worker-writes
    ("GET", "/contexts"),
]


def test_new_idor_write_paths_are_owner_only(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    for method, suffix in OWNER_ONLY_NEW:
        assert main._is_owner_only_worker_write(method, suffix) is True, (method, suffix)


def test_existing_owner_only_paths_unchanged(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    for method, suffix in OWNER_ONLY_KEPT:
        assert main._is_owner_only_worker_write(method, suffix) is True, (method, suffix)


def test_member_permitted_actions_stay_open(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    for method, suffix in MEMBER_PERMITTED:
        assert main._is_owner_only_worker_write(method, suffix) is False, (method, suffix)
