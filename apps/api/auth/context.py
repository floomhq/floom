from __future__ import annotations

from dataclasses import dataclass
from contextvars import ContextVar


@dataclass(frozen=True)
class AuthContext:
    user_id: str
    email: str | None = None
    scopes: tuple[str, ...] = ()
    # multi-member fields (added in migration 59)
    role: str = "admin"          # "owner" | "admin" | "member"
    auth_method: str = "secret"  # "pat" | "session" | "secret" | "dev" | "supabase" | "run_token"
    username: str | None = None  # human-readable login name (None for legacy auth)
    # populated when auth_method == "run_token" — contains the decoded wrt_ token payload
    run_token_payload: dict | None = None

    @property
    def is_admin(self) -> bool:
        return self.role in {"owner", "admin"} or "admin" in self.scopes


_current_auth_context: ContextVar[AuthContext | None] = ContextVar(
    "workeros_current_auth_context",
    default=None,
)


def set_current_auth_context(ctx: AuthContext) -> None:
    _current_auth_context.set(ctx)


def current_auth_context() -> AuthContext | None:
    return _current_auth_context.get()


def current_auth_user_id() -> str | None:
    ctx = current_auth_context()
    if ctx is None:
        return None
    return ctx.user_id
