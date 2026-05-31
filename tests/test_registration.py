from __future__ import annotations

import importlib

from apps.api.auth.supabase_provider import SupabaseAuthProvider
from apps.api.db.supabase_repos import (
    SupabaseApprovalRepository,
    SupabaseSecretRepository,
)
from auth.factory import get_auth_provider
from db.factory import get_repositories


def test_registration_registers_cloud_implementations_when_workeros_cloud_true(
    monkeypatch,
):
    monkeypatch.setenv("WORKEROS_CLOUD", "true")
    monkeypatch.delenv("WORKEROS_DEPLOY", raising=False)
    import apps.api.startup as startup

    importlib.reload(startup)

    provider = get_auth_provider()
    repos = get_repositories()

    assert isinstance(provider, SupabaseAuthProvider)
    assert isinstance(repos.secrets, SupabaseSecretRepository)
    assert isinstance(repos.approvals, SupabaseApprovalRepository)
