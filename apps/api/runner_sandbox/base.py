"""Abstract sandbox driver interface for Floom."""

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, Optional

from models import WorkerConfig, WorkerResult


class SandboxDriver(ABC):
    """Abstract base class for sandbox execution drivers.

    All drivers MUST be idempotent — given the same inputs, produce the
    same result. Cleanup is always called, even on failure.
    """

    @abstractmethod
    def run(
        self,
        worker_id: str,
        run_id: str,
        inputs: Dict[str, Any],
        secrets: Dict[str, str],
        log_fn: Callable[[str, str], None],
        trace_id: str,
        timeout_seconds: int = 300,
        config: Optional[WorkerConfig] = None,
        connection_ids: Optional[Dict[str, str]] = None,
        user_id: str | None = None,
    ) -> WorkerResult:
        """Execute the worker and return a WorkerResult.

        Must never raise — catch all exceptions and return WorkerResult(status="error", ...).
        """
        ...

    @property
    def name(self) -> str:
        """Return the driver name for logging."""
        return self.__class__.__name__
