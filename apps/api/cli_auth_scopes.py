from __future__ import annotations

from collections.abc import Iterable


DEFAULT_CLI_SCOPES = ("api",)
ALLOWED_CLI_SCOPES = frozenset({"api", "mcp"})


class UnsupportedCliScope(ValueError):
    pass


def normalize_cli_scopes(raw_scopes: Iterable[object] | None) -> list[str]:
    scopes: list[str] = []
    unsupported: list[str] = []
    for raw_scope in raw_scopes or ():
        scope = str(raw_scope).strip().lower()
        if not scope:
            continue
        if scope not in ALLOWED_CLI_SCOPES:
            unsupported.append(scope)
            continue
        if scope not in scopes:
            scopes.append(scope)
    if unsupported:
        supported = ", ".join(sorted(ALLOWED_CLI_SCOPES))
        raise UnsupportedCliScope(
            f"Unsupported CLI auth scope(s): {', '.join(unsupported)}. Supported scopes: {supported}"
        )
    return scopes or list(DEFAULT_CLI_SCOPES)
