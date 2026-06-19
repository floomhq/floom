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


def validate_default_timeout_seconds(value: int) -> int:
    """Validate a workspace default_timeout_seconds value.

    Accepts integers in the range [1, MAX_RUN_TIMEOUT_SECONDS] (currently
    3600 = 1 hour).  Values <= 0 or > 3600 are rejected with ValueError.
    Returns the validated integer on success.

    #1127/#1314: raises the effective run ceiling from 300 s to 3600 s so
    a workspace can opt into up to 1-hour runs via the
    ``default_timeout_seconds`` workspace setting.
    """
    if not isinstance(value, int):
        try:
            value = int(value)
        except (TypeError, ValueError):
            raise ValueError(f"default_timeout_seconds must be an integer, got {value!r}")
    if value <= 0:
        raise ValueError(
            f"default_timeout_seconds must be positive, got {value}"
        )
    if value > MAX_RUN_TIMEOUT_SECONDS:
        raise ValueError(
            f"default_timeout_seconds cannot exceed {MAX_RUN_TIMEOUT_SECONDS}s "
            f"(1 hour ceiling); got {value}"
        )
    return value
