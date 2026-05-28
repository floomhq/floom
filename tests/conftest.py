from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from apps.api.config import reset_cloud_caches
from apps.api.db import _secret_crypto


@pytest.fixture(autouse=True)
def reset_cloud_state():
    os.environ.setdefault("WORKEROS_DEPLOY", "cloud")
    os.environ.setdefault("WORKEROS_CLOUD", "true")
    reset_cloud_caches()
    _secret_crypto._fernet.cache_clear()
    yield
    reset_cloud_caches()
    _secret_crypto._fernet.cache_clear()
    try:
        import apps.api.routes.auth as auth_routes

        provider_flags = getattr(auth_routes, "_provider_flags", None)
        if provider_flags is not None and hasattr(provider_flags, "cache_clear"):
            provider_flags.cache_clear()
    except Exception:
        pass
    try:
        from auth.factory import get_auth_provider

        get_auth_provider.cache_clear()
    except Exception:
        pass
    try:
        from db.factory import get_repositories

        get_repositories.cache_clear()
    except Exception:
        pass
