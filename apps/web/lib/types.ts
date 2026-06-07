export type WorkerStatus = "healthy" | "needs_attention" | "missing_secret" | "error";

export interface TriggerSpec {
  type: string;
  cron?: string;
  timezone?: string;
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

export interface WorkerMcpConnection {
  label: string;
  url: string;
  auth?: string | null;
  allowed_tools?: string[] | null;
  require_approval?: "never" | "always";
}

export type WorkerConnectionSpec = string | { mcp: WorkerMcpConnection };

export interface WorkerContextMount {
  name: string;
  writeable?: boolean;
  source?: string;
}

export type WorkerContextSpec = string | WorkerContextMount;

export interface WorkerConfig {
  id: string;
  name: string;
  description?: string;
  trigger: WorkerTrigger;
  runtime: WorkerRuntime;
  inputs: WorkerInput[];
  secrets: string[];
  connections: WorkerConnectionSpec[];  // Composio app slugs and MCP server specs
  contexts: WorkerContextSpec[];
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

export type RunPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string; args: unknown; callId: string }
  | { type: "tool-result"; callId: string; result: unknown; isError: boolean }
  | { type: "reasoning"; text: string }
  | { type: "step-start"; stepNumber: number }
  | { type: "finish"; status: "completed" | "failed" | "timeout"; error?: string };

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
  queue_position?: number;
}

export interface RecentStats {
  last_run_at?: string | null;
  runs_7d: number;
  success_rate_7d?: number | null;
}

export interface TimeseriesDay {
  date: string;       // "YYYY-MM-DD"
  total: number;
  completed: number;
  failed: number;
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
  is_example?: boolean;
  tags: string[];
  folder?: string;
  status: WorkerStatus;
  trigger_type: string;
  runner: string;
  last_run?: RunSummary;
  triggers: string[];
  triggers_spec: TriggerSpec[];
  recent_stats?: RecentStats | null;
  timeseries?: TimeseriesDay[] | null;
  connections: string[];  // Composio app slugs declared in worker.yml
  runtime?: string;       // exec.runtime ("skill", "python311", "node22", …)
}

export interface WorkerFile {
  path: string;       // relative path from worker root, e.g. "SKILL.md", "lib/helpers.py"
  language: string;   // "markdown", "python", "yaml", "json", "text"
  content?: string;   // utf-8 string; absent when binary=true
  binary: boolean;
  size: number;
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
  is_example?: boolean;
  tags: string[];
  folder?: string;
  status: WorkerStatus;
  trigger_type: string;
  runner: string;
  config: WorkerConfig;
  recent_runs: RunSummary[];
  manifest_yaml?: string;
  run_py?: string;
  skill_md_content?: string;
  run_py_content?: string;
  new_webhook_secret?: string;
  webhook_url?: string;
  files: WorkerFile[];
  triggers_spec: TriggerSpec[];
}

export interface SecretItem {
  name: string;
  status: SecretStatus;
  last_used_at?: string;
  last_checked_at?: string | null;
  last_check_status?: string | null;
  used_by: string[];
}

export interface ContextSummary {
  name: string;
  file_count: number;
  total_size_bytes: number;
  updated_at?: string | null;
  writeable: boolean;
  system?: boolean;
  read_only?: boolean;
  worker_count: number;
  description?: string | null;
}

export interface ContextWorkerRef {
  worker_id: string;
  worker_name: string;
}

export interface ContextFileItem {
  path: string;
  size: number;
  mime_type: string;
  updated_at: string;
  is_binary: boolean;
  description?: string | null;
  display_type: string;
}

export interface ContextDetail extends ContextSummary {
  files: ContextFileItem[];
  used_by: ContextWorkerRef[];
}

export interface ReloadResponse {
  status: string;
  workers_loaded: number;
}

export interface ActionResponse {
  status: string;
  run_id?: string;
}

export interface SystemInfo {
  version: string;
  started_at: string;
  python_version: string;
  runner: string;
}

export interface PlatformConfig {
  all_required_set: boolean;
  missing: string[];
  set_count: number;
  required_count: number;
}

