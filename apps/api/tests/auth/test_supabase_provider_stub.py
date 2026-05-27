from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request

from auth.supabase import SupabaseAuthProvider


def _request() -> Request:
    return Request({"type": "http", "headers": []})


def test_verify_raises_phase_3(monkeypatch):
    monkeypatch.delenv("WORKEROS_DEV", raising=False)
    provider = SupabaseAuthProvider(
        supabase_url="https://supabase.example.test",
        supabase_jwt_secret="jwt-secret",
    )

    with pytest.raises(NotImplementedError, match="Phase 3"):
        asyncio.run(provider.verify(_request()))


def test_constructor_refuses_plain_http_without_dev(monkeypatch):
    monkeypatch.delenv("WORKEROS_DEV", raising=False)

    with pytest.raises(RuntimeError, match="SUPABASE_URL must use https unless WORKEROS_DEV=1"):
        SupabaseAuthProvider(
            supabase_url="http://supabase.example.test",
            supabase_jwt_secret="jwt-secret",
        )


def test_constructor_allows_plain_http_in_dev(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEV", "1")

    provider = SupabaseAuthProvider(
        supabase_url="http://supabase.example.test",
        supabase_jwt_secret="jwt-secret",
    )

    assert provider.supabase_url == "http://supabase.example.test"
