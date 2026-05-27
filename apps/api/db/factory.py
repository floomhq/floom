from __future__ import annotations

import os
from functools import lru_cache
from typing import NamedTuple

from .interface import (
    CliAuthRepository,
    ConnectionRepository,
    RunRepository,
    SecretRepository,
    WorkerRepository,
)
from .sqlite import (
    SqliteCliAuthRepository,
    SqliteConnectionRepository,
    SqliteRunRepository,
    SqliteSecretRepository,
    SqliteWorkerRepository,
)
from .supabase import (
    SupabaseCliAuthRepository,
    SupabaseConnectionRepository,
    SupabaseRunRepository,
    SupabaseSecretRepository,
    SupabaseWorkerRepository,
)


class Repositories(NamedTuple):
    workers: WorkerRepository
    runs: RunRepository
    connections: ConnectionRepository
    secrets: SecretRepository
    cli_auth: CliAuthRepository


@lru_cache(maxsize=1)
def get_repositories() -> Repositories:
    deploy = (os.environ.get("WORKEROS_DEPLOY") or "local").strip().lower()
    if deploy == "local":
        return Repositories(
            workers=SqliteWorkerRepository(),
            runs=SqliteRunRepository(),
            connections=SqliteConnectionRepository(),
            secrets=SqliteSecretRepository(),
            cli_auth=SqliteCliAuthRepository(),
        )
    if deploy == "cloud":
        return Repositories(
            workers=SupabaseWorkerRepository(),
            runs=SupabaseRunRepository(),
            connections=SupabaseConnectionRepository(),
            secrets=SupabaseSecretRepository(),
            cli_auth=SupabaseCliAuthRepository(),
        )
    raise RuntimeError(f"Unknown WORKEROS_DEPLOY value: {deploy}")