export interface SystemOverviewStats {
  runs_24h: number;
  runs_24h_sparkline: number[];
  runs_7d_sparkline: OverviewSparklineBucket[];
  success_rate_7d: number | null;
  active_workers_count: number;
  paused_workers_count: number;
  connections_healthy: number;
  connections_total: number;
  work_shipped_7d: number;
  work_shipped_previous_7d: number;
  runs_today: number;
  completed_today: number;
  failed_today: number;
  running_now: number;
  queued_now: number;
  scheduled_24h_count: number;
  next_scheduled_at?: string | null;
}

export interface SystemOverviewRunItem {
  run_id: string;
  worker_id: string;
  worker_name: string;
  status: string;
  started_at: string | null;
  duration_ms: number;
  trigger_source: string;
}

export interface SystemOverviewOutcomeItem {
  worker_id: string;
  worker_name: string;
  label: string;
  count: number;
}

export interface SystemOverviewScheduledItem {
  worker_id: string;
  worker_name: string;
  next_fire_at: string;
  trigger_label: string;
  trigger_source: string;
  paused?: boolean;
}

export interface SystemOverviewAttentionItem {
  kind?: "failing" | "connection_expired" | "connection_expiring" | string;
  type: string;
  worker_id?: string;
  worker_name?: string;
  connection_id?: string;
  provider_slug?: string;
  provider_display_name?: string;
  provider_names?: string[];
  message: string;
  cause?: string | null;
  error_code?: string | null;
  recent_failure_count?: number | null;
  last_failed_at?: string | null;
  suggested_actions?: string[];
  action_url: string;
}

export interface OverviewSparklineBucket {
  label: string;
  started_at: string;
  total: number;
  failed: number;
}

export interface SystemOverview {
  stats: SystemOverviewStats;
  outcomes: SystemOverviewOutcomeItem[];
  recent_runs: SystemOverviewRunItem[];
  scheduled_today: SystemOverviewScheduledItem[];
  needs_attention: SystemOverviewAttentionItem[];
}

export interface SystemMetrics {
  workers_count: number;
  runs_total: number;
  runs_7d: number;
  runs_failed_7d: number;
  connections_count: number;
  secrets_count: number;
  active_triggers: number;
  uptime_seconds: number;
  drafts_last_hour?: number;
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
  kind?: "composio" | "mcp";
  scopes?: string[];
  account_label?: string | null;
  display_name?: string | null;
  last_checked_at?: string | null;
  last_check_status?: string | null;
  mcp_label?: string | null;
  mcp_url?: string | null;
  mcp_auth_secret?: string | null;
  mcp_allowed_tools?: string[];
}

export interface ConnectionTestResult {
  status: "valid" | "failed" | "expired";
  reason: string;
  tested_at: string;
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

// ---------------------------------------------------------------------------
// Draft from prompt
// ---------------------------------------------------------------------------

export interface DraftFromPromptInputField {
  name: string;
  type: string;
  label: string;
  required: boolean;
  default?: string | number | boolean | null;
}

export interface DraftFromPromptOutputField {
  name: string;
  type: string;
  label: string;
}

export interface DraftRequirementItem {
  app: string;
  method: "oauth" | "api_key";
  available_methods: string[];  // authoritative list from backend; length 1 = no toggle
  reason: string;
}

export interface DraftFile {
  path: string;     // e.g. "worker.yml", "SKILL.md", "run.py", "lib/client.py"
  content: string;  // UTF-8 text content
}

export interface DraftFromPromptResponse {
  worker_yml: string;
  skill_md?: string;
  suggested_name: string;
  suggested_title: string;
  // New: one entry per app, method is "oauth" or "api_key". No duplicates.
  requirements?: DraftRequirementItem[];
  // Skill-bundle: all files returned by the LLM
  files?: DraftFile[];
  // Legacy fields kept for backward compatibility
  required_connections: string[];
  required_secrets: string[];
  inputs: DraftFromPromptInputField[];
  outputs: DraftFromPromptOutputField[];
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
