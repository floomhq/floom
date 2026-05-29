from __future__ import annotations

from dataclasses import dataclass
from contextvars import ContextVar


@dataclass(frozen=True)
class AuthContext:
    user_id: str
    email: str | None = None
    scopes: tuple[str, ...] = ()


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
