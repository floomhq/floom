from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AuthContext:
    user_id: str
    email: str | None = None
    scopes: tuple[str, ...] = ()
