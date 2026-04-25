// Adapter interfaces for the Floom reference server
//
// The reference implementation in this repo pins ONE concrete impl for each
// of the five concerns below — Docker + HTTP proxy for runtime, SQLite for
// storage, Better Auth for identity, encrypted SQLite columns for secrets,
// and in-process counters + Sentry for observability. This file publishes
// the interface contracts for those five concerns so an alternate server
// (Kubernetes runtime, Postgres storage, Auth0 auth, Vault secrets, OTEL
// metrics, etc.) can see exactly what to implement.
//
// IMPORTANT: these are DECLARATIONS ONLY. The existing services don't
// implement these interfaces explicitly yet — that refactor is deliberately
// deferred (YAGNI + launch risk; see spec/adapters.md). The cost of
// committing to the shapes now is near-zero, the value is that anyone
// reading spec/adapters.md knows what an alternate implementation would look
// like without reading the reference server's source tree.
//
// Source of truth for per-method semantics and invariants: spec/adapters.md.

import type {
  AppRecord,
  AppReviewRecord,
  AppCreatorSecretRecord,
  AppSecretPolicyRecord,
  ConnectionRecord,
  ErrorType,
  JobRecord,
  JobStatus,
  NormalizedManifest,
  RunRecord,
  RunStatus,
  RunThreadRecord,
  RunTurnRecord,
  SecretRecord,
  SessionContext,
  StripeAccountRecord,
  StripeWebhookEventRecord,
  TriggerRecord,
  TriggerType,
  UserRecord,
  UserSecretRecord,
  WorkspaceInviteRecord,
  WorkspaceMemberRecord,
  WorkspaceMemberRole,
  WorkspaceRecord,
} from '../types.js';

// =====================================================================
// Shared shapes
// =====================================================================

export interface MemberWithUser extends WorkspaceMemberRecord {
  email: string | null;
  name: string | null;
}

/**
 * Normalized result returned by every `RuntimeAdapter.execute` call.
 *
 * Mirrors the fields the reference runner persists onto the `runs` row
 * (see services/runner.ts `updateRun`). Adapters MUST populate every
 * non-optional field. `error` / `error_type` / `upstream_status` MUST be
 * left `undefined` on success — the control plane treats "error_type set"
 * and "status !== success" as authoritative failure signals.
 */
export interface RuntimeResult {
  status: RunStatus;
  outputs: unknown;
  error?: string;
  error_type?: ErrorType;
  /**
   * HTTP status the upstream API returned, when the runtime is an HTTP
   * proxy. Undefined for container runtimes, pre-response failures
   * (DNS / TCP / TLS / timeout before headers), and for successful runs.
   */
  upstream_status?: number;
  duration_ms: number;
  /**
   * Captured stdout + stderr (container runtimes) or request/response
   * trace (proxy runtimes). Plain text; the control plane persists this
   * verbatim to `runs.logs` and surfaces it on /p/:slug for the creator.
   */
  logs: string;
}

/**
 * Filter passed to list-style StorageAdapter methods. All fields are
 * optional; an adapter MUST ignore keys it doesn't understand rather than
 * throwing. Callers rely on `limit` for pagination in /api/hub.
 */
export interface AppListFilter {
  workspace_id?: string;
  visibility?: 'public' | 'auth-required' | 'private';
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
  before_started_at?: string;
  limit?: number;
  offset?: number;
}

// =====================================================================
// 1. RuntimeAdapter
// =====================================================================

