"""Pydantic models for Floom V0 — request schemas, response schemas, and domain types."""

import re
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator
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
    description: Optional[str] = None
    options: Optional[List[str]] = None
    default: Optional[Any] = None
    accept_csv: bool = False  # When True, render the CSV column mapper in the UI


class WorkerOutput(BaseModel):
    name: str
    label: str
    type: str
    columns: Optional[List[str]] = None  # For CSV: declared expected column headers in order
    json_required_keys: Optional[List[str]] = None  # For JSON: declared required top-level keys


class WorkerWebhookConfig(BaseModel):
    secret: bool = True
    allowed_methods: List[str] = ["POST"]


class WorkerComposioTriggerConfig(BaseModel):
    event: str
    connection_id: str
    filters: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("event", "connection_id")
    @classmethod
    def validate_nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value is required")
        return value.strip()


class WorkerTrigger(BaseModel):
    type: str
    cron: Optional[str] = None
    timezone: Optional[str] = None
    every: Optional[str] = None
    at: Optional[str] = None
    webhook: Optional[WorkerWebhookConfig] = None
    composio: Optional[WorkerComposioTriggerConfig] = None


class WorkerRuntime(BaseModel):
    type: str
    entrypoint: str = "run.py"
    runner: str = "local"
    command: Optional[str] = None
    bundle_path: Optional[str] = None

    @field_validator("runner")
    @classmethod
    def validate_runner(cls, v: str) -> str:
        allowed = {"local", "e2b"}
        if v not in allowed:
            raise ValueError(f"runner must be one of {sorted(allowed)}, got {v!r}")
        return v


class WorkerApprovalConfig(BaseModel):
    required: bool = False
    label: Optional[str] = None


