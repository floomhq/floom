from __future__ import annotations

import os
from functools import lru_cache
from typing import Callable, NamedTuple

from .interface import (
    AlertRepository,
    ApprovalRepository,
    CliAuthRepository,
    ConnectionRepository,
    RunRepository,
    SecretRepository,
    VersionRepository,
    WorkerRepository,
)
from .sqlite import (
    SqliteAlertRepository,
    SqliteApprovalRepository,
    SqliteCliAuthRepository,
    SqliteConnectionRepository,
    SqliteRunRepository,
    SqliteSecretRepository,
    SqliteVersionRepository,
    SqliteWorkerRepository,
)


class Repositories(NamedTuple):
    workers: WorkerRepository
    runs: RunRepository
    connections: ConnectionRepository
    secrets: SecretRepository
    cli_auth: CliAuthRepository
    approvals: ApprovalRepository
    alerts: AlertRepository
    versions: VersionRepository


def _local_repositories() -> Repositories:
    return Repositories(
        workers=SqliteWorkerRepository(),
        runs=SqliteRunRepository(),
        connections=SqliteConnectionRepository(),
        secrets=SqliteSecretRepository(),
        cli_auth=SqliteCliAuthRepository(),
        approvals=SqliteApprovalRepository(),
        alerts=SqliteAlertRepository(),
        versions=SqliteVersionRepository(),
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
