export type WorkerStatus = "healthy" | "ready" | "needs_attention" | "missing_secret" | "error";

/** Worker maturity stage — a label, not a gate. */
export type WorkerStage = "draft" | "live";

// ── Emily conversation persistence ─────────────────────────────────────────────
// Shapes returned by GET /conversations and GET /conversations/{id}
// (apps/api/main.py list_conversations + get_conversation_detail).

export interface ConversationSummary {
  id: string;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
  message_count?: number;
}

export interface ConversationMessageRow {
  id: string;
  role: "user" | "assistant" | "tool" | string;
  content: string;
  tool_call_id?: string | null;
  created_at?: string;
}

export interface ConversationToolCardRow {
  id: string;
  callId?: string | null;
  toolName?: string | null;
  status?: string | null;
  card?: Record<string, unknown> | null;
  resource?: Record<string, unknown> | null;
  streams?: { events: string; parts: string } | null;
  actions?: unknown[] | null;
  args_preview?: Record<string, unknown> | null;
  result_preview?: unknown;
  run_id?: string | null;
  worker_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ConversationDetail extends ConversationSummary {
  user_id?: string;
  messages: ConversationMessageRow[];
  tool_cards: ConversationToolCardRow[];
}

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
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "pending_approval";
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
  accepts?: string[];
  max_size_mb?: number;
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
  command?: string | null;
  mode?: "agent" | "pure-script" | string;
  model?: string | null;
  limits?: Record<string, unknown> | null;
}

export interface WorkerMcpConnection {
  label: string;
  transport?: "streamable_http" | "sse" | "stdio";
  url?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  auth?: string | null;
  allowed_tools?: string[] | null;
  require_approval?: "never" | "always";
}

export interface WorkerComposioConnection {
  app: string;
  allowed_tools?: string[] | null;
  scope?: string | null;
  scopes?: string[] | null;
}

export type WorkerConnectionSpec =
  | string
  | { mcp: WorkerMcpConnection }
  | { composio: WorkerComposioConnection }
  | { app: string; allowed_tools?: string[] | null };

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
  model?: string | null;
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
  relative_path?: string;
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
  // Backend (run_service.py) also emits a "pending_approval" finish status when
  // a HITL run parks for approval — it is a parked state, not a failure (G5 P3).
  | { type: "finish"; status: "completed" | "failed" | "cancelled" | "timeout" | "pending_approval"; error?: string };

export interface OutputField {
  name: string;
  type: string;  // "markdown" | "json" | "csv" | "text" | "file"
  label: string;
  value: string | number | boolean | Record<string, unknown> | unknown[] | null;
}

