from __future__ import annotations

import asyncio
import importlib
import sys
import types

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from auth.context import AuthContext
from auth.factory import (
    _provider_factories,
    get_auth_provider,
    register_auth_provider,
)
from auth.local import SharedSecretAuthProvider
from auth.multi_member import MultiMemberAuthProvider


class _FakeCloudProvider:
    async def verify(self, request: Request) -> AuthContext:  # noqa: ARG002
        return AuthContext(user_id="fake-cloud-user", email=None, scopes=("admin",))


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
    ]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


@pytest.fixture(autouse=True)
def _clear_auth_provider_cache():
    snapshot = dict(_provider_factories)
    get_auth_provider.cache_clear()
    yield
    _provider_factories.clear()
    _provider_factories.update(snapshot)
    get_auth_provider.cache_clear()


def test_local_deploy_returns_multi_member_provider(monkeypatch):
    """Local deploy now uses MultiMemberAuthProvider (supports PAT/session/secret/dev-mode)."""
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    provider = get_auth_provider()

    assert isinstance(provider, MultiMemberAuthProvider)


def test_cloud_without_registered_provider_raises(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    with pytest.raises(
        RuntimeError,
        match="No AuthProvider registered for WORKEROS_DEPLOY='cloud'",
    ):
        get_auth_provider()


def test_register_auth_provider_enables_lookup(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    register_auth_provider("cloud", lambda: _FakeCloudProvider())

    provider = get_auth_provider()
    assert isinstance(provider, _FakeCloudProvider)

    ctx = asyncio.run(
        provider.verify(Request({"type": "http", "headers": []}))
    )
    assert ctx.user_id == "fake-cloud-user"


def test_register_auth_provider_clears_cache(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")

    first = get_auth_provider()
    assert isinstance(first, MultiMemberAuthProvider)

    register_auth_provider("local", lambda: _FakeCloudProvider())

    second = get_auth_provider()
    assert isinstance(second, _FakeCloudProvider)


def test_unknown_deploy_value_raises(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "mystery")
    monkeypatch.delenv("FLOOM_SECRET", raising=False)

    with pytest.raises(
        RuntimeError,
        match="No AuthProvider registered for WORKEROS_DEPLOY='mystery'",
    ):
        get_auth_provider()


def test_main_refuses_to_boot_in_cloud_mode_without_registered_provider(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")

    main = load_main(monkeypatch, tmp_path)

    with pytest.raises(
        RuntimeError,
        match="No AuthProvider registered for WORKEROS_DEPLOY='cloud'",
    ):
        with TestClient(main.app):
            pass
