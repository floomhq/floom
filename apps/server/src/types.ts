// Shared types for the Floom backend.
// A trimmed subset of the marketplace schema: Floom needs apps, runs,
// secrets, hub_entries, embeddings, and run threads.

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
  /**
   * Names of the secrets (from `manifest.secrets_needed`) that THIS
   * action strictly requires. When set, the proxied-runner blocks the
   * action only when these specific secrets are missing, instead of
   * blanket-blocking on the app-level `secrets_needed`. When absent
   * (undefined), the runner falls back to the app-level list for
   * backwards compatibility with v1 manifests and non-proxied apps.
   *
   * Populated by the OpenAPI ingest pipeline from the operation's
   * effective `security` (operation-level overrides global, per
   * OpenAPI 3.x §4.8.10). Fix for INGEST-SECRETS-GLOBAL (2026-04-16).
   */
  secrets_needed?: string[];
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
  /**
   * Copied from OpenAPI `info.license` at ingest (e.g. "MIT", "Apache-2.0").
   * Surfaced on /p/:slug meta; omitted when the spec has no license block.
   */
  license?: string;
  /**
   * v16 renderer cascade: optional creator-declared hint for which stock
   * library component to mount on the run output. See
   * apps/web/src/components/output/ for the available components and
   * their props (TextBig, CodeBlock, Markdown, FileDownload). When set,
   * the web client picks this component at Layer 2 of the cascade, before
   * the auto-pick heuristics in Layer 3. Any additional keys on this
   * object are passed straight through to the component as props — the
   * `*_field` convention (e.g. `value_field: "uuid"`) lets the component
   * pluck the right property from the run output.
   *
   * Backwards compatible: apps without `render` fall through to auto-pick.
   */
  render?: RenderConfig;
}

export interface RenderConfig {
  output_component?: string;
  [key: string]: unknown;
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
  visibility: 'public' | 'auth-required' | 'private';
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
  // Store-sort fields (fast-apps wave). featured is SQLite 0/1 used to pin
  // apps to the top of /api/hub. avg_run_ms is the running mean of
  // successful run durations in milliseconds, updated by services/runner.ts
  // every time a run completes. NULL until we have at least one sample.
  featured: 0 | 1;
  avg_run_ms: number | null;
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

/**
 * Error taxonomy (2026-04-20).
 *
 * Five root-cause classes carry clear UI action (fix input / add auth /
 * retry / check URL / report bug). The legacy values
 * (`runtime_error`, `missing_secret`, `build_error`) still exist so old
 * run rows keep classifying — the client falls back when it sees them.
 *
 *   user_input_error   — upstream 4xx (non-auth). App rejected inputs.
 *   auth_error         — upstream 401/403. Credentials needed / invalid.
 *   upstream_outage    — upstream 5xx OR timeout at the upstream hop.
 *   network_unreachable — fetch failed before any status arrived.
 *   floom_internal_error — our own bug (runner crash, build fail, OOM).
 */
export type ErrorType =
  | 'timeout'
  | 'runtime_error'
  | 'missing_secret'
  | 'oom'
  | 'build_error'
  | 'user_input_error'
  | 'auth_error'
  | 'upstream_outage'
  | 'network_unreachable'
  | 'floom_internal_error';

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
  /**
   * The HTTP status the upstream API returned, when classifying a
   * proxied-runner failure. NULL for non-proxied apps, for pre-response
   * failures (DNS / TCP / TLS / timeout before headers), and for
   * successful runs. Populated by runProxied so the client can pick the
   * exact error-taxonomy class without re-parsing the raw error string.
   */
  upstream_status: number | null;
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

export interface RunThreadRecord {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunTurnRecord {
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
 * (W3.1+) it's the logged-in user's real ids — `auth_user_id` and
 * `auth_session_id` carry the Better Auth identifiers when the request is
 * authenticated.
 */
export interface SessionContext {
  workspace_id: string;
  user_id: string;
  device_id: string;
  is_authenticated: boolean;
  /** Better Auth user id (cloud mode). Same as user_id when present. */
  auth_user_id?: string;
  /** Better Auth session id (cloud mode). */
  auth_session_id?: string;
  /** User email (cloud mode), surfaced to the UI by /api/session/me. */
  email?: string;
}

// =====================================================================
// W3.1: workspaces + members API types
// =====================================================================

export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export interface WorkspaceInviteRecord {
  id: string;
  workspace_id: string;
  email: string;
  role: WorkspaceRole;
  invited_by_user_id: string;
  token: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

/**
 * Public "me" payload returned by /api/session/me. Same shape in OSS and
 * cloud — in OSS the user is the synthetic local user and there is exactly
 * one workspace named "Local".
 */
export interface SessionMePayload {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
    is_local: boolean;
  };
  active_workspace: {
    id: string;
    slug: string;
    name: string;
    role: WorkspaceRole;
  };
  workspaces: Array<{
    id: string;
    slug: string;
    name: string;
    role: WorkspaceRole;
  }>;
  cloud_mode: boolean;
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

// =====================================================================
// Secrets policy (per-app, per-secret: creator override vs user vault)
// =====================================================================

/**
 * Policy for one secret key on one app.
 *
 *   'user_vault'       — each user supplies the value from their own
 *                        /api/secrets vault. Default for every key that
 *                        doesn't have an explicit row in
 *                        app_secret_policies.
 *   'creator_override' — the creator provides one value (encrypted with
 *                        the creator's workspace DEK in app_creator_secrets)
 *                        that is injected for every user's run.
 */
export type SecretPolicy = 'user_vault' | 'creator_override';

export interface AppSecretPolicyRecord {
  app_id: string;
  key: string;
  policy: SecretPolicy;
  updated_at: string;
}

export interface AppCreatorSecretRecord {
  app_id: string;
  workspace_id: string;
  key: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  created_at: string;
  updated_at: string;
}

/**
 * Shape returned by the /secret-policies list endpoint. One row per key
 * in the app's `manifest.secrets_needed`. `creator_has_value` lets the
 * frontend render the "set / not set" state without ever reading the
 * plaintext.
 */
export interface SecretPolicyEntry {
  key: string;
  policy: SecretPolicy;
  creator_has_value: boolean;
  updated_at?: string;
}

/**
 * Return shape from `rekeyDevice`. Each count tells the login handler how many
 * rows were migrated from anonymous → authenticated, for logging and tests.
 */
export interface RekeyResult {
  app_memory: number;
  runs: number;
  run_threads: number;
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

// =====================================================================
// W4-minimal: reviews + feedback
// =====================================================================

/**
 * One row per (workspace, app, user). Rating is 1-5. Re-submitting updates
 * the existing row (idempotent upsert keyed on the UNIQUE constraint).
 */
export interface AppReviewRecord {
  id: string;
  workspace_id: string;
  app_slug: string;
  user_id: string;
  rating: number;
  title: string | null;
  body: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Product-feedback entry. Anonymous callers may post; we hash their IP for
 * per-source rate limiting. Email is optional.
 */
export interface FeedbackRecord {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  device_id: string | null;
  email: string | null;
  url: string | null;
  text: string;
  ip_hash: string | null;
  created_at: string;
}
