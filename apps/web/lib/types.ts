export type WorkerStatus = "healthy" | "needs_attention" | "missing_secret" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed";
export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";
export type SecretStatus = "set" | "missing";

export interface WorkerInput {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: string[];
  default?: string | number | boolean | string[] | null;
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
  timezone?: string;
  every?: string;
  at?: string;
  webhook?: {
    secret: boolean;
    allowed_methods: string[];
  };
  composio?: {
    event: string;
    connection_id: string;
    filters?: Record<string, unknown>;
  };
}

export interface WorkerRuntime {
  type: string;
  entrypoint: string;
  runner: string;
}

export interface WorkerConfig {
  id: string;
  name: string;
  description?: string;
  trigger: WorkerTrigger;
  runtime: WorkerRuntime;
  inputs: WorkerInput[];
  secrets: string[];
  connections: string[];  // Composio app slugs required by this worker
  outputs: WorkerOutput[];
  csv_required_columns?: string[];
}

export interface RunSummary {
  id: string;
  worker_id: string;
  worker_name?: string;
  status: RunStatus;
  trigger_source: string;
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

export interface TranscriptRow {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface OutputField {
  name: string;
  type: string;  // "markdown" | "json" | "csv" | "text" | "file"
  label: string;
  value: string | number | boolean | Record<string, unknown> | unknown[] | null;
}

export interface RunDetail {
  id: string;
  worker_id: string;
  worker_name?: string;
  status: RunStatus;
  trigger_source: string;
  runner: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  output_schema: OutputField[];
  logs: LogEntry[];
  artifacts: Artifact[];
  transcript: TranscriptRow[];
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
  long_description?: string;
  use_cases?: string[];
  example_input?: Record<string, unknown>;
  example_output?: string;
  how_it_works?: string;
  tags: string[];
  folder?: string;
  status: WorkerStatus;
  trigger_type: string;
  runner: string;
  last_run?: RunSummary;
}

export interface WorkerDetail {
  id: string;
  name: string;
  description?: string;
  long_description?: string;
  use_cases?: string[];
  example_input?: Record<string, unknown>;
  example_output?: string;
  how_it_works?: string;
  tags: string[];
  folder?: string;
  status: WorkerStatus;
  trigger_type: string;
  runner: string;
  config: WorkerConfig;
  recent_runs: RunSummary[];
  manifest_yaml?: string;
  run_py?: string;
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

// ---------------------------------------------------------------------------
// Connections (Composio OAuth)
// ---------------------------------------------------------------------------

export type ConnectionStatus = "active" | "initiated" | "failed" | "expired" | "unknown" | "not_found";

export interface ConnectionItem {
  id: string;
  app_name: string;
  composio_connection_id: string;
  status: ConnectionStatus;
  created_at: string;
  updated_at: string;
}

export interface ConnectionInitResponse {
  id: string;
  app_name: string;
  redirect_url: string;
  composio_connection_id: string;
}

export interface SupportedApp {
  slug: string;
  display_name: string;
}

export interface ComposioTriggerItem {
  id?: string;
  name?: string;
  slug?: string;
  event?: string;
  display_name?: string;
  description?: string;
  toolkit?: {
    slug?: string;
    name?: string;
  };
  app?: {
    slug?: string;
    name?: string;
  };
}

export interface IntegrationCatalogItem {
  slug: string;
  name: string;
  logo_url: string;
  description: string;
  categories: string[];
  tools_count: number;
  triggers_count: number;
}

export interface IntegrationCatalogResponse {
  items: IntegrationCatalogItem[];
  page: number;
  limit: number;
  total_items: number;
  total_pages: number;
  next_page: number | null;
  categories: string[];
}
