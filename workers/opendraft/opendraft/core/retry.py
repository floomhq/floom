"""Retry logic and circuit breaker for resilient API calls.

Implements exponential backoff with jitter and circuit breaker pattern
to handle transient failures gracefully during prolonged outages.
"""

import logging
import random
import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Callable, TypeVar

from .errors import TransientError, wrap_error

logger = logging.getLogger(__name__)

T = TypeVar("T")


@dataclass
class RetryConfig:
    """Configuration for retry behavior.

    Implements exponential backoff with jitter:
        delay = min(base_delay * 2^attempt + jitter, max_delay)

    Attributes:
        max_attempts: Maximum number of retry attempts (default: 5)
        base_delay: Initial delay in seconds (default: 5.0)
        max_delay: Maximum delay cap in seconds (default: 300.0 = 5 minutes)
        jitter_factor: Random jitter as fraction of delay (default: 0.2 = 20%)
        respect_retry_after: Honor server's Retry-After header (default: True)
    """
    max_attempts: int = 5
    base_delay: float = 5.0
    max_delay: float = 300.0  # 5 minutes max
    jitter_factor: float = 0.2
    respect_retry_after: bool = True


def calculate_backoff_delay(
    attempt: int,
    config: RetryConfig,
    retry_after: float | None = None
) -> float:
    """Calculate delay before next retry attempt.

    Uses exponential backoff with jitter to prevent thundering herd.

    Args:
        attempt: Current attempt number (0-indexed)
        config: Retry configuration
        retry_after: Optional server-provided delay (takes precedence)

    Returns:
        Delay in seconds before next attempt
    """
    # Honor server's Retry-After if provided and configured
    if retry_after and config.respect_retry_after:
        return min(retry_after, config.max_delay)

    # Exponential backoff: base * 2^attempt
    exponential_delay = config.base_delay * (2 ** attempt)

    # Add jitter: random factor between -jitter_factor and +jitter_factor
    jitter = exponential_delay * config.jitter_factor * (2 * random.random() - 1)
    delay_with_jitter = exponential_delay + jitter

    # Cap at max_delay
    return min(delay_with_jitter, config.max_delay)


class CircuitState(Enum):
    """Circuit breaker states."""
    CLOSED = "closed"       # Normal operation - requests pass through
    OPEN = "open"           # Failing - reject requests immediately
    HALF_OPEN = "half_open"  # Testing - allow limited requests to probe recovery


