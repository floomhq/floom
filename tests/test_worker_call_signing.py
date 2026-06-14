"""Cloud worker-call token signing override — engine #972 regression guard.

Engine #972 made run_token._worker_call_signing_key fail closed when
FLOOM_SECRET is unset (no more public "dev-secret-not-set" fallback). Cloud
strips FLOOM_SECRET (to keep the engine's x-floom-secret request gate off), so
worker-to-worker chaining (manifest calls: + call_worker) broke: a calls:
worker failed at run dispatch with "worker-call tokens cannot be issued or
validated without a real signing secret".

The cloud override (startup._install_worker_call_signing_key) derives a stable,
non-public secret from SUPABASE_SERVICE_ROLE_KEY so issue + validate work
without FLOOM_SECRET. This test asserts chaining auth survives — if a future
engine bump changes the signing path and the override stops applying, the
round-trip below breaks here instead of silently at runtime.
"""
from __future__ import annotations

import os

from apps.api import startup
from apps.api._engine import ensure_engine_api_path, import_engine_module


def _run_token():
    ensure_engine_api_path()
    return import_engine_module("run_token")


def test_worker_call_signing_works_without_floom_secret(monkeypatch):
    # Cloud strips FLOOM_SECRET; the override must still provide a real secret.
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    monkeypatch.delenv("WORKEROS_WORKER_CALL_SECRET", raising=False)
    monkeypatch.delenv("FLOOM_SECRET", raising=False)
    assert not (os.environ.get("FLOOM_SECRET") or "").strip()
    startup._install_worker_call_signing_key()  # idempotent; ensure applied
    rt = _run_token()

    key = rt._worker_call_signing_key()  # no explicit secret, FLOOM_SECRET unset
    assert key, "worker-call signing key must not be empty in cloud"
    assert key != "dev-secret-not-set", "must not use the public dev fallback"


def test_issue_validate_round_trip_without_floom_secret(monkeypatch):
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    monkeypatch.delenv("WORKEROS_WORKER_CALL_SECRET", raising=False)
    monkeypatch.delenv("FLOOM_SECRET", raising=False)
    startup._install_worker_call_signing_key()
    rt = _run_token()

    token = rt.issue_worker_call_token(
        user_id="u1", parent_run_id="r1", callable_workers=["w-child"], depth=0
    )
    assert token.startswith("wrt_")
    payload = rt.validate_worker_call_token(token)
    assert payload["user_id"] == "u1"
    assert payload["callable_workers"] == ["w-child"]
