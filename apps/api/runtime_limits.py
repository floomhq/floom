"""Runtime timeout limits shared by worker schema and sandbox drivers."""

import os

DEFAULT_RUN_TIMEOUT_SECONDS = 300
DEFAULT_MAX_RUN_TIMEOUT_SECONDS = 3600
MIN_INSTALL_TIMEOUT_SECONDS = 180
SANDBOX_LIFETIME_BUFFER_SECONDS = 60
E2B_MAX_SANDBOX_LIFETIME_SECONDS = 3600


def _positive_int_from_env(env_key: str, default: int) -> int:
    raw = os.environ.get(env_key)
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return default


MAX_RUN_TIMEOUT_SECONDS = _positive_int_from_env(
    "WORKEROS_MAX_RUN_TIMEOUT",
    DEFAULT_MAX_RUN_TIMEOUT_SECONDS,
)
