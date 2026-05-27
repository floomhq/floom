from __future__ import annotations

import importlib
import sys
import types

import pytest
from fastapi.testclient import TestClient

from auth.factory import get_auth_provider
from auth.local import SharedSecretAuthProvider
from auth.supabase import SupabaseAuthProvider


def load_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))

    for name in [
        "main",
        "db",
        "models",
        "files",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
        "auth",
        "auth.context",
        "auth.dependency",
        "auth.factory",
        "auth.interface",
        "auth.local",
        "auth.supabase",
    ]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


@pytest.fixture(autouse=True)
def _clear_auth_provider_cache():
    get_auth_provider.cache_clear()
    yield
    get_auth_provider.cache_clear()


def test_local_deploy_returns_shared_secret_provider(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    provider = get_auth_provider()

    assert isinstance(provider, SharedSecretAuthProvider)


def test_cloud_without_env_vars_raises(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)

    with pytest.raises(
        RuntimeError,
        match="WORKEROS_DEPLOY=cloud requires SUPABASE_URL and SUPABASE_JWT_SECRET",
    ):
        get_auth_provider()


def test_cloud_with_stub_env_returns_supabase_provider(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("SUPABASE_URL", "https://supabase.example.test")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "jwt-secret")

    provider = get_auth_provider()

    assert isinstance(provider, SupabaseAuthProvider)


def test_unknown_deploy_value_raises(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "mystery")
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    with pytest.raises(RuntimeError, match="Unknown WORKEROS_DEPLOY value: mystery"):
        get_auth_provider()


def test_main_refuses_to_boot_in_cloud_mode_without_supabase_env(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)

    main = load_main(monkeypatch, tmp_path)

    with pytest.raises(
        RuntimeError,
        match="WORKEROS_DEPLOY=cloud requires SUPABASE_URL and SUPABASE_JWT_SECRET",
    ):
        with TestClient(main.app):
            pass
