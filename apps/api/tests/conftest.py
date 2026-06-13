from __future__ import annotations

import sys
import os
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

os.environ.setdefault("WORKEROS_MIN_FREE_DISK_BYTES", "0")


@pytest.fixture(autouse=True)
def _isolate_test_globals():
    """Clear the get_auth_provider lru_cache before each test.

    SharedSecretAuthProvider reads FLOOM_SECRET at __init__ time and the
    factory caches the instance. Without this clear, a test that sets a
    different FLOOM_SECRET gets the stale provider from a previous test,
    causing spurious 401 failures in CI where tests run sequentially.
    """
    disk_threshold = os.environ.get("WORKEROS_MIN_FREE_DISK_BYTES")
    try:
        from auth.factory import get_auth_provider
        get_auth_provider.cache_clear()
    except Exception:
        pass
    # The failed-login lockout store moved from main into services.auth_ops, which
    # is not reloaded per-test the way main.py is; clear it so lockout state from
    # one test never bleeds into the next (e.g. test_password_policy_lockout).
    _auth_ops = sys.modules.get("services.auth_ops")
    _store = getattr(_auth_ops, "_failed_login_attempts", None)
    if isinstance(_store, dict):
        _store.clear()
    try:
        yield
    finally:
        if disk_threshold is None:
            os.environ.pop("WORKEROS_MIN_FREE_DISK_BYTES", None)
        else:
            os.environ["WORKEROS_MIN_FREE_DISK_BYTES"] = disk_threshold
