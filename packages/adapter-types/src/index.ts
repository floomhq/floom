// Adapter interfaces for Floom protocol 0.2.0.
//
// Source of truth for per-method semantics and invariants: spec/adapters.md.

// =====================================================================
// Shared server shapes referenced by adapter contracts
// =====================================================================

export type InputType =
  | 'text'
  | 'textarea'
  | 'url'
  | 'number'
  | 'enum'
  | 'boolean'
  | 'date'
  | 'file'
  | 'file/csv'
  | 'file/image'
  | 'file/pdf'
  | 'file/audio'
  | 'array'
  | 'object';

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
  memory_keys?: string[];
  blocked_reason?: string;
  license?: string;
  network?: {
    allowed_domains: string[];
  };
  render?: RenderConfig;
  max_run_retention_days?: number;
  primary_action?: string;
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
  apikey_header?: string;
  oauth2_token_url?: string;
  oauth2_scopes?: string;
}

export type AsyncMode = 'poll' | 'webhook' | 'stream';

export type AppVisibilityState =
  | 'private'
  | 'link'
  | 'invited'
  | 'pending_review'
  | 'public_live'
  | 'changes_requested';

export type LegacyAppVisibility = 'public' | 'auth-required';

export type AppVisibility = AppVisibilityState | LegacyAppVisibility;

export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  manifest: string;
  status: 'active' | 'deploying' | 'failed';
  docker_image: string | null;
  code_path: string;
  category: string | null;
  author: string | null;
  icon: string | null;
  app_type: 'docker' | 'proxied';
  base_url: string | null;
  auth_type: AuthType | null;
  auth_config: string | null;
  openapi_spec_url: string | null;
  openapi_spec_cached: string | null;
  visibility: AppVisibility;
  link_share_token: string | null;
  link_share_requires_auth: 0 | 1;
  review_submitted_at: string | null;
  review_decided_at: string | null;
  review_decided_by: string | null;
  review_comment: string | null;
  is_async: 0 | 1;
  webhook_url: string | null;
  timeout_ms: number | null;
  retries: number;
  async_mode: AsyncMode | null;
  max_run_retention_days: number | null;
  workspace_id: string;
  memory_keys: string | null;
  featured: 0 | 1;
  avg_run_ms: number | null;
  publish_status: 'draft' | 'pending_review' | 'published' | 'rejected';
  thumbnail_url: string | null;
  stars: number;
  hero: 0 | 1;
  created_at: string;
  updated_at: string;
}

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
  | 'build_error'
  | 'user_input_error'
  | 'auth_error'
  | 'upstream_outage'
  | 'network_unreachable'
  | 'floom_internal_error'
  | 'app_unavailable';

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
  upstream_status: number | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
  workspace_id?: string;
  user_id?: string | null;
  device_id?: string | null;
  is_public?: 0 | 1;
}

export interface SecretRecord {
  id: string;
  name: string;
  value: string;
  app_id: string | null;
  created_at: string;
}

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
  image?: string | null;
  is_admin?: 0 | 1;
  deleted_at?: string | null;
  delete_at?: string | null;
  composio_user_id?: string | null;
  created_at: string;
}

export type AgentTokenScope = 'read' | 'read-write' | 'publish-only';

export type WorkspaceMemberRole = 'admin' | 'editor' | 'viewer';
export type WorkspaceRole = WorkspaceMemberRole | 'guest';

export interface SessionContext {
  workspace_id: string;
  user_id: string;
  device_id: string;
  is_authenticated: boolean;
  auth_user_id?: string;
  auth_session_id?: string;
  email?: string;
  agent_token_id?: string;
  agent_token_scope?: AgentTokenScope;
  agent_token_rate_limit_per_minute?: number;
}

// =====================================================================
// Shared adapter shapes
// =====================================================================

export interface RuntimeResult {
  status: RunStatus;
  outputs: unknown;
  error?: string;
  error_type?: ErrorType;
  upstream_status?: number;
  duration_ms: number;
  logs: string;
}

export interface AppListFilter {
  workspace_id?: string;
  visibility?: AppVisibility;
  category?: string;
  featured?: boolean;
  limit?: number;
  offset?: number;
}

