"""Custom exception hierarchy for OpenDraft.

Provides structured error classification for retry logic and error handling.
Transient errors are automatically retried with backoff; permanent errors fail fast.
"""


class OpenDraftError(Exception):
    """Base exception for all OpenDraft errors."""

    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}

    def __str__(self) -> str:
        if self.details:
            return f"{self.message} | {self.details}"
        return self.message


class TransientError(OpenDraftError):
    """Errors that may succeed on retry (network, rate limits, temporary failures).

    These errors trigger automatic retry with exponential backoff.
    """

    def __init__(self, message: str, retry_after: float | None = None, **kwargs):
        super().__init__(message, **kwargs)
        self.retry_after = retry_after  # Optional hint from server (e.g., 429 Retry-After)


class RateLimitError(TransientError):
    """API rate limit exceeded (HTTP 429, RESOURCE_EXHAUSTED).

    May include retry_after from server response.
    """
    pass


class NetworkError(TransientError):
    """Network connectivity issues (DNS, connection refused, timeout).

    Includes: ConnectionError, TimeoutError, SSLError, DNS failures.
    """
    pass


class PermanentError(OpenDraftError):
    """Errors that will not succeed on retry.

    Examples: invalid API key, malformed request, unsupported operation.
    """
    pass


class CheckpointError(OpenDraftError):
    """Errors related to checkpoint save/load operations.

    Examples: corrupted checkpoint, incompatible state version, disk full.
    """
    pass


# --- Error classification utilities ---

# Patterns that indicate transient (retryable) errors
TRANSIENT_ERROR_PATTERNS = [
    # HTTP status codes
    "429",                      # Rate limited
    "503",                      # Service unavailable
    "504",                      # Gateway timeout
    "502",                      # Bad gateway
    # gRPC/Gemini errors
    "RESOURCE_EXHAUSTED",       # Rate limit
    "Deadline Exceeded",        # Timeout
    "UNAVAILABLE",              # Service down
    "INTERNAL",                 # Server error
    # Network errors
    "nodename nor servname",    # DNS failure (macOS)
    "Name or service not known",  # DNS failure (Linux)
    "ConnectionError",
    "ConnectionReset",
    "ConnectionRefused",
    "ConnectionAborted",
    "BrokenPipeError",
    "TimeoutError",
    "SSLError",
    "socket.timeout",
    # Python errno patterns
    "Errno 8",                  # ENOEXEC (DNS)
    "Errno 11",                 # EAGAIN
    "Errno 61",                 # ECONNREFUSED
    "Errno 54",                 # ECONNRESET
    "Errno 60",                 # ETIMEDOUT
    "Errno 65",                 # EHOSTUNREACH
    # Google API patterns
    "temporarily unavailable",
    "try again later",
    "quota exceeded",
]

# Patterns that indicate permanent (non-retryable) errors
PERMANENT_ERROR_PATTERNS = [
    "INVALID_ARGUMENT",
    "PERMISSION_DENIED",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "ALREADY_EXISTS",
    "FAILED_PRECONDITION",
    "OUT_OF_RANGE",
    "UNIMPLEMENTED",
    "API key not valid",
    "Invalid API key",
]


def classify_error(error: Exception) -> type[TransientError] | type[PermanentError]:
    """Classify an exception as transient or permanent.

    Args:
        error: The exception to classify

    Returns:
        TransientError class if retryable, PermanentError class otherwise
    """
    error_str = str(error).lower()
    error_type_str = type(error).__name__

    # Check for explicit transient patterns
    for pattern in TRANSIENT_ERROR_PATTERNS:
        if pattern.lower() in error_str or pattern.lower() in error_type_str.lower():
            # Distinguish rate limit from general network
            if any(p in error_str for p in ["429", "rate", "quota", "RESOURCE_EXHAUSTED"]):
                return RateLimitError
            return NetworkError

    # Check for explicit permanent patterns
    for pattern in PERMANENT_ERROR_PATTERNS:
        if pattern.lower() in error_str:
            return PermanentError

    # Default: treat unknown errors as permanent (fail fast)
    return PermanentError


def wrap_error(error: Exception) -> OpenDraftError:
    """Wrap a raw exception in the appropriate OpenDraftError type.

    Args:
        error: The exception to wrap

    Returns:
        OpenDraftError subclass instance
    """
    if isinstance(error, OpenDraftError):
        return error

    error_class = classify_error(error)
    return error_class(
        message=str(error),
        details={"original_type": type(error).__name__}
    )
