"""Core infrastructure for OpenDraft V3.2.

Provides retry logic, circuit breakers, error handling, and checkpointing.
"""

from .errors import (
    OpenDraftError,
    TransientError,
    PermanentError,
    RateLimitError,
    NetworkError,
    CheckpointError,
)
from .retry import RetryConfig, CircuitBreaker, calculate_backoff_delay

__all__ = [
    "OpenDraftError",
    "TransientError",
    "PermanentError",
    "RateLimitError",
    "NetworkError",
    "CheckpointError",
    "RetryConfig",
    "CircuitBreaker",
    "calculate_backoff_delay",
]
