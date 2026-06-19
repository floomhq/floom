from __future__ import annotations

import os
from functools import lru_cache
from typing import Callable

from .interface import AuthProvider
from .local import SharedSecretAuthProvider
from .multi_member import MultiMemberAuthProvider

# Registry of AuthProvider factories keyed by WORKEROS_DEPLOY value.
# workeros (OSS) ships with "local" built in.
# downstream hosts register their AuthProvider at startup via
# register_auth_provider(...) - keeping hosted-only deps out of
# the OSS engine entirely.
_provider_factories: dict[str, Callable[[], AuthProvider]] = {
    "local": lambda: MultiMemberAuthProvider(),
}


def register_auth_provider(
    deploy_mode: str, factory: Callable[[], AuthProvider]
) -> None:
    """Register an AuthProvider factory for a given WORKEROS_DEPLOY value.

    Called by downstream packages (for example, a downstream host) at startup to plug
    in their own provider without modifying the OSS engine.
    """
    _provider_factories[deploy_mode.strip().lower()] = factory
    get_auth_provider.cache_clear()


@lru_cache(maxsize=1)
def get_auth_provider() -> AuthProvider:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    factory = _provider_factories.get(deploy)
    if factory is None:
        raise RuntimeError(
            f"No AuthProvider registered for WORKEROS_DEPLOY={deploy!r}. "
            f"workeros ships with 'local' only; downstream packages must call "
            f"auth.factory.register_auth_provider() at startup."
        )
    return factory()