/**
 * Executes one action of a Floom app and returns a normalized result.
 *
 * The reference server ships two implementations today:
 *   1. `services/docker.ts` — spawns a Docker container per run, binds the
 *      app's code, injects secrets as env vars, streams stdout/stderr,
 *      enforces a timeout + memory cap, and parses the `__FLOOM_RESULT__`
 *      marker line from the container's stdout.
 *   2. `services/proxied-runner.ts` — forwards an HTTP request to an
 *      upstream API (for apps registered via OpenAPI spec URL), injects
 *      declared secrets into the configured auth header / cookie / query
 *      param, and classifies HTTP status codes into the `ErrorType`
 *      taxonomy.
 *
 * Both are selected at dispatch time by `services/runner.ts` based on
 * `app.app_type` ('docker' | 'proxied'). An alternate runtime (Firecracker,
 * Kubernetes Job, serverless function, WASM sandbox) would replace one or
 * both.
 *
 * Invariants a correct adapter MUST preserve:
 *   - Timeout enforcement — the adapter MUST kill the run after
 *     `app.timeout_ms` (or the server's `RUNNER_TIMEOUT` default) and
 *     return `{ status: 'timeout', error_type: 'timeout' }`. The job queue
 *     in `services/worker.ts` relies on this upper bound to make progress.
 *   - Secret injection — values in `secrets` are injected into the
 *     runtime's execution environment (env vars for containers, auth
 *     headers for proxy). Secrets MUST NOT appear in `logs` (scrub or
 *     never log them) and MUST NOT appear in `outputs`.
 *   - Output shape — `outputs` is the app's successful return payload,
 *     unmodified. Errors go to `error` / `error_type`, not to `outputs`.
 *     (The one exception is `detectSilentError` in local-docker.ts — see
 *     spec/adapters.md.)
 *   - Log capture — stdout + stderr (or equivalent) is captured to
 *     `logs` so the /p/:slug surface and `GET /api/run/:id` can show the
 *     creator what happened.
 *   - Async safety — `execute` may be called concurrently for different
 *     runs of the same app; no shared mutable state outside the per-run
 *     container / request.
 */
export interface RuntimeAdapter {
  /**
   * Run `action` of `app` with the given `inputs` and injected `secrets`.
   * Called by `services/runner.ts dispatchRun` after it has resolved the
   * secret precedence chain (global → per-app → user vault / creator
   * override → per-call `_auth`).
   *
   * `onOutput` is optional and lets the control plane stream partial
   * stdout/stderr to the log bus (see `lib/log-stream.ts`) before the run
   * finishes. Adapters that cannot stream (e.g. a fire-and-forget serverless
   * invocation) MAY omit calls to `onOutput` and emit everything at the end
   * in the returned `RuntimeResult.logs`.
   *
   * `ctx` is the tenant context; adapters that are tenant-agnostic (e.g.
   * OSS single-user) MAY ignore it.
   */
  execute(
    app: AppRecord,
    manifest: NormalizedManifest,
    action: string,
    inputs: Record<string, unknown>,
    secrets: Record<string, string>,
    ctx: SessionContext,
    run_id: string,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<RuntimeResult>;
}

// =====================================================================
// 2. StorageAdapter
// =====================================================================

/**
 * Persists Floom's durable state: apps, runs, jobs, workspaces, users,
 * and the pointer rows for secrets (the ciphertext is owned by
 * `SecretsAdapter`, not this interface).
 *
 * The reference implementation uses `better-sqlite3` against a local file
 * (`data/floom-chat.db`); see `db.ts` for the schema and migrations. An
 * alternate impl could use Postgres, PlanetScale, Durable Objects, etc.,
 * as long as the invariants below hold.
 *
 * Methods are intentionally minimal — only the ones `routes/*` and
 * `services/*` actually call today. Add methods when a new route needs
 * one; do NOT pre-define a "full CRUD" surface that nobody calls.
 *
 * Invariants a correct adapter MUST preserve:
 *   - FK ordering on delete — deleting an app MUST cascade to its runs,
 *     jobs, secret-policy rows, and creator-secret rows. The SQLite
 *     reference impl relies on `ON DELETE CASCADE` for `runs` and
 *     `jobs`; adapters without FK cascades MUST emulate it.
 *   - Transaction boundaries — `createRun` + `updateRun` across the
 *     lifecycle of one run MUST be serializable wrt reads. The job
 *     worker poll (`nextQueuedJob`) MUST be atomic with `claimJob` so two
 *     workers never pick the same job.
 *   - Tenant scoping — every tenant-addressable table (apps, runs,
 *     app_memory, user_secrets, connections, ...) MUST filter on
 *     `workspace_id`. OSS adapters MAY hardcode `workspace_id = 'local'`
 *     but MUST still include the column so the same queries work in
 *     Cloud mode.
 *   - Idempotency — `createApp` / `createRun` with a pre-existing id
 *     MUST either upsert or throw a deterministic error; callers retry
 *     on network failure.
 */
export interface HubListFilter {
  category?: string | null;
  sort?: string;
}

export interface StorageAdapter {
  // ---------- apps ----------
  getApp(slug: string): AppRecord | undefined;
  getAppById(id: string): AppRecord | undefined;
  getAppWithAuthor(slug: string): (AppRecord & { author_name: string | null; author_email: string | null }) | undefined;
  listApps(filter?: AppListFilter): AppRecord[];
  createApp(input: Omit<AppRecord, 'created_at' | 'updated_at'>): AppRecord;
  updateApp(id: string, patch: Partial<AppRecord>): AppRecord | undefined;
  deleteApp(id: string): boolean;
  setFeaturedApps(slugs: string[]): number;
  refreshAppAvgRunMs(id: string): void;
  listAppsForUser(workspace_id: string, user_id: string): Array<AppRecord & { run_count: number; last_run_at: string | null }>;
  getAppRunsByDay(app_id: string, days: number): Array<{ day: string; count: number }>;
  listHubApps(filter: HubListFilter): Array<
    AppRecord & {
      author_name: string | null;
      author_email: string | null;
      runs_7d: number;
    }
  >;

