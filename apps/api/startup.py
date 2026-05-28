from __future__ import annotations

import os

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.supabase_provider import SupabaseAuthProvider
from apps.api.cloud_webhooks import apply_engine_overrides
from apps.api.config import get_cloud_settings
from apps.api.db._secret_crypto import ensure_secret_crypto_ready
from apps.api.db.supabase_repos import (
    SupabaseCliAuthRepository,
    SupabaseConnectionRepository,
    SupabaseRunRepository,
    SupabaseSecretRepository,
    SupabaseWorkerRepository,
)

ensure_engine_api_path()

from auth.factory import register_auth_provider  # noqa: E402
import db as engine_db  # noqa: E402
from db.factory import Repositories, register_repositories  # noqa: E402


def _activate_cloud_deploy() -> None:
    # This repository is the cloud wrapper around the vendored engine, so
    # importing its startup module defaults the engine to cloud mode.
    os.environ.setdefault("WORKEROS_DEPLOY", "cloud")


def _cloud_repositories() -> Repositories:
    return Repositories(
        workers=SupabaseWorkerRepository(),
        runs=SupabaseRunRepository(),
        connections=SupabaseConnectionRepository(),
        secrets=SupabaseSecretRepository(),
        cli_auth=SupabaseCliAuthRepository(),
    )


def register_cloud_components() -> None:
    _activate_cloud_deploy()
    get_cloud_settings()
    ensure_secret_crypto_ready()
    register_auth_provider("cloud", lambda: SupabaseAuthProvider())
    register_repositories("cloud", _cloud_repositories)
    apply_engine_overrides()
    engine_db.init_db = lambda: None


register_cloud_components()
