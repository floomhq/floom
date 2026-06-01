from __future__ import annotations

import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture(autouse=True)
def _clear_auth_provider_cache():
    """Clear the get_auth_provider lru_cache before each test.

    SharedSecretAuthProvider reads FLOOM_SECRET at __init__ time and the
    factory caches the instance. Without this clear, a test that sets a
    different FLOOM_SECRET gets the stale provider from a previous test,
    causing spurious 401 failures in CI where tests run sequentially.
    """
    try:
        from auth.factory import get_auth_provider
        get_auth_provider.cache_clear()
    except Exception:
        pass
    yield