  // ---------- app reviews ----------
  getAppReviewSummary(slug: string): { count: number; avg: number };
  listAppReviews(slug: string, limit: number): Array<AppReviewRecord & { author_name: string | null; author_email: string | null }>;
  getAppReview(workspace_id: string, slug: string, user_id: string): AppReviewRecord | undefined;
  getAppReviewById(id: string): AppReviewRecord | undefined;
  createAppReview(input: Omit<AppReviewRecord, 'created_at' | 'updated_at'>): AppReviewRecord;
  updateAppReview(id: string, patch: Partial<AppReviewRecord>): AppReviewRecord | undefined;

  // ---------- waitlist ----------
  upsertWaitlistSignup(input: {
    email: string;
    source: string | null;
    user_agent: string | null;
    ip_hash: string | null;
    deploy_repo_url: string | null;
    deploy_intent: string | null;
  }): { inserted: boolean; id: string };

  // ---------- threads + turns ----------
  createThread(id: string, title?: string | null): RunThreadRecord;
  getThread(id: string): RunThreadRecord | undefined;
  updateThread(id: string, patch: { title?: string | null; updated_at?: string }): void;
  listTurns(thread_id: string): RunTurnRecord[];
  createTurn(input: Omit<RunTurnRecord, 'created_at'>): RunTurnRecord;
  getMaxTurnIndex(thread_id: string): number | null;
  countThreads(): number;
  countApps(): number;
  getRunStatusCounts(): Array<{ status: string; count: number }>;
  getActiveUsersLast24h(): number;

  // ---------- feedback ----------
  createFeedback(input: {
    id: string;
    workspace_id: string | null;
    user_id: string | null;
    device_id: string | null;
    email: string | null;
    url: string | null;
    text: string;
    ip_hash: string;
  }): void;
  listFeedback(limit: number): any[];

  // ---------- runs ----------
  createRun(input: {
    id: string;
    app_id: string;
    thread_id?: string | null;
    action: string;
    inputs: Record<string, unknown> | null;
    workspace_id: string;
    user_id?: string | null;
    device_id?: string | null;
  }): RunRecord;
  getRun(id: string): RunRecord | undefined;
  listRuns(filter?: RunListFilter): RunRecord[];
  /**
   * Patch a run row mid-lifecycle. Called by the runtime driver as output
   * streams in. `finished: true` MUST set `finished_at` to the adapter's
   * "now", and when `status === 'success'` with a numeric `duration_ms`
   * the adapter SHOULD refresh `apps.avg_run_ms` (see
   * `services/runner.ts refreshAppAvgRunMs`).
   */
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
  ): void;

