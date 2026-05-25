"""Abstract sandbox driver interface for Workeros."""

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict

from models import WorkerResult


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
    ) -> WorkerResult:
        """Execute the worker and return a WorkerResult.

        Must never raise — catch all exceptions and return WorkerResult(status="error", ...).
        """
        ...

    @property
    def name(self) -> str:
        """Return the driver name for logging."""
        return self.__class__.__name__