export interface RunListFilter {
  app_id?: string;
  workspace_id?: string;
  user_id?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

// =====================================================================
// 1. RuntimeAdapter
// =====================================================================

export interface RuntimeAdapter {
  execute(
    app: AppRecord,
    manifest: NormalizedManifest,
    action: string,
    inputs: Record<string, unknown>,
    secrets: Record<string, string>,
    ctx: SessionContext,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<RuntimeResult>;
}

// =====================================================================
// 2. StorageAdapter
// =====================================================================

export interface StorageAdapter {
  getApp(slug: string): Promise<AppRecord | undefined>;
  getAppById(id: string): Promise<AppRecord | undefined>;
  listApps(filter?: AppListFilter): Promise<AppRecord[]>;
  createApp(input: Omit<AppRecord, 'created_at' | 'updated_at'>): Promise<AppRecord>;
  updateApp(slug: string, patch: Partial<AppRecord>): Promise<AppRecord | undefined>;
  deleteApp(slug: string): Promise<boolean>;

  createRun(input: {
    id: string;
    app_id: string;
    thread_id?: string | null;
    action: string;
    inputs: Record<string, unknown> | null;
  }): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(filter?: RunListFilter): Promise<RunRecord[]>;
  updateRun(
    id: string,
    patch: {
      status?: RunStatus;
      outputs?: unknown;
      error?: string | null;
      error_type?: ErrorType | null;
      upstream_status?: number | null;
      logs?: string;
      duration_ms?: number | null;
      finished?: boolean;
    },
  ): Promise<void>;

  createJob(input: Omit<JobRecord, 'created_at' | 'started_at' | 'finished_at' | 'attempts' | 'status'> & { status?: JobStatus }): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | undefined>;
  claimNextJob(): Promise<JobRecord | undefined>;
  updateJob(id: string, patch: Partial<JobRecord>): Promise<void>;

  getWorkspace(id: string): Promise<WorkspaceRecord | undefined>;
  listWorkspacesForUser(user_id: string): Promise<Array<WorkspaceRecord & { role: WorkspaceRole }>>;
  getUser(id: string): Promise<UserRecord | undefined>;
  getUserByEmail(email: string): Promise<UserRecord | undefined>;
  createUser(input: UserWriteInput): Promise<UserRecord>;
  upsertUser(input: UserWriteInput, updateColumns: UserWriteColumn[]): Promise<UserRecord>;

  listAdminSecrets(app_id?: string | null): Promise<SecretRecord[]>;
  upsertAdminSecret(name: string, value: string, app_id?: string | null): Promise<void>;
  deleteAdminSecret(name: string, app_id?: string | null): Promise<boolean>;
}

export interface UserWriteInput {
  id: string;
  workspace_id?: string | null;
  email?: string | null;
  name?: string | null;
  auth_provider?: string;
  auth_subject?: string | null;
  image?: string | null;
  is_admin?: 0 | 1;
  composio_user_id?: string | null;
}

export type UserWriteColumn = Exclude<keyof UserWriteInput, 'id'>;

// =====================================================================
// 3. AuthAdapter
// =====================================================================

export interface AuthAdapter {
  getSession(request: Request): Promise<SessionContext | null>;

  signIn(input: { email: string; password?: string }): Promise<AuthSessionResult | AuthMagicLinkSentResult>;

  signUp(input: {
    email: string;
    password?: string;
    name?: string;
  }): Promise<AuthSessionResult | AuthMagicLinkSentResult>;

  verifyMagicLink?(token: string): Promise<AuthSessionResult | null>;

  signOut(session: SessionContext): Promise<void>;

  onUserDelete(cb: (user_id: string) => void | Promise<void>): void;
}

export interface AuthSessionResult {
  session: SessionContext;
  set_cookie?: string;
  token?: string;
  user_id?: string;
  session_token?: string;
}

export interface AuthMagicLinkSentResult {
  status: 'magic-link-sent';
  email: string;
}

// =====================================================================
// 4. SecretsAdapter
// =====================================================================

export interface SecretsAdapter {
  get(ctx: SessionContext, key: string): string | null;
  set(ctx: SessionContext, key: string, plaintext: string): void;
  delete(ctx: SessionContext, key: string): boolean;
  list(ctx: SessionContext): Array<{ key: string; updated_at: string }>;
  loadUserVaultForRun(
    ctx: SessionContext,
    keys: string[],
  ): Record<string, string>;
  loadCreatorOverrideForRun(
    app_id: string,
    workspace_id: string,
    keys: string[],
  ): Record<string, string>;
}

// =====================================================================
// 5. ObservabilityAdapter
// =====================================================================

export interface ObservabilityAdapter {
  captureError(err: unknown, context?: Record<string, unknown>): void;
  increment(metric: string, amount?: number, tags?: Record<string, string>): void;
  timing(metric: string, ms: number, tags?: Record<string, string>): void;
  gauge(metric: string, value: number, tags?: Record<string, string>): void;
}