  // ---------- jobs (async queue) ----------
  createJob(input: Omit<JobRecord, 'created_at' | 'started_at' | 'finished_at' | 'attempts' | 'status'> & { status?: JobStatus }): JobRecord;
  getJob(id: string): JobRecord | undefined;
  getJobBySlug(slug: string, id: string): JobRecord | undefined;
  /** Atomic dequeue — returns undefined when the queue is empty. */
  claimNextJob(): JobRecord | undefined;
  updateJob(id: string, patch: Partial<JobRecord>): JobRecord | undefined;
  countJobsByStatus(status: JobStatus): number;

  // ---------- workspaces + users ----------
  getWorkspace(id: string): WorkspaceRecord | undefined;
  getWorkspaceBySlug(slug: string): WorkspaceRecord | undefined;
  listWorkspacesForUser(user_id: string): Array<WorkspaceRecord & { role: WorkspaceMemberRole }>;
  createWorkspace(input: { id: string; slug: string; name: string; plan: string }): WorkspaceRecord;
  updateWorkspace(id: string, patch: { name?: string; slug?: string; wrapped_dek?: string | null }): WorkspaceRecord | undefined;
  deleteWorkspace(id: string): void;

  getUser(id: string): UserRecord | undefined;
  getUserByEmail(email: string): UserRecord | undefined;
  createUser(input: Omit<UserRecord, 'created_at'>): UserRecord;
  getBetterAuthUser(id: string): { name: string | null; image: string | null; email: string | null } | undefined;

  // ---------- members ----------
  getMemberRole(workspace_id: string, user_id: string): WorkspaceMemberRole | null;
  listWorkspaceMembers(workspace_id: string): MemberWithUser[];
  upsertWorkspaceMember(workspace_id: string, user_id: string, role: WorkspaceMemberRole): void;
  removeWorkspaceMember(workspace_id: string, user_id: string): void;
  countWorkspaceAdmins(workspace_id: string): number;

  // ---------- invites ----------
  getWorkspaceInvite(id: string): WorkspaceInviteRecord | undefined;
  getWorkspaceInviteByToken(token: string): WorkspaceInviteRecord | undefined;
  listWorkspaceInvites(workspace_id: string): WorkspaceInviteRecord[];
  createWorkspaceInvite(input: Omit<WorkspaceInviteRecord, 'created_at' | 'accepted_at'>): WorkspaceInviteRecord;
  updateWorkspaceInvite(id: string, patch: Partial<WorkspaceInviteRecord>): void;
  deleteWorkspaceInvite(id: string): void;

  // ---------- active workspace ----------
  getActiveWorkspaceId(user_id: string): string | null;
  setActiveWorkspaceId(user_id: string, workspace_id: string): void;
  deleteActiveWorkspaceForWorkspace(workspace_id: string): void;
  deleteActiveWorkspaceForUserAndWorkspace(user_id: string, workspace_id: string): void;

  // ---------- combined / atomic operations ----------
  /** Create workspace + add member + set active in one go */
  createWorkspaceWithMember(input: {
    workspace: { id: string; slug: string; name: string; plan: string };
    user_id: string;
    role: WorkspaceMemberRole;
  }): WorkspaceRecord;

  /** Accept invite + add member + set active + update invite status */
  acceptInviteWithMember(input: {
    invite_id: string;
    workspace_id: string;
    user_id: string;
    role: WorkspaceMemberRole;
  }): void;

  // ---------- user secrets ----------
  listUserSecrets(workspace_id: string, user_id: string): UserSecretRecord[];
  upsertUserSecret(input: Omit<UserSecretRecord, 'created_at' | 'updated_at'>): void;
  deleteUserSecret(workspace_id: string, user_id: string, key: string): void;

  // ---------- app creator secrets ----------
  listAppCreatorSecrets(workspace_id: string, app_id: string): AppCreatorSecretRecord[];
  upsertAppCreatorSecret(input: Omit<AppCreatorSecretRecord, 'created_at' | 'updated_at'>): void;
  deleteAppCreatorSecret(workspace_id: string, app_id: string, key: string): void;

  // ---------- app secret policies ----------
  listAppSecretPolicies(app_id: string): AppSecretPolicyRecord[];
  getAppSecretPolicy(app_id: string, key: string): AppSecretPolicyRecord | undefined;
  upsertAppSecretPolicy(input: Omit<AppSecretPolicyRecord, 'updated_at'>): void;
  deleteAppSecretPolicy(app_id: string, key: string): void;

