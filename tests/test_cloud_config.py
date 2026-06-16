from __future__ import annotations

import pytest

from apps.api import config


def _base_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "WORKEROS_CLOUD_SUPABASE_URL",
        "WORKEROS_CLOUD_SUPABASE_ANON_KEY",
        "WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_ANON_KEY", "anon")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY", "service")


def test_cloud_deploy_requires_https_supabase_even_when_worker_dev_is_set(monkeypatch):
    config.get_cloud_settings.cache_clear()
    _base_env(monkeypatch)
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_URL", "http://localhost:54321")

    with pytest.raises(RuntimeError, match="Cloud mode requires an HTTPS Supabase URL"):
        config.get_cloud_settings()

    config.get_cloud_settings.cache_clear()


def test_non_cloud_dev_may_use_local_supabase_url(monkeypatch):
    config.get_cloud_settings.cache_clear()
    _base_env(monkeypatch)
    monkeypatch.delenv("WORKEROS_DEPLOY", raising=False)
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("WORKEROS_CLOUD_SUPABASE_URL", "http://localhost:54321")

    settings = config.get_cloud_settings()

    assert settings.supabase_url == "http://localhost:54321"
    config.get_cloud_settings.cache_clear()