class WorkerConfig(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    model: Optional[str] = None
    trigger: WorkerTrigger
    runtime: WorkerRuntime
    inputs: List[WorkerInput] = []
    secrets: List[str] = []
    connections: List[str] = []  # Composio app slugs required by this worker
    outputs: List[WorkerOutput] = []
    approvals: WorkerApprovalConfig = WorkerApprovalConfig()
    csv_required_columns: Optional[List[str]] = None  # Column names for the CSV mapper wizard

    @model_validator(mode="after")
    def validate_webhook_secret(self) -> "WorkerConfig":
        if self.trigger.type == "webhook":
            if not self.trigger.webhook:
                raise ValueError(
                    "webhook-triggered workers must declare trigger.webhook.secret: true"
                )
            if self.trigger.webhook.secret is not True:
                raise ValueError(
                    "webhook-triggered workers must declare trigger.webhook.secret: true"
                )
        if self.trigger.type == "composio" and not self.trigger.composio:
            raise ValueError("composio-triggered workers must declare trigger.composio")
        return self


# ---------------------------------------------------------------------------
# WorkerContract schemas (schema_version: "0.3")
# ---------------------------------------------------------------------------

SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")
SEMVER_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$")


class WorkerContractAuthor(BaseModel):
    name: str
    email: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("author name is required")
        return value

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if "@" not in value:
            raise ValueError("author email must be an email address")
        return value


class WorkerContractBounds(BaseModel):
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    min_length: Optional[int] = None
    max_length: Optional[int] = None


class WorkerContractField(BaseModel):
    name: str
    kind: Literal["scalar", "file"] = "scalar"
    type: Optional[str] = None
    media_type: Optional[str] = None
    path: Optional[str] = None
    required: bool = False
    default: Optional[Any] = None
    enum: Optional[List[Any]] = None
    examples: Optional[List[Any]] = None
    bounds: Optional[WorkerContractBounds] = None
    format: Optional[str] = None
    description: Optional[str] = None
    label: Optional[str] = None
    placeholder: Optional[str] = None
    options: Optional[List[str]] = None
    accept_csv: bool = False
    columns: Optional[List[str]] = None
    json_required_keys: Optional[List[str]] = None

    @field_validator("name")
    @classmethod
    def validate_field_name(cls, value: str) -> str:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
            raise ValueError("field name must be identifier-like")
        return value

    @model_validator(mode="after")
    def validate_shape(self) -> "WorkerContractField":
        if self.kind == "scalar":
            if not self.type:
                raise ValueError(f"scalar field {self.name!r} must declare type")
            if self.media_type:
                raise ValueError(f"scalar field {self.name!r} cannot declare media_type")
            if self.path:
                raise ValueError(f"scalar field {self.name!r} cannot declare path")
        if self.kind == "file":
            if not self.media_type:
                raise ValueError(f"file field {self.name!r} must declare media_type")
            if self.type and self.type != "file":
                raise ValueError(f"file field {self.name!r} cannot declare scalar type")
        if self.type == "select" and not (self.options or self.enum):
            raise ValueError(f"select field {self.name!r} must declare options or enum")
        return self


class WorkerContractExec(BaseModel):
    command: Optional[str] = None
    runtime: str
    runner: str = "local"
    inputs: List[WorkerContractField] = Field(default_factory=list)
    secrets: List[str] = Field(default_factory=list)
    outputs: List[WorkerContractField] = Field(default_factory=list)

    @field_validator("command", "runtime")
    @classmethod
    def validate_nonempty(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not value.strip():
            raise ValueError("value is required")
        return value

    @field_validator("runner")
    @classmethod
    def validate_runner(cls, value: str) -> str:
        allowed = {"local", "e2b"}
        if value not in allowed:
            raise ValueError(f"runner must be one of {sorted(allowed)}, got {value!r}")
        return value


class WorkerContractNetworkCapabilities(BaseModel):
    egress: bool = False


class WorkerContractCapabilities(BaseModel):
    secrets: List[str] = Field(default_factory=list)
    network: WorkerContractNetworkCapabilities = Field(default_factory=WorkerContractNetworkCapabilities)


class WorkerContractApprovals(BaseModel):
    required: bool = False
    label: Optional[str] = None


class WorkerContractTrigger(BaseModel):
    type: str = "manual"
    cron: Optional[str] = None
    timezone: Optional[str] = None
    webhook: Optional[WorkerWebhookConfig] = None
    composio: Optional[WorkerComposioTriggerConfig] = None

    @model_validator(mode="after")
    def validate_composio(self) -> "WorkerContractTrigger":
        if self.type == "composio" and not self.composio:
            raise ValueError("composio-triggered workers must declare trigger.composio")
        return self


class WorkerContract(BaseModel):
    schema_version: Literal["0.3"]
    name: str
    title: str
    description: str
    version: str
    model: Optional[str] = None
    entrypoint: str = "SKILL.md"
    targets: List[str] = Field(default_factory=lambda: ["generic"])
    tags: List[str] = Field(default_factory=list)
    authors: List[WorkerContractAuthor] = Field(default_factory=list)
    license: Optional[str] = None
    homepage: Optional[str] = None
    repository: Optional[str] = None
    exec: WorkerContractExec
    capabilities: WorkerContractCapabilities = Field(default_factory=WorkerContractCapabilities)
    approvals: WorkerContractApprovals = Field(default_factory=WorkerContractApprovals)
    trigger: WorkerContractTrigger = Field(default_factory=WorkerContractTrigger)
    connections: List[str] = Field(default_factory=list)
    csv_required_columns: Optional[List[str]] = None

    @field_validator("name")
    @classmethod
    def validate_slug(cls, value: str) -> str:
        if not SLUG_PATTERN.fullmatch(value):
            raise ValueError(
                "name must be lowercase letters/digits/hyphens, 3-64 chars, start+end alphanumeric"
            )
        return value

    @field_validator("version")
    @classmethod
    def validate_semver(cls, value: str) -> str:
        if not SEMVER_PATTERN.fullmatch(value):
            raise ValueError("version must be semver, e.g. 0.1.0")
        return value

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title is required")
        if len(value) > 120:
            raise ValueError("title must be 120 characters or fewer")
        return value

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("description is required")
        if len(value) > 500:
            raise ValueError("description must be 500 characters or fewer")
        return value


WorkerManifest = WorkerConfig | WorkerContract


def parse_worker_manifest(raw: Dict[str, Any]) -> WorkerManifest:
    """Parse a worker manifest, using schema_version to select old vs new shape."""
    if raw.get("schema_version") == "0.3":
        return WorkerContract(**raw)
    return WorkerConfig(**raw)


def is_worker_contract(manifest: WorkerManifest) -> bool:
    return isinstance(manifest, WorkerContract)


def _contract_input_type(field: WorkerContractField) -> str:
    if field.kind == "file":
        return "file"
    if field.type == "select" or field.options:
        return "select"
    if field.type == "string":
        return "text"
    if field.type in {"textarea", "text", "number", "boolean"}:
        return field.type
    return field.type or "text"


def _contract_output_type(field: WorkerContractField) -> str:
    if field.kind == "file":
        media_type = field.media_type or ""
        if media_type == "text/markdown":
            return "markdown"
        if media_type == "text/csv":
            return "csv"
        if media_type == "application/json":
            return "json"
        return "file"
    if field.type in {"string", "text"}:
        return "text"
    if field.type == "select":
        return "text"
    return field.type or "text"


def worker_contract_to_worker_config(contract: WorkerContract, worker_id: str) -> WorkerConfig:
    """Project WorkerContract into the existing response/runtime config shape."""
    command = contract.exec.command.strip().split() if contract.exec.command else []
    entrypoint = contract.entrypoint or "SKILL.md"
    if len(command) >= 2 and command[0].startswith("python"):
        entrypoint = command[-1]

    runner = contract.exec.runner or ("e2b" if contract.exec.runtime.startswith("e2b") else "local")
    runtime = WorkerRuntime(
        type=contract.exec.runtime,
        entrypoint=entrypoint,
        runner=runner,
        command=contract.exec.command,
    )

    inputs = [
        WorkerInput(
            name=field.name,
            label=field.label or field.name.replace("_", " ").title(),
            type=_contract_input_type(field),
            required=field.required,
            placeholder=field.placeholder,
            description=field.description,
            options=field.options or ([str(value) for value in field.enum] if field.enum else None),
            default=field.default,
            accept_csv=field.accept_csv,
        )
        for field in contract.exec.inputs
    ]
    outputs = [
        WorkerOutput(
            name=field.name,
            label=field.label or field.name.replace("_", " ").title(),
            type=_contract_output_type(field),
            columns=field.columns,
            json_required_keys=field.json_required_keys,
        )
        for field in contract.exec.outputs
    ]
    return WorkerConfig(
        id=worker_id,
        name=contract.title,
        description=contract.description,
        model=contract.model,
        trigger=WorkerTrigger(
            type=contract.trigger.type,
            cron=contract.trigger.cron,
            timezone=contract.trigger.timezone,
            webhook=contract.trigger.webhook,
            composio=contract.trigger.composio,
        ),
        runtime=runtime,
        inputs=inputs,
        secrets=contract.exec.secrets,
        connections=contract.connections,
        outputs=outputs,
        approvals=WorkerApprovalConfig(
            required=contract.approvals.required,
            label=contract.approvals.label,
        ),
        csv_required_columns=contract.csv_required_columns,
    )


def _slug_from_worker_id(worker_id: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", worker_id.lower().replace("_", "-"))
    slug = re.sub(r"-+", "-", slug).strip("-")
    if len(slug) < 3:
        slug = f"{slug}-worker".strip("-")
    return slug[:64].strip("-")


def _legacy_input_to_contract_field(field: WorkerInput) -> WorkerContractField:
    if field.type == "file":
        return WorkerContractField(
            name=field.name,
            kind="file",
            media_type="text/csv" if field.accept_csv else "application/octet-stream",
            path=f"inputs/{field.name}",
            required=field.required,
            label=field.label,
            description=field.description,
            placeholder=field.placeholder,
            accept_csv=field.accept_csv,
        )
    scalar_type = {
        "text": "string",
        "textarea": "string",
        "number": "number",
        "boolean": "boolean",
        "select": "select",
    }.get(field.type, field.type)
    return WorkerContractField(
        name=field.name,
        kind="scalar",
        type=scalar_type,
        required=field.required,
        default=field.default,
        label=field.label,
        description=field.description,
        placeholder=field.placeholder,
        options=field.options,
        enum=field.options if field.type == "select" else None,
    )


def _legacy_output_to_contract_field(field: WorkerOutput) -> WorkerContractField:
    if field.type in {"markdown", "csv", "json", "file"}:
        media_type = {
            "markdown": "text/markdown",
            "csv": "text/csv",
            "json": "application/json",
            "file": "application/octet-stream",
        }[field.type]
        extension = {
            "markdown": "md",
            "csv": "csv",
            "json": "json",
            "file": "bin",
        }[field.type]
        return WorkerContractField(
            name=field.name,
            kind="file",
            media_type=media_type,
            path=f"out/{field.name}.{extension}",
            required=True,
            label=field.label,
            columns=field.columns,
            json_required_keys=field.json_required_keys,
        )
    scalar_type = "string" if field.type == "text" else field.type
    return WorkerContractField(
        name=field.name,
        kind="scalar",
        type=scalar_type,
        required=True,
        label=field.label,
    )


def worker_config_to_worker_contract(config: WorkerConfig, version: str = "0.1.0") -> WorkerContract:
    """Convert a legacy Workeros worker.yml config into WorkerContract shape."""
    return WorkerContract(
        schema_version="0.3",
        name=_slug_from_worker_id(config.id),
        title=config.name,
        description=config.description or config.name,
        version=version,
        model=config.model,
        entrypoint="SKILL.md",
        targets=["generic"],
        exec=WorkerContractExec(
            command=f"python {config.runtime.entrypoint or 'run.py'}",
            runtime="python311",
            runner=config.runtime.runner,
            inputs=[_legacy_input_to_contract_field(field) for field in config.inputs],
            secrets=list(config.secrets),
            outputs=[_legacy_output_to_contract_field(field) for field in config.outputs],
        ),
        capabilities=WorkerContractCapabilities(
            secrets=list(config.secrets),
            network=WorkerContractNetworkCapabilities(egress=bool(config.secrets or config.connections)),
        ),
        approvals=WorkerContractApprovals(
            required=config.approvals.required,
            label=config.approvals.label,
        ),
        trigger=WorkerContractTrigger(
            type=config.trigger.type,
            cron=config.trigger.cron,
            webhook=config.trigger.webhook,
            composio=config.trigger.composio,
        ),
        connections=list(config.connections),
        csv_required_columns=config.csv_required_columns,
    )


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
    transcript: List[Dict[str, Any]] = Field(default_factory=list)
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
    manifest_yaml: Optional[str] = None  # Raw worker.yml content for manifest viewer
    run_py: Optional[str] = None


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

class ConnectionsNamespace:
    """Provides attribute-style access to Composio connections.

    Usage in worker: context.connections.gmail  → composio_connection_id str
    Raises AttributeError with a helpful message for missing/inactive connections.
    """

    def __init__(self, connection_ids: Dict[str, str]):
        # app_name → composio_connection_id
        self._ids = connection_ids

    def __getattr__(self, app_name: str) -> str:
        if app_name.startswith("_"):
            raise AttributeError(app_name)
        conn_id = self._ids.get(app_name)
        if not conn_id:
            raise AttributeError(
                f"Connection '{app_name}' is not active. "
                f"Connect it at /connections first."
            )
        return conn_id

    def get(self, app_name: str) -> Optional[str]:
        return self._ids.get(app_name)

    def __contains__(self, app_name: str) -> bool:
        return app_name in self._ids


class WorkerContext:
    """Typed context passed to worker run() functions.

    Provides:
      - log(msg, level="info")     → structured logging
      - secrets                    → dict of resolved secrets
      - connections.<app>          → Composio connection ID for app
      - run_id, worker_id          → execution identifiers
      - artifact_dir               → writable output directory
      - trace_id                   → observability trace ID

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
        connection_ids: Optional[Dict[str, str]] = None,
    ):
        self.run_id = run_id
        self.worker_id = worker_id
        self._secrets = secrets
        self.artifact_dir = artifact_dir
        self.trace_id = trace_id
        self._log_fn = log_fn
        self.connections = ConnectionsNamespace(connection_ids or {})

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
        if key == "connections":
            return self.connections
        raise KeyError(key)

    def __contains__(self, key: str) -> bool:
        return key in {"log", "secrets", "run_id", "worker_id", "artifact_dir", "trace_id", "connections"}


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