  // ---------- triggers ----------
  getTrigger(id: string): TriggerRecord | undefined;
  getTriggerByWebhookPath(path: string): TriggerRecord | undefined;
  listTriggersForUser(user_id: string): TriggerRecord[];
  listTriggersForApp(app_id: string): TriggerRecord[];
  createTrigger(input: any): TriggerRecord;
  updateTrigger(id: string, patch: any): TriggerRecord | undefined;
  deleteTrigger(id: string): boolean;
  readyScheduleTriggers(nowMs: number): TriggerRecord[];
  claimScheduleTrigger(id: string, readNextRun: number, nextMs: number, nowMs: number, lastFired: boolean): boolean;
  markWebhookFired(id: string, nowMs: number): void;
  recordWebhookDelivery(triggerId: string, requestId: string, nowMs: number, ttlMs: number): boolean;
  getJobTriggerContext(jobId: string): { trigger_id: string; trigger_type: TriggerType } | undefined;
  setJobTriggerContext(jobId: string, triggerId: string, triggerType: TriggerType): void;

  // ---------- stripe connect ----------
  getStripeAccount(workspace_id: string, user_id: string): StripeAccountRecord | undefined;
  getStripeAccountByStripeId(stripe_account_id: string): StripeAccountRecord | undefined;
  createStripeAccount(input: any): StripeAccountRecord;
  updateStripeAccount(stripe_account_id: string, patch: any): StripeAccountRecord | undefined;
  recordStripeWebhookEvent(input: any): void;
  isStripeWebhookEventProcessed(event_id: string): boolean;
  listStripeWebhookEvents(limit: number): StripeWebhookEventRecord[];
  getStripeWebhookEvent(event_id: string): StripeWebhookEventRecord | undefined;

  // ---------- sessions & rekey ----------
  rekeyDevice(device_id: string, user_id: string, workspace_id: string, default_user_id: string): any;
  updateUser(id: string, patch: { name?: string | null; email?: string | null; image?: string | null; composio_user_id?: string | null }): UserRecord | undefined;
  upsertUser(input: any): UserRecord;
  cleanupUserOrphans(userId: string, defaultWorkspaceId: string): void;
  purgeUnverifiedAuthSessions(): number;

  // ---------- app memory ----------
  getAppMemory(workspace_id: string, app_slug: string, user_id: string, key: string): string | undefined;
  setAppMemory(input: any): void;
  deleteAppMemory(workspace_id: string, app_slug: string, user_id: string, key: string): boolean;
  listAppMemory(workspace_id: string, app_slug: string, user_id: string): any[];
  listAppMemoryKeys(workspace_id: string, app_slug: string, user_id: string, keys: string[]): any[];

  // ---------- embeddings ----------
  upsertEmbedding(appId: string, text: string, vector: Buffer): void;
  listMissingEmbeddings(): AppRecord[];
  listAllEmbeddings(): any[];

  // ---------- connections ----------
  upsertConnection(input: any): ConnectionRecord;
  getConnection(workspace_id: string, owner_kind: string, owner_id: string, provider: string): ConnectionRecord | undefined;
  getConnectionByComposioId(workspace_id: string, owner_kind: string, owner_id: string, composio_connection_id: string): ConnectionRecord | undefined;
  listConnections(filter: { workspace_id: string; owner_kind: string; owner_id: string; status?: string }): ConnectionRecord[];
  updateConnection(id: string, patch: any): ConnectionRecord | undefined;

  // ---------- secrets ----------
  upsertSecret(input: { id: string; name: string; value: string; app_id: string }): void;

  // ---------- admin secret pointers ----------
  // Ciphertext for user/creator secrets is owned by SecretsAdapter. This
  // section covers the legacy `secrets` table (global + per-app admin
  // values, populated from env or the /api/secrets UI).
  listAdminSecrets(app_id?: string | null): SecretRecord[];
  upsertAdminSecret(name: string, value: string, app_id?: string | null): void;
  deleteAdminSecret(name: string, app_id?: string | null): boolean;
  
