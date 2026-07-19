"""Advisory timeout guidance for worker manifest save responses."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from models import WorkerConfig, WorkerDetail


logger = logging.getLogger("floom.api")

LOW_AGENT_TIMEOUT_WARNING_THRESHOLD_SECONDS = 600
_SCRIPT_ENTRY_SUFFIXES = (".py", ".sh", ".js", ".ts")


def _is_agent_mode(config: "WorkerConfig") -> bool:
    runtime = config.runtime
    entry = str(runtime.entrypoint or "").strip().lower()
    if entry.endswith(".md"):
        return True
    if entry.endswith(_SCRIPT_ENTRY_SUFFIXES):
        return False
    return runtime.mode == "agent"


def low_agent_timeout_warning(config: "WorkerConfig") -> str | None:
    """Return guidance for an accepted agent manifest with a tight timeout."""
    timeout_seconds = int(config.runtime.limits.timeout_seconds)
    if not _is_agent_mode(config) or timeout_seconds >= LOW_AGENT_TIMEOUT_WARNING_THRESHOLD_SECONDS:
        return None
    return (
        f"Agent-mode worker timeout is {timeout_seconds}s. For browse, scrape, and research "
        "workers, set limits.timeout_seconds to 1800-3600 in worker.yml (max 3600)."
    )


def warnings_for_saved_worker(config: "WorkerConfig", *, worker_id: str) -> list[str]:
    """Build and log advisory warnings after a successful manifest save."""
    warning = low_agent_timeout_warning(config)
    if warning is None:
        return []
    logger.warning("Worker %s saved with a low agent timeout: %s", worker_id, warning)
    return [warning]


def attach_save_warnings(detail: "WorkerDetail") -> "WorkerDetail":
    """Attach advisory warnings to a successful WorkerDetail save response."""
    detail.warnings.extend(
        warning
        for warning in warnings_for_saved_worker(detail.config, worker_id=detail.id)
        if warning not in detail.warnings
    )
    return detail
