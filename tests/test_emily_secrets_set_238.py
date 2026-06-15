"""Cloud regression for issue #238: Emily ``secrets__set`` privilege check.

The engine fix (``engine/apps/api/services/chat_tool_impls.py``
``_tool_secrets_set``) gates a secret overwrite on the existing secret's
creator. A caller who is neither the secret's creator nor a workspace admin
must be refused. Admin is resolved via the CLOUD per-request role contextvar
``apps.api.auth.workspace_context.get_active_member_role`` (set by
``SupabaseAuthProvider.verify``), and the existing secret is read through the
workspace-scoped Supabase secret repo (``repos.secrets.get``).

The engine's own test STUBS OUT ``_caller_is_workspace_admin``, so the cloud
contextvar + repo seam is otherwise untested. This test exercises the REAL
admin check by driving the real ``set_active_member_role`` contextvar, and a
fake ``get_repositories`` whose secret repo records whether ``set`` was called.

The hermetic-import pattern (psycopg stub + engine path + cloud env from
conftest) mirrors ``tests/test_cloud_share_to_workspace_idor.py``.
"""

from __future__ import annotations

import sys
import types

import pytest


def _import_impls(monkeypatch):
    """Import the engine ``services.chat_tool_impls`` hermetically.

    No real Supabase / psycopg, no engine ``main`` (which would run SQLite
    migrations against a non-writable path). We only need the engine API dir on
    ``sys.path`` and a psycopg stub so the cloud db factory imports cleanly.
    """
    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_a, **_k: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)

    from apps.api._engine import ensure_engine_api_path

    ensure_engine_api_path()
    import services.chat_tool_impls as cti  # noqa: E402  (path set above)

    return cti


class _FakeSecrets:
    """Workspace-scoped secret repo stand-in.

    Mirrors the cloud ``SupabaseSecretRepository`` seam used by
    ``_tool_secrets_set``: ``get`` returns the existing row (keyed by name only,
    workspace-scoped) and ``set`` is the mutation that must NOT run on refusal.
    """

    def __init__(self, existing: dict | None):
        self._existing = existing
        self.set_calls: list[dict] = []

    def get(self, *, user_id: str, name: str):
        return dict(self._existing) if self._existing else None

    def set(self, *, user_id: str, name: str, value: str, status: str):
        self.set_calls.append(
            {"user_id": user_id, "name": name, "value": value, "status": status}
        )


def _wire_repos(monkeypatch, cti, secrets: _FakeSecrets):
    repos = types.SimpleNamespace(secrets=secrets)
    # _tool_secrets_set does ``from db import get_repositories``.
    import db

    monkeypatch.setattr(db, "get_repositories", lambda: repos)


def test_non_creator_member_overwrite_blocked(monkeypatch):
    """A member who did not create the secret cannot overwrite it.

    Privilege-escalation path: existing secret created by ``owner_user`` lives
    in the workspace; the caller is ``attacker_user`` whose active role is
    'member'. The real ``_caller_is_workspace_admin`` reads the contextvar,
    sees 'member', returns False -> refusal, and ``set`` is never called.
    """
    cti = _import_impls(monkeypatch)
    from apps.api.auth.workspace_context import active_workspace

    secrets = _FakeSecrets(
        existing={"name": "OPENAI_API_KEY", "user_id": "owner_user", "value": "x"}
    )
    _wire_repos(monkeypatch, cti, secrets)

    with active_workspace("ws_a", role="member"):
        result = cti._tool_secrets_set(
            {"name": "OPENAI_API_KEY", "value": "stolen"}, user_id="attacker_user"
        )

    assert result.get("ok") is False
    assert "admin or the creator" in str(result.get("error", "")).lower()
    # The mutation must NOT have run.
    assert secrets.set_calls == []


def test_admin_member_can_overwrite(monkeypatch):
    """Positive control: an 'admin' member overwrites another's secret."""
    cti = _import_impls(monkeypatch)
    from apps.api.auth.workspace_context import active_workspace

    secrets = _FakeSecrets(
        existing={"name": "OPENAI_API_KEY", "user_id": "owner_user", "value": "x"}
    )
    _wire_repos(monkeypatch, cti, secrets)

    with active_workspace("ws_a", role="admin"):
        result = cti._tool_secrets_set(
            {"name": "OPENAI_API_KEY", "value": "rotated"}, user_id="admin_user"
        )

    assert result.get("ok") is True
    assert len(secrets.set_calls) == 1
    assert secrets.set_calls[0]["name"] == "OPENAI_API_KEY"
    assert secrets.set_calls[0]["value"] == "rotated"


def test_creator_can_overwrite_own_secret(monkeypatch):
    """Positive control: the creator overwrites their own secret as a member."""
    cti = _import_impls(monkeypatch)
    from apps.api.auth.workspace_context import active_workspace

    secrets = _FakeSecrets(
        existing={"name": "OPENAI_API_KEY", "user_id": "owner_user", "value": "x"}
    )
    _wire_repos(monkeypatch, cti, secrets)

    with active_workspace("ws_a", role="member"):
        result = cti._tool_secrets_set(
            {"name": "OPENAI_API_KEY", "value": "renewed"}, user_id="owner_user"
        )

    assert result.get("ok") is True
    assert len(secrets.set_calls) == 1
    assert secrets.set_calls[0]["user_id"] == "owner_user"
    assert secrets.set_calls[0]["value"] == "renewed"
