// Shared types for the floom-chat backend.
// A trimmed subset of the marketplace schema — chat-app only needs apps,
// runs, secrets, hub_entries, embeddings, and chat threads.

export type InputType =
  | 'text'
  | 'textarea'
  | 'url'
  | 'number'
  | 'enum'
  | 'boolean'
  | 'date'
  | 'file';

export type OutputType =
  | 'text'
  | 'json'
  | 'table'
  | 'number'
  | 'html'
  | 'markdown'
  | 'pdf'
  | 'image'
  | 'file';

export interface InputSpec {
  name: string;
  type: InputType;
  label: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  placeholder?: string;
  description?: string;
}

export interface OutputSpec {
  name: string;
  type: OutputType;
  label: string;
  description?: string;
}

export interface ActionSpec {
  label: string;
  description?: string;
  inputs: InputSpec[];
  outputs: OutputSpec[];
}

export interface NormalizedManifest {
  name: string;
  description: string;
  actions: Record<string, ActionSpec>;
  runtime: 'python' | 'node';
  python_dependencies: string[];
  node_dependencies: Record<string, string>;
  secrets_needed: string[];
  manifest_version: '1.0' | '2.0';
  apt_packages?: string[];
  /**
   * W2.1: creator-declared list of keys this app is allowed to persist in
   * the per-user `app_memory` table. Attempts to get/set a key not in this
   * list are rejected. Optional — defaults to empty (memory disabled) for
   * apps that don't need per-user state.
   */
  memory_keys?: string[];
  /**
   * W2.4c: optional free-text reason this app is blocked and cannot be run
   * by self-hosters. Surfaced in /api/hub and rendered as a warning pill on
   * the store card. Used e.g. to mark `flyfast` as "hosted-mode only pending
   * internal flight-search infra". Setting this does NOT remove the app from
   * the hub; it just annotates it.
   */
  blocked_reason?: string;
}

export type AuthType =
  | 'bearer'
  | 'apikey'
  | 'basic'
  | 'oauth2_client_credentials'
  | 'none';

export interface AuthConfig {
  /** For auth: apikey — which HTTP header name carries the key. */
  apikey_header?: string;
  /** For auth: oauth2_client_credentials — token endpoint URL. */
  oauth2_token_url?: string;
  /** For auth: oauth2_client_credentials — space-separated scopes. */
  oauth2_scopes?: string;
}

export type AsyncMode = 'poll' | 'webhook' | 'stream';

export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  manifest: string; // JSON-stringified NormalizedManifest
  status: 'active' | 'deploying' | 'failed';
  docker_image: string | null;
  code_path: string;
  category: string | null;
  author: string | null;
  icon: string | null;
  // proxied-mode fields (nullable for docker apps)
  app_type: 'docker' | 'proxied';
  base_url: string | null;
  auth_type: AuthType | null;
  auth_config: string | null; // JSON-stringified AuthConfig
  openapi_spec_url: string | null;
  openapi_spec_cached: string | null; // JSON-stringified OpenAPI spec
  visibility: 'public' | 'auth-required';
  // Async job queue fields (v0.3.0). is_async comes back from SQLite as 0/1.
  is_async: 0 | 1;
  webhook_url: string | null;
  timeout_ms: number | null;
  retries: number;
  async_mode: AsyncMode | null;
  // Multi-tenant fields (v0.3.1 / W2.1). workspace_id defaults to 'local' in
  // OSS mode. `memory_keys` is a JSON array declared in the app manifest that
  // lists which keys this app is allowed to persist in `app_memory`.
  workspace_id: string;
  memory_keys: string | null; // JSON-stringified string[]
  created_at: string;
  updated_at: string;
}