  // ---------- internal ----------
  /**
   * Returns the underlying driver instance (e.g. better-sqlite3.Database).
   * Used sparingly by modules that need to pass a driver to a 3rd party
   * library (like Better Auth).
   */
  getRawDatabase(): any;
}

// =====================================================================
// 3. AuthAdapter
// =====================================================================

/**
 * Resolves a request into a `SessionContext` and handles sign-in / sign-up /
 * sign-out.
 *
 * The reference impl is `lib/better-auth.ts`, which wraps Better Auth
 * 1.6.3 with email+password + GitHub/Google OAuth + API keys +
 * organizations. In OSS mode the adapter is effectively a no-op: every
 * request resolves to `SessionContext.workspace_id = 'local'`,
 * `user_id = 'local'`, with a synthetic device cookie for pre-login
 * continuity.
 *
 * Floom's surface needs only three things from the identity layer:
 *   1. `{ user_id, workspace_id, email? }` on every authenticated request.
 *   2. A way to sign users in / up / out.
 *   3. A hook to clean up per-user data when an account is deleted
 *      (W4-minimal POST /auth/delete-user).
 *
 * The adapter DOES NOT need to expose MFA, magic link, passkeys, OAuth
 * provider enumeration, session rotation policies, rate limits, or any
 * other provider-specific feature. Those are adapter-internal details.
 *
 * Invariants a correct adapter MUST preserve:
 *   - `getSession` returns `null` (not a SessionContext with fake ids) for
 *     unauthenticated requests in cloud mode, so the middleware can
 *     return 401. In OSS mode `getSession` MAY always return the local
 *     context.
 *   - A successful sign-in MUST emit a cookie or token that `getSession`
 *     can later resolve. The adapter owns the cookie name / header
 *     format; callers never inspect it directly.
 *   - `onUserDelete` runs AFTER the account row is gone, not before —
 *     callers rely on it to cascade-delete per-user rows
 *     (`app_memory`, `user_secrets`, `connections`, ...).
 */
export interface AuthAdapter {
  /**
   * Resolve a Request into a SessionContext, or null when the request is
   * unauthenticated. Called by the `resolveUserContext` middleware on
   * every /api/* request.
   */
  getSession(request: Request): Promise<SessionContext | null>;

  /**
   * Create a session for an existing user. Returns the session token the
   * caller should set as a cookie / bearer on the next request.
   */
  signIn(input: { email: string; password: string }): Promise<{
    session: SessionContext;
    set_cookie?: string;
    token?: string;
  }>;

  /**
   * Register a new user and sign them in. The adapter is free to
   * require email verification, apply rate limits, etc. — those are
   * internal policy.
   */
  signUp(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<{
    session: SessionContext;
    set_cookie?: string;
    token?: string;
  }>;

  /**
   * Invalidate a session. MUST return without throwing even if the
   * session has already expired.
   */
  signOut(session: SessionContext): Promise<void>;

  /**
   * Register a listener that fires when an account is deleted. The
   * adapter MUST invoke every registered callback in registration order.
   * Used by the control plane to cascade-delete per-user rows.
   */
  onUserDelete(cb: (user_id: string) => void | Promise<void>): void;
}

// =====================================================================
// 4. SecretsAdapter
// =====================================================================

/**
 * Stores per-workspace, per-user encrypted secrets and resolves them into
 * plaintext env vars for a run.
 *
 * The reference impl is two files — `services/user_secrets.ts` (per-user
 * vault) and `services/app_creator_secrets.ts` (creator override with
 * per-app policy) — both backed by AES-256-GCM encrypted columns on
 * SQLite. The master key is `FLOOM_MASTER_KEY`, the per-workspace DEK
 * is wrapped by it, and no plaintext value is ever persisted or logged.
 *
 * An alternate impl could use HashiCorp Vault, AWS Secrets Manager, GCP
 * Secret Manager, Bitwarden, or env vars on a single-user box. Floom
 * never reads the plaintext outside the moment of injecting it into the
 * runtime — that invariant is what lets adapters treat the store as
 * fully opaque.
 *
 * Invariants a correct adapter MUST preserve:
 *   - Plaintext is never returned by `list()` — only key names +
 *     timestamps. `get()` is the only unmasking path.
 *   - `loadForRun()` MUST filter to the `keys` the caller requested,
 *     never return extras. Callers pass the exact
 *     `manifest.secrets_needed` list so unrelated creds don't leak into
 *     apps that don't need them.
 *   - Deletion is idempotent — deleting a missing key returns false, not
 *     an error.
 *   - Creator-override keys MUST NOT fall back to the user vault.
 *     Precedence is a control-plane concern (runner.ts), but the
 *     adapter MUST keep the two namespaces distinct
 *     (`loadUserVaultForRun` and `loadCreatorOverrideForRun`).
 */
export interface SecretsAdapter {
  /** Unmask a single secret. Returns null when the key is unset. */
  get(ctx: SessionContext, key: string): string | null;

