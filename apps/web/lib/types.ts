export type WorkerStatus = "healthy" | "needs_attention" | "paused" | "missing_secret" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "pending_approval" | "approved" | "rejected";
export type ApprovalStatus = "not_required" | "pending" | "approved" | "rejected";
export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";
export type SecretStatus = "set" | "missing";

export interface WorkerInput {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  default?: any;
  accept_csv?: boolean;
}

export interface WorkerOutput {
  name: string;
  label: string;
  type: string;
}

export interface WorkerTrigger {
  type: string;
  cron?: string;
  every?: string;
  at?: string;
}

export interface WorkerRuntime {
  type: string;
  entrypoint: string;
  runner: string;
}

export interface WorkerApprovalConfig {
  required: boolean;
  label?: string;
}

export interface WorkerConfig {
  id: string;
  name: string;
  description?: string;
  trigger: WorkerTrigger;
  runtime: WorkerRuntime;
  inputs: WorkerInput[];
  secrets: string[];
  outputs: WorkerOutput[];
  approvals: WorkerApprovalConfig;
  csv_required_columns?: string[];
}

export interface RunSummary {
  id: string;
  worker_id: string;
  worker_name?: string;
  status: RunStatus;
  trigger_source: string;
  approval_status: ApprovalStatus;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  error?: string;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  trace_id?: string;
}

export interface Artifact {
  id: string;
  run_id: string;
  name: string;
  type?: string;
  path: string;
  size_bytes?: number;
  created_at: string;
}

export interface ApprovalDetail {
  id: string;
  run_id: string;
  worker_id: string;
  worker_name?: string;
  status: ApprovalStatus;
  label?: string;
  preview?: string;
  preview_type?: string;
  created_at: string;
  decided_at?: string;
  reason?: string;
}

export interface OutputField {
  name: string;
  type: string;  // "markdown" | "json" | "csv" | "text" | "file"
  label: string;
  value: any;
}

export interface RunDetail {
  id: string;
  worker_id: string;
  worker_name?: string;
  status: RunStatus;
  trigger_source: string;
  runner: string;
  input: Record<string, any>;
  output: Record<string, any>;
  output_schema: OutputField[];
  logs: LogEntry[];
  artifacts: Artifact[];
  approval?: ApprovalDetail;
  approval_status: ApprovalStatus;
  error?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  created_at?: string;
}

export interface WorkerSummary {
  id: string;
  name: string;
  description?: string;
  status: WorkerStatus;
  paused?: boolean;
  trigger_type: string;
  runner: string;
  last_run?: RunSummary;
}

export interface WorkerDetail {
  id: string;
  name: string;
  description?: string;
  status: WorkerStatus;
  paused?: boolean;
  trigger_type: string;
  runner: string;
  config: WorkerConfig;
  recent_runs: RunSummary[];
}

export interface SecretItem {
  name: string;
  status: SecretStatus;
  last_used_at?: string;
  used_by: string[];
}

export interface ReloadResponse {
  status: string;
  workers_loaded: number;
}

export interface ActionResponse {
  status: string;
  run_id?: string;
}
