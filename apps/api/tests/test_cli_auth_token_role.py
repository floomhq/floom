"""#847 — CLI auth tokens must carry the approver's role, not hardcoded admin.

RCA: ``_issue_cli_auth_pat`` inserted ``role="admin"`` for every CLI device
approval, and ``/cli-auth/approve`` only required *any* authenticated user.
A member could therefore approve their own CLI device and receive an admin
token — direct member → admin privilege escalation. A second instance of the
same bug lived in ``MultiMemberAuthProvider._verify_cli_api_token``, which
defaulted a NULL ``role`` column to "admin".

Fix: ``_issue_cli_auth_pat`` now requires a ``role`` argument; the approve
endpoint passes ``auth.role`` (the approver's own role); unknown role strings
clamp to "member"; and the NULL-role fallback in the auth provider resolves to
"member" (least privilege).

Run:
    cd apps/api && python -m pytest tests/test_cli_auth_token_role.py -v
"""
from __future__ import annotations

import asyncio
import importlib
import sys
import time
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_main(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name == "auth" or name.startswith("auth."):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return main, db


def _token_role(db, raw_token: str) -> str | None:
    from auth.multi_member import _hash_token

    with db.get_db() as conn:
        row = conn.execute(
            "SELECT role FROM cli_api_tokens WHERE token_hash = ?",
            (_hash_token(raw_token),),
        ).fetchone()
    return row["role"] if row else None


def test_member_approval_issues_member_token(monkeypatch, tmp_path):
    """A member approving a CLI device gets a member token — not admin."""
    main, db = _load_main(monkeypatch, tmp_path)
    from auth.context import AuthContext

    repos = db.get_repositories()
    now_ts = time.time()
    repos.cli_auth.create_device(
        user_id="member-1",
        device_code="dev-code-1",
        user_code="AAAA-1111",
        status="pending",
        secret=None,
        client_name="test-cli",
        scopes=[],
        created_ip="127.0.0.1",
        created_at=now_ts,
        expires_at=now_ts + 600,
    )

    member = AuthContext(user_id="member-1", role="member", auth_method="session")
    out = main.approve_cli_device.__wrapped__(  # bypass FastAPI Depends
        payload=main.CliAuthCodeRequest(user_code="AAAA-1111"),
        auth=member,
        repos=repos,
    ) if hasattr(main.approve_cli_device, "__wrapped__") else main.approve_cli_device(
        payload=main.CliAuthCodeRequest(user_code="AAAA-1111"),
        auth=member,
        repos=repos,
    )
    assert out["ok"] is True

    consumed = repos.cli_auth.consume("dev-code-1")
    raw_token = consumed["secret"]
    assert _token_role(db, raw_token) == "member"


def test_admin_approval_still_issues_admin_token(monkeypatch, tmp_path):
    main, db = _load_main(monkeypatch, tmp_path)
    repos = db.get_repositories()

    raw = main._issue_cli_auth_pat(
        user_id="admin-1", client_name="cli", repos=repos, role="admin"
    )
    assert _token_role(db, raw) == "admin"


def test_unknown_role_clamps_to_member(monkeypatch, tmp_path):
    main, db = _load_main(monkeypatch, tmp_path)
    repos = db.get_repositories()

    raw = main._issue_cli_auth_pat(
        user_id="u-1", client_name="cli", repos=repos, role="superuser"
    )
    assert _token_role(db, raw) == "member"


def test_empty_role_token_verifies_as_member_not_admin(monkeypatch, tmp_path):
    """Defense-in-depth: a malformed empty-role row must not grant admin.

    The column is NOT NULL, so the falsy case in practice is an empty string.
    """
    main, db = _load_main(monkeypatch, tmp_path)
    from auth.multi_member import MultiMemberAuthProvider, _hash_token

    raw = "wos_null_role_token_value"
    with db.get_db() as conn:
        conn.execute(
            """
            INSERT INTO cli_api_tokens
                (id, token_hash, user_id, role, name, created_at, last_used_at, revoked_at)
            VALUES (?, ?, ?, '', ?, ?, NULL, NULL)
            """,
            ("tok-null", _hash_token(raw), "u-2", "legacy", db.now_iso()),
        )

    provider = MultiMemberAuthProvider()
    ctx = asyncio.run(provider._verify_cli_api_token(raw))
    assert ctx.role == "member"
    assert "admin" not in ctx.scopes
