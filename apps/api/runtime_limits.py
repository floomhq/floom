"""Runtime timeout limits shared by worker schema and sandbox drivers."""

import os

DEFAULT_RUN_TIMEOUT_SECONDS = 900
DEFAULT_MAX_RUN_TIMEOUT_SECONDS = 3600
DEFAULT_AGENT_SCHEDULED_TIMEOUT_SECONDS = 1800
DEFAULT_AGENT_SCHEDULED_MIN_TOOL_ITERATIONS = 80
DEFAULT_AGENT_SCHEDULED_MIN_TOTAL_TOKENS = 1_000_000
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


def _optional_positive_int_from_env(env_key: str) -> int | None:
    raw = os.environ.get(env_key)
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return None


MAX_RUN_TIMEOUT_SECONDS = _positive_int_from_env(
    "WORKEROS_MAX_RUN_TIMEOUT",
    DEFAULT_MAX_RUN_TIMEOUT_SECONDS,
)
AGENT_MAX_TOOL_ITERATIONS = _optional_positive_int_from_env("WORKEROS_AGENT_MAX_TOOL_ITERATIONS")
_AGENT_SCHEDULED_MIN_TOOL_ITERATIONS_RAW = _positive_int_from_env(
    "WORKEROS_AGENT_SCHEDULED_MIN_TOOL_ITERATIONS",
    DEFAULT_AGENT_SCHEDULED_MIN_TOOL_ITERATIONS,
)
AGENT_SCHEDULED_MIN_TOOL_ITERATIONS = (
    min(_AGENT_SCHEDULED_MIN_TOOL_ITERATIONS_RAW, AGENT_MAX_TOOL_ITERATIONS)
    if AGENT_MAX_TOOL_ITERATIONS is not None
    else _AGENT_SCHEDULED_MIN_TOOL_ITERATIONS_RAW
)
AGENT_MAX_TOTAL_TOKENS = _positive_int_from_env(
    "WORKEROS_AGENT_MAX_TOTAL_TOKENS",
    _positive_int_from_env("FLOOM_MAX_TOTAL_TOKENS", 2_000_000),
)
AGENT_SCHEDULED_MIN_TOTAL_TOKENS = min(
    _positive_int_from_env(
        "WORKEROS_AGENT_SCHEDULED_MIN_TOTAL_TOKENS",
        DEFAULT_AGENT_SCHEDULED_MIN_TOTAL_TOKENS,
    ),
    AGENT_MAX_TOTAL_TOKENS,
)
AGENT_SCHEDULED_TIMEOUT_SECONDS = min(
    _positive_int_from_env(
        "WORKEROS_AGENT_SCHEDULED_TIMEOUT_SECONDS",
        DEFAULT_AGENT_SCHEDULED_TIMEOUT_SECONDS,
    ),
    MAX_RUN_TIMEOUT_SECONDS,
)


def effective_agent_timeout_seconds(per_worker: int, *, scheduled: bool = False) -> int:
    effective = max(1, int(per_worker))
    if scheduled:
        effective = max(effective, AGENT_SCHEDULED_TIMEOUT_SECONDS)
    return min(effective, MAX_RUN_TIMEOUT_SECONDS)


def effective_agent_tool_iterations(per_worker: int, *, scheduled: bool = False) -> int:
    effective = max(1, int(per_worker))
    if scheduled:
        effective = max(effective, AGENT_SCHEDULED_MIN_TOOL_ITERATIONS)
    if AGENT_MAX_TOOL_ITERATIONS is not None:
        return min(effective, AGENT_MAX_TOOL_ITERATIONS)
    return effective


def effective_agent_total_tokens(per_worker: int, *, scheduled: bool = False) -> int:
    effective = max(1, int(per_worker))
    if scheduled:
        effective = max(effective, AGENT_SCHEDULED_MIN_TOTAL_TOKENS)
    return min(effective, AGENT_MAX_TOTAL_TOKENS)


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
