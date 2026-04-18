// Shared frontend types. Mirrors the server's API response shapes.

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
   * Optional per-action required secrets. Populated by the OpenAPI
   * ingest pipeline from the operation's effective `security`. When
   * set, the proxied-runner enforces this list instead of the app-level
   * `secrets_needed`. See apps/server/src/types.ts for details.
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
  /** From OpenAPI info.license at ingest */
  license?: string;
}

export interface HubApp {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  author: string | null;
  /**
   * Resolved from `users.name` / email when `author` matches a cloud user id.
   * Prefer this for display over raw `author`.
   */
  author_display?: string | null;
  icon: string | null;
  actions: string[];
  runtime: string;
  created_at: string;
  /**
   * Pinned to the top of the store. Backend default order is
   * `featured DESC, avg_run_ms ASC, created_at DESC, name ASC` so the
   * frontend does not have to re-sort when this flag is set.
   */
  featured?: boolean;
  /**
   * Rolling average run time in milliseconds (last 20 successful runs).
   * Null until at least one successful run has been recorded.
   */
  avg_run_ms?: number | null;
  /**
   * Optional: if the app is blocked in this self-host environment
   * (e.g. `flyfast` pending internal flight-search infra), the reason is
   * surfaced here and rendered as a warning pill on the store card.
   * Absence = app is runnable.
   */
  blocked_reason?: string;
}

export interface AppDetail extends HubApp {
  manifest: NormalizedManifest;
  /**
   * v15.2 polish: hub emits visibility so the web client can gate
   * private-only UI (e.g. /me/a/:slug console) and render pills without
   * a second round-trip. Optional for back-compat with older servers.
   */
  visibility?: AppVisibility;
  /**
   * v0.3.0 async job queue. When true, runs are enqueued on the server
   * (POST /api/:slug/jobs) and the web client polls GET /api/:slug/jobs/:id
   * until the status flips to a terminal state.
   */
  is_async?: boolean;
  async_mode?: 'poll' | 'webhook' | null;
  timeout_ms?: number | null;
  /**
   * W2.2 custom renderer. Populated when the creator has uploaded a
   * TSX renderer (see POST /api/hub/:slug/renderer). When present, the
   * web client lazy-loads /renderer/:slug/bundle.js and mounts its
   * default export instead of the default OutputPanel.
   */
  renderer?: RendererMeta | null;
}

export interface RendererMeta {
  source_hash: string;
  bytes: number;
  output_shape: string;
  compiled_at: string;
}

// ---------- v0.3.0 async job queue ----------

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  slug: string;
  app_id: string;
  action: string;
  status: JobStatus;
  input: Record<string, unknown> | null;
  output: unknown;
  error: unknown;
  run_id: string | null;
  webhook_url: string | null;
  timeout_ms: number;
  max_retries: number;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface PickResult {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  icon: string | null;
  confidence: number;
}

export interface ParseResult {
  app_slug: string;
  action: string;
  inputs: Record<string, unknown>;
  confidence: number;
  reasoning: string;
}

export type RunStatus = 'pending' | 'running' | 'success' | 'error' | 'timeout';

export interface RunRecord {
  id: string;
  app_id: string;
  thread_id: string | null;
  action: string;
  inputs: Record<string, unknown> | null;
  outputs: unknown;
  status: RunStatus;
  error: string | null;
  error_type: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  logs: string;
  // Populated by GET /api/run/:id so /p/:slug?run=<id> can validate the
  // run belongs to the slug in the URL before rendering restore state.
  app_slug?: string | null;
}

// ---------- W4-minimal: session + dashboard types ----------

export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export interface SessionWorkspace {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
}

export interface SessionMePayload {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
    is_local: boolean;
  };
  active_workspace: SessionWorkspace;
  workspaces: SessionWorkspace[];
  cloud_mode: boolean;
}

export interface MeRunSummary {
  id: string;
  action: string;
  status: RunStatus;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  error_type: string | null;
  app_slug: string | null;
  app_name: string | null;
  app_icon: string | null;
  /**
   * v15.1 /me: the run's input payload, surfaced on the summary response
   * so the threads rail can derive a human-readable title (inputs.prompt
   * or the first string input) without a per-row detail fetch. Optional
   * for back-compat with older servers.
   */
  inputs?: Record<string, unknown> | null;
}

export interface MeRunDetail extends MeRunSummary {
  app_id: string;
  thread_id: string | null;
  inputs: Record<string, unknown> | null;
  outputs: unknown;
  logs: string;
}

export interface ReviewSummary {
  count: number;
  avg: number;
}

export interface Review {
  id: string;
  app_slug: string;
  rating: number;
  title: string | null;
  body: string | null;
  author_name: string;
  created_at: string;
  updated_at: string;
}

// ConnectionRecord (Composio OAuth connection) type is deferred with the
// connections UI. See docs/DEFERRED-UI.md and
// feature/ui-composio-connections. Backend shape lives in
// apps/server/src/lib/schema/connections.ts.

export interface DetectedApp {
  slug: string;
  name: string;
  description: string;
  actions: Array<{ name: string; label: string; description?: string }>;
  auth_type: string | null;
  category: string | null;
  openapi_spec_url: string;
  tools_count: number;
  secrets_needed: string[];
}

export type AppVisibility =
  | 'public'
  | 'unlisted'
  | 'private'
  | 'auth-required'
  | 'invite-only';

export interface CreatorApp {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  icon: string | null;
  author: string | null;
  status: string;
  app_type: string;
  openapi_spec_url: string | null;
  created_at: string;
  updated_at: string;
  run_count: number;
  last_run_at: string | null;
  /**
   * v15.2: surfaced by /api/hub/mine so /me can render the private pill
   * on apps the caller owns. Older server builds may not emit it; hence
   * optional.
   */
  visibility?: AppVisibility;
  /**
   * v15.2: whether this app runs via the async job queue. Mirrors the
   * AppDetail.is_async flag so the /me/a/:slug overview can show an
   * "async · ~60s per run" hint without a second fetch.
   */
  is_async?: boolean;
}

// ---------- v15.2: per-user encrypted secrets vault ----------

export interface UserSecretEntry {
  key: string;
  updated_at: string | null;
}

export interface UserSecretsList {
  entries: UserSecretEntry[];
}

// ---------- secrets-policy: per-app, per-secret resolution policy ----------

/**
 * Who supplies the value for one secret key on one app.
 *
 *   'user_vault'       — each running user brings their own value via the
 *                        user vault (/api/secrets). Default.
 *   'creator_override' — the creator sets a single value the runner
 *                        injects for every user of this app. Used for
 *                        shared infra credentials.
 */
export type SecretPolicy = 'user_vault' | 'creator_override';

export interface SecretPolicyEntry {
  key: string;
  policy: SecretPolicy;
  /**
   * True when the creator has stored a value for this key. The
   * plaintext is NEVER sent to the client — this flag lets the UI
   * render a "value set" vs "no value yet" badge without leaking.
   */
  creator_has_value: boolean;
  updated_at?: string;
}

export interface SecretPoliciesResponse {
  policies: SecretPolicyEntry[];
}

export interface CreatorRun {
  id: string;
  action: string;
  status: RunStatus;
  inputs: Record<string, unknown> | null;
  outputs: unknown;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  error_type: string | null;
  caller_hash: string;
  is_self: boolean;
}