export interface ToolCallEntry {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface ApprovalEntry {
  id: string;
  status: string;
  label?: string;
  preview?: string;
  created_at: string;
  decided_at?: string;
  reason?: string;
  follow_up_run_id?: string;
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
  tool_calls?: ToolCallEntry[];
  approval_trail?: ApprovalEntry;
  can_replay?: boolean;
  total_tokens?: number;
  total_cost_usd?: number;
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
  created_at?: string | null;
  updated_at?: string | null;
  description?: string;
  long_description?: string;
  use_cases?: string[];
  example_input?: Record<string, unknown>;
  example_output?: string;
  how_it_works?: string;
  is_example?: boolean;
  /** Engine/system worker (manifest system_worker:true, e.g. worker-author).
   *  Hidden from the default Workers list — it's the engine behind /workers/new,
   *  not an employee. */
  system?: boolean;
  archived?: boolean;
  archive_reason?: string;
  /** false when the worker is paused/disabled — UI disables/warns on the Run button (#788). */
  enabled?: boolean;
  /** Maturity LABEL: "draft" (work-in-progress) | "live" (promoted). Orthogonal
   *  to archived/enabled/visibility — never gates execution. New workers default
   *  to "draft"; stock/example/system default to "live". */
  stage?: WorkerStage;
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
  missing_secrets?: string[];      // #556: required secrets not yet configured
  missing_connections?: string[];  // #556: required connections not yet configured
  inputs?: WorkerInput[];
  runtime?: string;       // exec.runtime ("skill", "python311", "node22", …)
  public_link?: string;   // owner-only signed share link to /w/<id>?token=
  // Members STEP 1: ownership + per-asset visibility + computed permissions.
  owner_id?: string | null;
  visibility?: AssetVisibility;
  permissions?: AssetPermissions;
}

/** Per-asset visibility. `specific_people` is reserved (hidden in the UI). */
export type AssetVisibility = "private" | "workspace" | "specific_people";

/** Computed access matrix for the requesting user against an asset. */
export interface AssetPermissions {
  is_owner: boolean;
  can_view: boolean;
  can_edit: boolean;
  can_run: boolean;
  can_delete: boolean;
  can_share: boolean;
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
  archived?: boolean;
  /** P2: false when the worker is paused/disabled — UI disables the Run button. */
  enabled?: boolean;
  archive_reason?: string;
  /** Maturity LABEL: "draft" | "live". Pure label, never gates execution. */
  stage?: WorkerStage;
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
  // Scheduler bookkeeping (workers row): next due time + last fired time for
  // scheduled/cron workers. Null for manual / never-fired workers.
  next_run_at?: string | null;
  last_fired_at?: string | null;
  missing_secrets?: string[];      // #556: required secrets not yet configured
  missing_connections?: string[];  // #556: required connections not yet configured
  // Owner-only signed share link to the standalone public worker page
  // (/w/<id>?token=<hmac>). Only present on the owner's authenticated fetch.
  public_link?: string;
  // Set when an edit to a read-only stock worker transparently forked it into a
  // user-owned editable copy (clone-on-edit). Carries the source stock worker id;
  // the returned `id` is the NEW copy, so the UI redirects to it.
  cloned_from?: string;
  // Members STEP 1: ownership + per-asset visibility + computed permissions.
  owner_id?: string | null;
  visibility?: AssetVisibility;
  permissions?: AssetPermissions;
  // P4 / #815: latest run output preview surfaced on the worker detail About tab.
  // Text excerpt of the most recent successful run's result (≤500 chars).
  latest_output?: string | null;
  latest_output_run_id?: string | null;
  // Round-09 gap #1: the saved per-worker default inputs (recipe column
  // `input_values_json`). Scheduled/automated runs merge these over schema
  // defaults. Surfaced so the Operations > Inputs panel can LOAD what is saved,
  // not just write blind. Empty object when nothing is saved.
  input_values?: Record<string, unknown>;
}

// A feedback comment left on a worker (SPEC §12). Anyone who can SEE the worker
// can leave one; surfaced to the owner.
export interface WorkerFeedback {
  id: string;
  worker_id: string;
  author_id: string;
  author_name?: string | null;
  content: string;
  created_at: string;
}

// Read-only allow-list projection of a worker returned by
// GET /workers/public/{id}?token=. Strictly a subset of WorkerDetail: no
// secrets, source files, run history, owner id, or webhook url.
export interface PublicWorkerInput {
  name: string;
  label: string;
  type: string;
  required: boolean;
  description?: string | null;
  options?: string[] | null;
}

export interface PublicWorkerOutput {
  name: string;
  label: string;
  type: string;
}

export interface PublicWorker {
  id: string;
  name: string;
  description?: string | null;
  long_description?: string | null;
  use_cases?: string[] | null;
  how_it_works?: string | null;
  is_example?: boolean | null;
  tags: string[];
  example_input?: Record<string, unknown> | null;
  example_output?: string | null;
  trigger_type: string;
  runtime?: string | null;
  connections: string[];
  inputs: PublicWorkerInput[];
  outputs: PublicWorkerOutput[];
}

export interface StandaloneShareLink {
  token: string;
  url: string;
  entity_type: "worker" | "brain_file" | "brain_pack" | "run";
}

export interface PublicShareFile {
  path: string;
  size: number;
  mime_type: string;
  display_type?: string | null;
  is_binary: boolean;
  updated_at?: string | null;
  description?: string | null;
  tags?: string[];
  metadata?: Record<string, string | number | boolean | null | undefined>;
  content_text?: string | null;
  download_url?: string | null;
}

export interface PublicSharePack {
  name: string;
  description?: string | null;
  file_count: number;
  total_size_bytes: number;
  updated_at?: string | null;
}

export interface ChatAttachment {
  name: string;
  size: number;
  type: string;
  text?: string | null;
  truncated?: boolean;
}

export interface ShareGrant {
  id: string;
  email: string;
  created_at: string;
}

export interface SqliteView {
  tables: string[];
  table?: string | null;
  columns?: string[] | null;
  rows?: (string | number | boolean | null)[][] | null;
  row_count?: number | null;
  truncated?: boolean | null;
}

export interface StandaloneShare {
  entity_type: "worker" | "brain_file" | "brain_pack";
  title: string;
  description?: string | null;
  worker?: PublicWorker;
  pack?: PublicSharePack;
  file?: PublicShareFile | null;
  files: PublicShareFile[];
}

export interface WorkerSuggestion {
  field: string;
  current: string;
  suggested: string;
  reason: string;
}

export interface WorkerSuggestResponse {
  has_conflicts: boolean;
  suggestions: WorkerSuggestion[];
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
  worker_count?: number;
  description?: string | null;
  /** Engine/system pack (e.g. worker-author-style): surfaced read-only. */
  system?: boolean;
  /** True when the operator cannot edit or delete this pack. */
  read_only?: boolean;
  /** Optional content category tag, e.g. marketing/accounting/research/data. */
  category?: string | null;
  /** Sensitive packs are never committed to git or pushed to GitHub. Default: true. */
  sensitive?: boolean;
  // Members STEP 4: ownership + per-asset visibility + computed permissions.
  owner_id?: string | null;
  visibility?: AssetVisibility;
  permissions?: AssetPermissions;
}

export interface ContextWorkerRef {
  worker_id: string;
  worker_name: string;
}

export interface SecretWarning {
  pattern: string;
  line: number;
  masked: string;
}

export interface ContextFileItem {
  path: string;
  size: number;
  mime_type: string;
  updated_at: string;
  is_binary: boolean;
  description?: string | null;
  display_type?: string;
  tags?: string[];
  metadata?: Record<string, string | number | boolean | null | undefined>;
  has_secret_warning?: boolean;
  secret_warnings?: SecretWarning[];
  deleted?: boolean;
}

export interface ContextDetail extends ContextSummary {
  files: ContextFileItem[];
  used_by?: ContextWorkerRef[];
}

export interface ContextSecretScanFile {
  path: string;
  secret_warnings: SecretWarning[];
}

export interface ContextSecretScanResponse {
  name: string;
  scanned_files: number;
  flagged_files: ContextSecretScanFile[];
}

export interface ReloadResponse {
  status: string;
  workers_loaded: number;
}

export interface ActionResponse {
  status: string;
  run_id?: string;
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  worker_id: string;
  worker_name?: string;
  status: "pending" | "approved" | "rejected";
  label?: string;
  preview?: string;
  created_at: string;
  decided_at?: string;
  reason?: string;
  decision_input_json?: string;
  edited_output_json?: string;
  follow_up_run_id?: string;
  owner_id?: string;
  artifacts?: Artifact[];
  /** Standalone signed review URL (?id=&token=) the owner can copy/share or open full-page. Set by the API for the authenticated owner. */
  public_link?: string;
  /** X4: structured reviewer feedback attached with the decision (highlight+comment on text, screenshot pins). */
  annotations?: ApprovalAnnotations | null;
  /** Cost snapshot at pause (#795): dollars + tokens consumed before the gate. */
  cost_usd_so_far?: number | null;
  tokens_so_far?: number | null;
  /** Expiry (#798): ISO timestamp the pending approval lapses (APPROVAL_TTL_HOURS, default 24h). */
  expires_at?: string | null;
  /** Typed preview (#792): preview_type + parsed preview_payload (email / records / tasks). `type` mirrors preview_type. */
  preview_type?: string | null;
  type?: string | null;
  preview_payload?: unknown;
}

/** X4: a comment attached to a highlighted span of a text/markdown artifact. */
export interface TextAnnotation {
  quote: string;
  comment: string;
}

/** X4: a pin (normalized 0..1 coords) + comment placed on an uploaded screenshot. */
export interface ImagePin {
  x: number;
  y: number;
  comment: string;
}

/** X4: an uploaded review screenshot with a caption + optional comment pins. */
export interface ImageAnnotation {
  /** Content-addressed ref into our upload store (/uploads/<sha256>?download_token=...). */
  url: string;
  caption: string;
  pins: ImagePin[];
}

export interface ApprovalAnnotations {
  text: TextAnnotation[];
  images: ImageAnnotation[];
}

/** Response shape from the approval-scoped screenshot upload endpoints. */
export interface ApprovalUploadResponse {
  id: string;
  sha256: string;
  size: number;
  media_type: string;
  url: string;
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

export interface SlackInstalledTeam {
  team_id: string;
  team_name?: string | null;
  enterprise_id?: string | null;
  enterprise_name?: string | null;
  app_id?: string | null;
  bot_user_id?: string | null;
  scopes?: string[];
  installer_user_id?: string | null;
  status: string;
  installed_by_user_id: string;
  created_at: string;
  updated_at: string;
  last_checked_at?: string | null;
  last_check_status?: string | null;
  last_check_error?: string | null;
  bot_token_set: boolean;
}

export interface SlackSetupStatus {
  configured: boolean;
  missing: string[];
  client_id_set: boolean;
  client_secret_set: boolean;
  signing_secret_set: boolean;
  events_enabled: boolean;
  callback_url: string;
  events_url: string;
  command_url: string;
  interactivity_url: string;
  install_url?: string | null;
  installed_teams: SlackInstalledTeam[];
  allowed_team_ids: string[];
}

export interface SlackInstallUrlResponse {
  install_url: string;
  expires_at: string;
}

export interface SlackSetupConfigResponse {
  status: string;
  updated: string[];
  setup: SlackSetupStatus;
}

export type SlackBindingMe =
  | { linked: true; slack_user_id: string; slack_team_id: string; profile_name?: string | null; linked_at: string; last_seen_at?: string | null }
  | { linked: false };

export type WhatsAppBindingMe =
  | { linked: true; wa_id_masked: string; workspace_id: string; profile_name?: string | null; linked_at: string; last_seen_at?: string | null }
  | { linked: false };

export interface WorkspaceAgentTool {
  name: string;
  description: string;
}

export interface WorkspaceAgentInfo {
  agent_id: string;
  model: string;
  base_persona?: string;
  worker_authoring_rules?: string;
  system_prompt: string;
  tools: WorkspaceAgentTool[];
  settings?: {
    brain_read: boolean;
    brain_write: boolean;
    connections_read: boolean;
    connections_use: boolean;
    connections_add: boolean;
  };
  channels?: {
    slack?: {
      events_configured: boolean;
      bot_configured: boolean;
      allowed_team_ids_configured?: boolean;
    };
  };
  // Members STEP 5: ownership + per-asset visibility + computed permissions.
  // The assistant is a shared workspace tool — default visibility 'workspace'.
  owner_id?: string | null;
  visibility?: AssetVisibility;
  permissions?: AssetPermissions;
}

export interface WorkspaceImportResult {
  workers_imported: string[];
  contexts_imported: string[];
  skipped: { type: string; id: string; reason: string }[];
  id_remaps: Record<string, string>;
  required_secrets: string[];
  required_connections: string[];
  workspace_md_present: boolean;
}

export interface LocalWorkspace {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: string;
}

export interface LocalWorkspaceListResponse {
  workspaces: LocalWorkspace[];
  active_id: string;
}

export interface CurrentUser {
  user_id: string;
  email?: string | null;
  display_name?: string | null;
  workspace_id?: string | null;
  scopes?: string[];
  // Multi-member fields (populated when using username/password or PAT auth)
  role?: string;
  is_admin?: boolean;
  username?: string | null;
  // #1306: profile photo from Google/GitHub OAuth. Populated by the Cloud
  // wrapper's /me (the OSS engine /me has no OAuth picture). When present, the
  // sidebar profile chip shows the real photo instead of initials.
  picture?: string | null;
  avatar_url?: string | null;
}

export interface WorkspaceShareLink {
  url: string;
  token: string;
}

export type WorkspaceRole = "owner" | "admin" | "member";
export type WorkspaceMemberStatus = "active" | "invited" | "removed";

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  invited_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkspaceMembersResponse {
  members: WorkspaceMember[];
  workspace_id: string;
  my_user_id: string;
  my_role: WorkspaceRole | null;
}

export interface SystemOverviewStats {
  runs_24h: number;
  runs_24h_sparkline: number[];
  runs_7d_sparkline: OverviewSparklineBucket[];
  success_rate_7d: number | null;
  /** Denominator scope for success_rate_7d (G5 FIX 3): "active_workers" =
   *  active, real (non-example/system/paused) workers only. */
  success_rate_scope?: string;
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

// ---------------------------------------------------------------------------
// Connections (Composio OAuth)
// ---------------------------------------------------------------------------

export type ConnectionStatus = "active" | "initiated" | "failed" | "expired" | "unknown" | "not_found";

export interface ConnectionItem {
  id: string;
  app_name: string;
  // NEW-7 (2026-06-02): the API no longer returns the raw Composio `ca_*` id.
  // Reference a connection by the internal Floom UUID `id`; the API resolves it
  // to the raw `ca_*` server-side when wiring triggers / fetching account info.
  status: ConnectionStatus;
  created_at: string;
  updated_at: string;
  kind?: "composio" | "mcp";
  scopes?: string[];
  account_label?: string | null;
  display_name?: string | null;
  last_checked_at?: string | null;
  last_check_status?: string | null;
  last_used_at?: string | null;
  last_used_by?: string | null;
  owner_id?: string | null;
  mcp_label?: string | null;
  mcp_url?: string | null;
  mcp_transport?: "streamable_http" | "sse" | "stdio";
  mcp_command?: string | null;
  mcp_args?: string[];
  mcp_env?: Record<string, string>;
  mcp_cwd?: string | null;
  mcp_auth_secret?: string | null;
  mcp_allowed_tools?: string[];
}

export interface ConnectionTestResult {
  status: "valid" | "failed" | "expired";
  reason: string;
  tested_at: string;
  tools?: string[]; // #789: live-enumerated MCP tool names
}

export interface ConnectedAccountMetadata {
  id?: string;
  connected_at?: string;
  email?: string;
  scopes?: string[];
}

export interface ConnectionInitResponse {
  id: string;
  app_name: string;
  redirect_url: string;
  composio_connection_id: string;
}

export interface ConnectedAccountSummary {
  id: string;
  account_label?: string | null;
  status: string;
}

export interface AppConnectionState {
  connected: boolean;
  app_name?: string;
  accounts?: ConnectedAccountSummary[];
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

export interface CatalogToolItem {
  name: string;
  description: string;
}

export interface VersionSummary {
  id: string;       // 7-char git SHA
  sha: string;      // same 7-char git SHA
  message: string;  // commit message
  author: string;   // git author name
  timestamp: string; // ISO 8601 commit date
  asset_type: string;
  asset_id: string;
}

export interface VersionFile {
  path: string;
  content: string;
}

export interface GitWorkspaceStatus {
  connected: boolean;
  github_username?: string | null;
  repo_full_name?: string | null;
  repo_url?: string | null;
  connected_at?: string | null;
  last_pushed_at?: string | null;
  secrets_loaded?: number;
}

export interface GitRepoItem {
  full_name: string;
  name: string;
  url: string;
  private: boolean;
  description?: string | null;
  pushed_at?: string | null;
}

export interface VersionDetail {
  files: VersionFile[];
}

export interface VersionFileSnapshot {
  path: string;
  content?: string;
  encoding?: "utf-8" | "base64";
  deleted?: boolean;
}

export interface VersionFileDetail {
  file: VersionFileSnapshot;
}

// ---------------------------------------------------------------------------
// Multi-member: local users + personal access tokens (migration 59)
// ---------------------------------------------------------------------------

export interface OssUser {
  id: string;
  username: string;
  display_name?: string | null;
  role: "admin" | "member";
  disabled: boolean;
  created_at: string;
}

export interface PersonalAccessToken {
  id: string;
  name: string;
  last_used_at?: string | null;
  created_at: string;
  expires_at?: string | null;
}

export interface PersonalAccessTokenCreate {
  token: string;
  pat: PersonalAccessToken;
}

// Workspace token (prefix wst_): API access to workspace-shared workers only.
// Admin-only; the token value is returned once on create.
export interface WorkspaceToken {
  id: string;
  name: string;
  created_by?: string | null;
  created_at: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
}

export interface WorkspaceTokenCreate {
  id: string;
  name: string;
  token: string;
  expires_at?: string | null;
}

export interface AuthMe {
  user_id: string;
  username?: string | null;
  role: string;
  auth_method: string;
  is_admin: boolean;
}

// ---------------------------------------------------------------------------
// NovaSearch Review Pack (reltix pilot) — public client-facing review flow.
// Schema: context/vault/novasearch/pack.schema.json (v1.0).
// The public GET projection NEVER carries integrity.password_plain — the API
// strips it at the public boundary (DoD: "password_plain never in public GET").
// ---------------------------------------------------------------------------

/** Vote enum. UI labels (DE): Interessiert | Vielleicht | Nein. */
export type ReviewVerdict = "interested" | "maybe" | "pass";

export interface ReviewPackCandidate {
  /** Stable per-pack slug, e.g. "c_lisa-chen-01". Vote correlation key. */
  id: string;
  rank: number;
  name: string;
  title: string;
  company: string;
  location: string;
  /** 0..100 match score. */
  score: number;
  linkedin?: string;
  why: string;
  source?: string;
}

export interface ReviewPackJob {
  /** Stable slug: software-engineer | data-automation | property-manager-weg. */
  id: string;
  personio_id?: string;
  title: string;
  location: string;
  department: string;
  must_haves: string[];
  sourcing_hint?: string;
  /** PM honesty: thin-pool / coverage caveat surfaced on the job panel. */
  coverage_note?: string;
  candidates: ReviewPackCandidate[];
}

export interface ReviewPackClient {
  slug: string;
  name: string;
}

export interface ReviewPackMeta {
  title: string;
  published_at: string;
  /** ISO timestamp the share link lapses (14 days from publish). */
  expires_at: string;
  locale: "de-DE" | string;
  timezone?: string;
}

export interface ReviewPackReviewerSuggestion {
  name: string;
  role?: string;
}

export interface ReviewPackSummary {
  total_candidates?: number;
  generated_by?: string;
  run_ids?: string[];
}

/** Public projection of pack.json (integrity stripped). */
export interface ReviewPack {
  schema_version: "1.0" | string;
  id: string;
  client: ReviewPackClient;
  meta: ReviewPackMeta;
  reviewers_suggested?: ReviewPackReviewerSuggestion[];
  jobs: ReviewPackJob[];
  coverage_notes?: string[];
  summary?: ReviewPackSummary;
}

/** A single reviewer's recorded vote (one feedback event). */
export interface ReviewPackFeedback {
  uuid?: string;
  pack_id: string;
  job_id: string;
  candidate_id: string;
  /** Stable per-reviewer key (slug of name), idempotency dimension. */
  reviewer_key: string;
  reviewer_name: string;
  reviewer_role?: string | null;
  verdict: ReviewVerdict;
  /** Optional ≤240 chars; only collected on maybe/pass in the UI. */
  note?: string | null;
  ts?: string;
}

/** One chip in the team-consensus row on a candidate card. */
export interface ReviewVoteChip {
  reviewer_name: string;
  verdict: ReviewVerdict;
}

/** Computed-on-read consensus for a single (job_id, candidate_id) pair. */
export interface ReviewConsensus {
  job_id: string;
  candidate_id: string;
  counts: { interested: number; maybe: number; pass: number };
  chips: ReviewVoteChip[];
}

/** Response of GET /review/public/{token}?password= */
export interface ReviewPackPublicResponse {
  pack: ReviewPack;
  consensus: ReviewConsensus[];
}

/** Response of GET /review/public/{token}/feedback?reviewer_key= */
export interface ReviewPackFeedbackResponse {
  my_votes: ReviewPackFeedback[];
  consensus: ReviewConsensus[];
}

/** Body of POST /review/public/{token}/feedback */
export interface ReviewPackFeedbackInput {
  /** Included when the pack is password-gated. */
  password?: string;
  job_id: string;
  candidate_id: string;
  reviewer_key: string;
  reviewer_name: string;
  reviewer_role?: string | null;
  verdict: ReviewVerdict;
  note?: string | null;
}

/** Response of POST /review/public/{token}/feedback (idempotent upsert). */
export interface ReviewPackVoteResponse {
  vote: ReviewPackFeedback;
  consensus: ReviewConsensus[];
}