@dataclass
class CircuitBreaker:
    """Circuit breaker to prevent hammering during prolonged outages.

    State transitions:
        CLOSED → OPEN: After failure_threshold consecutive failures
        OPEN → HALF_OPEN: After reset_timeout seconds
        HALF_OPEN → CLOSED: On successful request
        HALF_OPEN → OPEN: On failed request

    Attributes:
        failure_threshold: Failures before opening circuit (default: 5)
        reset_timeout: Seconds before trying again (default: 60.0)
        half_open_max_calls: Max calls in HALF_OPEN state (default: 1)
    """
    failure_threshold: int = 5
    reset_timeout: float = 60.0
    half_open_max_calls: int = 1

    # State tracking (not config)
    _state: CircuitState = field(default=CircuitState.CLOSED, init=False)
    _failure_count: int = field(default=0, init=False)
    _last_failure_time: datetime | None = field(default=None, init=False)
    _half_open_calls: int = field(default=0, init=False)

    @property
    def state(self) -> CircuitState:
        """Current circuit state, checking for automatic transitions."""
        if self._state == CircuitState.OPEN:
            # Check if reset_timeout has elapsed
            if self._last_failure_time:
                elapsed = (datetime.now() - self._last_failure_time).total_seconds()
                if elapsed >= self.reset_timeout:
                    logger.info("Circuit breaker transitioning OPEN → HALF_OPEN after %.1fs", elapsed)
                    self._state = CircuitState.HALF_OPEN
                    self._half_open_calls = 0
        return self._state

    def allow_request(self) -> bool:
        """Check if a request should be allowed.

        Returns:
            True if request can proceed, False if circuit is open
        """
        current_state = self.state  # Triggers automatic OPEN → HALF_OPEN

        if current_state == CircuitState.CLOSED:
            return True

        if current_state == CircuitState.HALF_OPEN:
            if self._half_open_calls < self.half_open_max_calls:
                self._half_open_calls += 1
                return True
            return False

        # OPEN state
        return False

    def record_success(self) -> None:
        """Record a successful request."""
        if self._state == CircuitState.HALF_OPEN:
            logger.info("Circuit breaker transitioning HALF_OPEN → CLOSED after success")
            self._state = CircuitState.CLOSED
            self._failure_count = 0
            self._half_open_calls = 0
        elif self._state == CircuitState.CLOSED:
            # Reset failure count on success
            self._failure_count = 0

    def record_failure(self) -> None:
        """Record a failed request."""
        self._failure_count += 1
        self._last_failure_time = datetime.now()

        if self._state == CircuitState.HALF_OPEN:
            logger.warning("Circuit breaker transitioning HALF_OPEN → OPEN after failure")
            self._state = CircuitState.OPEN
            self._half_open_calls = 0

        elif self._state == CircuitState.CLOSED:
            if self._failure_count >= self.failure_threshold:
                logger.warning(
                    "Circuit breaker transitioning CLOSED → OPEN after %s consecutive failures",
                    self._failure_count
                )
                self._state = CircuitState.OPEN

    def reset(self) -> None:
        """Manually reset the circuit breaker to CLOSED state."""
        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._last_failure_time = None
        self._half_open_calls = 0
        logger.info("Circuit breaker manually reset to CLOSED")

    def time_until_retry(self) -> float | None:
        """Get seconds until circuit might allow requests.

        Returns:
            Seconds until HALF_OPEN, or None if already allowing requests
        """
        if self.state != CircuitState.OPEN:
            return None
        if self._last_failure_time is None:
            return None

        elapsed = (datetime.now() - self._last_failure_time).total_seconds()
        remaining = self.reset_timeout - elapsed
        return max(0, remaining)


def retry_with_backoff(
    func: Callable[[], T],
    config: RetryConfig | None = None,
    circuit_breaker: CircuitBreaker | None = None,
    on_retry: Callable[[int, Exception, float], None] | None = None,
) -> T:
    """Execute a function with retry logic and optional circuit breaker.

    Args:
        func: Zero-argument callable to execute
        config: Retry configuration (uses defaults if None)
        circuit_breaker: Optional circuit breaker for rate limiting
        on_retry: Optional callback(attempt, error, delay) before each retry

    Returns:
        Result of successful function call

    Raises:
        TransientError: If all retries exhausted
        Exception: If non-transient error or circuit breaker open
    """
    config = config or RetryConfig()
    last_error: Exception | None = None

    for attempt in range(config.max_attempts):
        # Check circuit breaker
        if circuit_breaker and not circuit_breaker.allow_request():
            wait_time = circuit_breaker.time_until_retry() or config.base_delay
            raise TransientError(
                f"Circuit breaker open, retry in {wait_time:.1f}s",
                details={"circuit_state": circuit_breaker.state.value}
            )

        try:
            result = func()
            # Success - record and return
            if circuit_breaker:
                circuit_breaker.record_success()
            return result

        except Exception as e:
            last_error = e
            wrapped = wrap_error(e)

            # Record failure for circuit breaker
            if circuit_breaker:
                circuit_breaker.record_failure()

            # Check if error is transient (retryable)
            if not isinstance(wrapped, TransientError):
                raise wrapped from e

            # Calculate backoff delay
            retry_after = getattr(wrapped, "retry_after", None)
            delay = calculate_backoff_delay(attempt, config, retry_after)

            # Check if we have more attempts
            if attempt + 1 >= config.max_attempts:
                logger.error(
                    "Retry exhausted after %s attempts: %s", config.max_attempts, e
                )
                raise wrapped from e

            # Callback before retry
            if on_retry:
                on_retry(attempt, e, delay)
            else:
                logger.warning(
                    "Attempt %s/%s failed: %s. Retrying in %.1fs...",
                    attempt + 1, config.max_attempts, str(e)[:200], delay
                )

            time.sleep(delay)

    # Should not reach here, but handle gracefully
    if last_error:
        raise wrap_error(last_error)
    raise TransientError("Retry loop exited unexpectedly")