// ---------- jobs (v0.3.0) ----------

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface JobRecord {
  id: string;
  slug: string;
  app_id: string;
  action: string;
  status: JobStatus;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  run_id: string | null;
  webhook_url: string | null;
  timeout_ms: number;
  max_retries: number;
  attempts: number;
  per_call_secrets_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'timeout';

export type ErrorType =
  | 'timeout'
  | 'runtime_error'
  | 'missing_secret'
  | 'oom'
  | 'build_error';

export interface RunRecord {
  id: string;
  app_id: string;
  thread_id: string | null;
  action: string;
  inputs: string | null;
  outputs: string | null;
  logs: string;
  status: RunStatus;
  error: string | null;
  error_type: ErrorType | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface SecretRecord {
  id: string;
  name: string;
  value: string;
  app_id: string | null;
  created_at: string;
}

export interface ChatThreadRecord {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatTurnRecord {
  id: string;
  thread_id: string;
  turn_index: number;
  kind: 'user' | 'assistant';
  // JSON blob capturing the turn payload. Shape varies by kind:
  //   user:      { text: string }
  //   assistant: { app_slug?, inputs?, run_id?, summary?, error?, parsed? }
  payload: string;
  created_at: string;
}

// =====================================================================
// W2.1: multi-tenant schema types
// =====================================================================

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  plan: string;
  wrapped_dek: string | null;
  created_at: string;
}

export interface UserRecord {
  id: string;
  workspace_id: string | null;
  email: string | null;
  name: string | null;
  auth_provider: string;
  auth_subject: string | null;
  created_at: string;
}

export interface WorkspaceMemberRecord {
  workspace_id: string;
  user_id: string;
  role: 'admin' | 'editor' | 'viewer' | string;
  joined_at: string;
}

/**
 * Request-scoped tenant context. Every route handler builds this in middleware
 * (via `resolveUserContext`) and passes it to services. In OSS mode this is
 * always `{ workspace_id: 'local', user_id: 'local', device_id }`; in Cloud
 * (post-W3.1) it's the logged-in user's real ids.
 */
export interface SessionContext {
  workspace_id: string;
  user_id: string;
  device_id: string;
  is_authenticated: boolean;
}

export interface AppMemoryRecord {
  workspace_id: string;
  app_slug: string;
  user_id: string;
  device_id: string | null;
  key: string;
  value: string; // JSON-encoded value
  updated_at: string;
}

export interface UserSecretRecord {
  workspace_id: string;
  user_id: string;
  key: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  created_at: string;
  updated_at: string;
}

/**
 * Return shape from `rekeyDevice`. Each count tells the login handler how many
 * rows were migrated from anonymous → authenticated, for logging and tests.
 */
export interface RekeyResult {
  app_memory: number;
  runs: number;
  chat_threads: number;
  connections: number;
}

// =====================================================================
// W2.3: Composio connections
// =====================================================================

export type ConnectionOwnerKind = 'device' | 'user';
export type ConnectionStatus = 'pending' | 'active' | 'revoked' | 'expired';

/**
 * Per-user (or per-device, pre-login) connection to an external provider
 * via Composio. Created when a user clicks "Connect Gmail" on /build,
 * re-keyed to a real user_id when W3.1 Better Auth lands.
 */
export interface ConnectionRecord {
  id: string;
  workspace_id: string;
  owner_kind: ConnectionOwnerKind;
  owner_id: string;
  provider: string;
  composio_connection_id: string;
  composio_account_id: string;
  status: ConnectionStatus;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Composio provider metadata persisted alongside a connection row. Shape
 * varies per provider (email for Gmail, workspace name for Slack, etc.).
 * Stored as JSON in `connections.metadata_json`.
 */
export interface ConnectionMetadata {
  account_email?: string;
  account_name?: string;
  workspace_name?: string;
  scopes?: string[];
  [key: string]: unknown;
}

// =====================================================================
// W3.3: Stripe Connect partner app
// =====================================================================

export type StripeAccountType = 'express' | 'standard';

/**
 * One row per (workspace, user) creator. Persists Stripe Express
 * connected account state so the dashboard renders without an upstream
 * poll. `requirements_json` is the verbatim Stripe `requirements` blob
 * from `account.updated` for surfacing missing-document hints.
 */
export interface StripeAccountRecord {
  id: string;
  workspace_id: string;
  user_id: string;
  stripe_account_id: string;
  account_type: StripeAccountType;
  country: string | null;
  charges_enabled: 0 | 1;
  payouts_enabled: 0 | 1;
  details_submitted: 0 | 1;
  requirements_json: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Webhook idempotency ledger. Stripe retries deliver the same event id
 * within minutes; the unique index on `event_id` rejects duplicates so
 * each event executes exactly once.
 */
export interface StripeWebhookEventRecord {
  id: string;
  event_id: string;
  event_type: string;
  livemode: 0 | 1;
  payload: string;
  received_at: string;
}
