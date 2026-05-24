"""Pydantic models for Workeros — request schemas, response schemas, and domain types."""

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field
from enum import Enum
from datetime import datetime


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class WorkerStatus(str, Enum):
    HEALTHY = "healthy"
    NEEDS_ATTENTION = "needs_attention"
    PAUSED = "paused"
    MISSING_SECRET = "missing_secret"
    ERROR = "error"


class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    REJECTED = "rejected"


class ApprovalStatus(str, Enum):
    NOT_REQUIRED = "not_required"
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class LogLevel(str, Enum):
    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class SecretStatus(str, Enum):
    SET = "set"
    MISSING = "missing"


# ---------------------------------------------------------------------------
# Worker config schemas (used for YAML parsing)
# ---------------------------------------------------------------------------

class WorkerInput(BaseModel):
    name: str
    label: str
    type: str
    required: bool = False
    placeholder: Optional[str] = None
    options: Optional[List[str]] = None
    default: Optional[Any] = None
    accept_csv: bool = False  # When True, render the CSV column mapper in the UI


class WorkerOutput(BaseModel):
    name: str
    label: str
    type: str
    columns: Optional[List[str]] = None  # For CSV: declared expected column headers in order
    json_required_keys: Optional[List[str]] = None  # For JSON: declared required top-level keys


class WorkerTrigger(BaseModel):
    type: str
    cron: Optional[str] = None
    every: Optional[str] = None
    at: Optional[str] = None


class WorkerRuntime(BaseModel):
    type: str
    entrypoint: str = "run.py"
    runner: str = "local"


class WorkerApprovalConfig(BaseModel):
    required: bool = False
    label: Optional[str] = None


class WorkerConfig(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    trigger: WorkerTrigger
    runtime: WorkerRuntime
    inputs: List[WorkerInput] = []
    secrets: List[str] = []
    outputs: List[WorkerOutput] = []
    approvals: WorkerApprovalConfig = WorkerApprovalConfig()
    csv_required_columns: Optional[List[str]] = None  # Column names for the CSV mapper wizard


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------

class RunCreate(BaseModel):
    inputs: Dict[str, Any] = Field(default_factory=dict)
    trigger_source: str = "manual"


class RejectRequest(BaseModel):
    reason: Optional[str] = None


class ApproveRequest(BaseModel):
    edited_output: Optional[str] = None  # If set, replaces the first output field value before approval


class PaginationParams(BaseModel):
    limit: int = Field(50, ge=1, le=500)
    offset: int = Field(0, ge=0)


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class RunSummary(BaseModel):
    id: str
    worker_id: str
    worker_name: Optional[str] = None
    status: RunStatus
    trigger_source: str
    approval_status: ApprovalStatus
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    duration_ms: Optional[int] = None
    error: Optional[str] = None


class LogEntry(BaseModel):
    level: LogLevel
    message: str
    timestamp: str
    trace_id: Optional[str] = None


class Artifact(BaseModel):
    id: str
    run_id: str
    name: str
    type: Optional[str] = None
    path: str
    size_bytes: Optional[int] = None
    created_at: str


class ApprovalDetail(BaseModel):
    id: str
    run_id: str
    worker_id: str
    worker_name: Optional[str] = None
    status: ApprovalStatus
    label: Optional[str] = None
    preview: Optional[str] = None
    preview_type: Optional[str] = None  # "markdown" | "json" | "csv" | "text" | "file"
    created_at: str
    decided_at: Optional[str] = None
    reason: Optional[str] = None  # Rejection reason or approval note


class OutputField(BaseModel):
    name: str
    type: str  # "markdown", "json", "csv", "text", "file"
    label: str
    value: Any = None


class RunDetail(BaseModel):
    id: str
    worker_id: str
    worker_name: Optional[str] = None
    status: RunStatus
    trigger_source: str
    runner: str
    input: Dict[str, Any] = Field(default_factory=dict)
    output: Dict[str, Any] = Field(default_factory=dict)
    output_schema: List["OutputField"] = Field(default_factory=list)
    logs: List[LogEntry] = Field(default_factory=list)
    artifacts: List[Artifact] = Field(default_factory=list)
    approval: Optional[ApprovalDetail] = None
    approval_status: ApprovalStatus
    error: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    duration_ms: Optional[int] = None
    created_at: Optional[str] = None


class WorkerSummary(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    status: WorkerStatus
    paused: bool = False
    trigger_type: str
    runner: str
    last_run: Optional[RunSummary] = None


class WorkerDetail(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    status: WorkerStatus
    paused: bool = False
    trigger_type: str
    runner: str
    config: WorkerConfig
    recent_runs: List[RunSummary] = Field(default_factory=list)


class SecretItem(BaseModel):
    name: str
    status: SecretStatus
    last_used_at: Optional[str] = None
    used_by: List[str] = Field(default_factory=list)


class ReloadResponse(BaseModel):
    status: str
    workers_loaded: int


class ActionResponse(BaseModel):
    status: str
    run_id: Optional[str] = None


class WorkerStateResponse(BaseModel):
    worker_id: str
    paused: bool


# ---------------------------------------------------------------------------
# Domain types for worker execution
# ---------------------------------------------------------------------------

class WorkerContext:
    """Typed context passed to worker run() functions.

    Provides:
      - log(msg, level="info")  → structured logging
      - secrets                 → dict of resolved secrets
      - run_id, worker_id       → execution identifiers
      - artifact_dir            → writable output directory
      - trace_id                → observability trace ID

    Backwards compatibility: supports dict-style access so existing
    workers using ``context["log"]`` continue to work.
    """

    def __init__(
        self,
        run_id: str,
        worker_id: str,
        secrets: Dict[str, str],
        artifact_dir: str,
        trace_id: str,
        log_fn,
    ):
        self.run_id = run_id
        self.worker_id = worker_id
        self._secrets = secrets
        self.artifact_dir = artifact_dir
        self.trace_id = trace_id
        self._log_fn = log_fn

    def log(self, message: str, level: str = "info"):
        self._log_fn(message, level=level)

    @property
    def secrets(self) -> Dict[str, str]:
        return self._secrets

    def get_secret(self, name: str) -> Optional[str]:
        return self._secrets.get(name)

    # Dict-style access for backwards compatibility
    def __getitem__(self, key: str):
        if key == "log":
            return self._log_fn
        if key == "secrets":
            return self._secrets
        if key == "run_id":
            return self.run_id
        if key == "worker_id":
            return self.worker_id
        if key == "artifact_dir":
            return self.artifact_dir
        if key == "trace_id":
            return self.trace_id
        raise KeyError(key)

    def __contains__(self, key: str) -> bool:
        return key in {"log", "secrets", "run_id", "worker_id", "artifact_dir", "trace_id"}


class WorkerResult(BaseModel):
    """Standard result type returned by worker run() functions."""

    status: str  # "success" | "error"
    outputs: Dict[str, Any] = Field(default_factory=dict)
    artifacts: List[Dict[str, Any]] = Field(default_factory=list)
    error: Optional[str] = None
    error_code: Optional[str] = None  # e.g. "validation_error", "timeout"
    retryable: bool = False


class StructuredLog(BaseModel):
    """Structured log entry for observability."""

    trace_id: str
    run_id: str
    worker_id: str
    level: LogLevel
    message: str
    timestamp: str
    duration_ms: Optional[int] = None
    attributes: Optional[Dict[str, Any]] = None
