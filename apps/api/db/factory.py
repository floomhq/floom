from __future__ import annotations

import os
from functools import lru_cache
from typing import Callable, NamedTuple

from typing import Optional

from .interface import (
    AlertRepository,
    ApprovalRepository,
    AssetAccessRepository,
    CliAuthRepository,
    ConnectionRepository,
    FeedbackRepository,
    McpToolRepository,
    PersonalAccessTokenRepository,
    RunRepository,
    SecretRepository,
    UserRepository,
    UserSessionRepository,
    WorkerRepository,
    WorkspaceMemberRepository,
)
from .sqlite import (
    SqliteAlertRepository,
    SqliteApprovalRepository,
    SqliteAssetAccessRepository,
    SqliteCliAuthRepository,
    SqliteConnectionRepository,
    SqliteFeedbackRepository,
    SqliteMcpToolRepository,
    SqlitePersonalAccessTokenRepository,
    SqliteRunRepository,
    SqliteSecretRepository,
    SqliteUserRepository,
    SqliteUserSessionRepository,
    SqliteWorkerRepository,
    SqliteWorkspaceMemberRepository,
)


class Repositories(NamedTuple):
    workers: WorkerRepository
    runs: RunRepository
    connections: ConnectionRepository
    secrets: SecretRepository
    cli_auth: CliAuthRepository
    approvals: ApprovalRepository
    alerts: AlertRepository
    mcp_tools: McpToolRepository
    # Members + per-asset visibility (Members STEP 1). Optional with defaults so a
    # downstream factory (e.g. managed-deployment) that predates these fields keeps
    # constructing Repositories(...) without them; it can register its own impls
    # when it ships member/visibility support.
    members: Optional[WorkspaceMemberRepository] = None
    asset_access: Optional[AssetAccessRepository] = None
    # Multi-member auth (migration 59). Optional with defaults for backwards compat.
    users: Optional[UserRepository] = None
    tokens: Optional[PersonalAccessTokenRepository] = None
    sessions: Optional[UserSessionRepository] = None
    # Worker feedback (migration 63). Optional with default for backwards compat
    # so a downstream factory predating it keeps constructing Repositories(...).
    feedback: Optional[FeedbackRepository] = None


def _local_repositories() -> Repositories:
    return Repositories(
        workers=SqliteWorkerRepository(),
        runs=SqliteRunRepository(),
        connections=SqliteConnectionRepository(),
        secrets=SqliteSecretRepository(),
        cli_auth=SqliteCliAuthRepository(),
        approvals=SqliteApprovalRepository(),
        alerts=SqliteAlertRepository(),
        mcp_tools=SqliteMcpToolRepository(),
        members=SqliteWorkspaceMemberRepository(),
        asset_access=SqliteAssetAccessRepository(),
        users=SqliteUserRepository(),
        tokens=SqlitePersonalAccessTokenRepository(),
        sessions=SqliteUserSessionRepository(),
        feedback=SqliteFeedbackRepository(),
    )


# Registry of Repositories factories keyed by WORKEROS_DEPLOY value.
# workeros (OSS) ships with "local" (SQLite) built in.
# managed-deployment registers its Supabase-backed Repositories at startup via
# register_repositories("cloud", ...) — keeping Supabase deps out of the
# OSS engine entirely.
_repositories_factories: dict[str, Callable[[], Repositories]] = {
    "local": _local_repositories,
}


def register_repositories(
    deploy_mode: str, factory: Callable[[], Repositories]
) -> None:
    """Register a Repositories factory for a given WORKEROS_DEPLOY value.

    Called by downstream packages (e.g. managed-deployment) at startup to plug
    in their own repository implementations without modifying the OSS
    engine.
    """
    _repositories_factories[deploy_mode.strip().lower()] = factory
    get_repositories.cache_clear()


@lru_cache(maxsize=1)
def get_repositories() -> Repositories:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    factory = _repositories_factories.get(deploy)
    if factory is None:
        raise RuntimeError(
            f"No Repositories registered for WORKEROS_DEPLOY={deploy!r}. "
            f"workeros ships with 'local' only; downstream packages must call "
            f"db.factory.register_repositories() at startup."
        )
    return factory()