  /** Upsert a secret. Plaintext MUST NOT be logged. */
  set(ctx: SessionContext, key: string, plaintext: string): void;

  /** Delete a secret. Returns true when a row was removed. */
  delete(ctx: SessionContext, key: string): boolean;

  /**
   * List the keys this user has populated, masked. Returns key name +
   * updated_at only — never plaintext. Used by the vault UI.
   */
  list(ctx: SessionContext): Array<{ key: string; updated_at: string }>;

  /**
   * Load a batch of plaintext secrets for the runner. MUST filter to
   * the caller's `keys` list; any key the user has not set is simply
   * absent from the returned map (not an error).
   */
  loadUserVaultForRun(
    ctx: SessionContext,
    keys: string[],
  ): Record<string, string>;

  /**
   * Load creator-owned override values for a specific app + key list.
   * `workspace_id` is the app's authoring workspace (not the running
   * user's), so the values decrypt under the creator's DEK.
   */
  loadCreatorOverrideForRun(
    app_id: string,
    workspace_id: string,
    keys: string[],
  ): Record<string, string>;

  // ---------- internal ----------
  /**
   * Returns the underlying driver instance (e.g. better-sqlite3.Database).
   * Used sparingly by modules that need to pass a driver to a 3rd party
   * library (like Better Auth).
   */
  getRawDatabase(): any;
}

// =====================================================================
// 5. ObservabilityAdapter
// =====================================================================

/**
 * Captures errors and emits counter / timing / gauge metrics.
 *
 * The reference impl is a split: `lib/sentry.ts` for error capture (no-op
 * when `SENTRY_DSN` is unset), and `lib/metrics-counters.ts` for
 * in-process counters surfaced at `GET /api/metrics` in Prometheus text
 * format. Everything is optional — a Floom server with neither of these
 * wired up still runs; callers get a default no-op adapter.
 *
 * An alternate impl could forward to OpenTelemetry, Datadog, StatsD, New
 * Relic, Honeycomb, etc. The adapter is intentionally side-effect-only:
 * nothing in the control plane ever reads back from observability.
 *
 * Invariants a correct adapter MUST preserve:
 *   - Never throw from any method. An observability bug MUST NOT break
 *     the request. The reference Sentry impl wraps `captureException`
 *     in try/catch; adapters MUST do the same.
 *   - Scrub secrets — `captureError` context MUST NOT leak tokens,
 *     passwords, API keys, or cookie values. The reference impl's
 *     `scrubSecrets` helper is a minimal reference.
 *   - Tags — counter / timing / gauge metrics accept a `tags` map; the
 *     adapter MUST use the tag keys verbatim in its backend (Prom
 *     labels, DD tags, OTEL attributes). Callers pick the keys.
 */
export interface ObservabilityAdapter {
  /**
   * Capture a server-side exception. Safe to call with or without
   * context; context keys are scrubbed for secret-looking patterns.
   */
  captureError(err: unknown, context?: Record<string, unknown>): void;

  /** Increment a counter. `amount` defaults to 1. */
  increment(metric: string, amount?: number, tags?: Record<string, string>): void;

  /** Record a duration in milliseconds. */
  timing(metric: string, ms: number, tags?: Record<string, string>): void;

  /** Set an absolute gauge value. */
  gauge(metric: string, value: number, tags?: Record<string, string>): void;
}
