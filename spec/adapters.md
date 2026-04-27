# Floom adapter interfaces

Version: 0.1-draft · Last updated: 2026-04-20

This doc formalizes [§10 of protocol.md](./protocol.md) — the five pluggable concerns any Floom server is built out of.

The reference server in this repo pins one concrete implementation for each of runtime, storage, auth, secrets, and observability. This doc publishes the interface contracts for those five concerns so an alternate server (Kubernetes runtime, Postgres storage, Auth0 identity, Vault secrets, OpenTelemetry observability, etc.) can see exactly what to implement.

TypeScript declarations: [`@floom/adapter-types`](../packages/adapter-types/src/index.ts). The server keeps [`apps/server/src/adapters/types.ts`](../apps/server/src/adapters/types.ts) as a compatibility re-export for in-repo imports.

> **Status.** The five interfaces are *declarations only* today. The reference services (`runner.ts`, `db.ts`, `better-auth.ts`, `user_secrets.ts`, `sentry.ts`) don't implement them explicitly yet — that refactor is deferred for launch-risk reasons. The shapes are stable; a future PR will make the existing services formally conform to these interfaces and expose a single adapter-registration point.

> Of the five, only the **renderer** is currently swappable *at runtime* via the per-app bundle upload (see [§3.3](./protocol.md#33-renderconfig) and `POST /api/hub/:slug/renderer`). The other five are *compile-time swappable* — change the adapter import in the server bootstrap and rebuild.

---

## RuntimeAdapter

**Purpose.** Executes one action of a Floom app and returns a normalized result.

The reference server ships two runtime adapters selected by `FLOOM_RUNTIME`.
The default Docker adapter owns `app.app_type` dispatch internally:
1. **Docker app strategy** (`services/docker.ts`) — spawns a container per run, injects secrets as env vars, streams stdout/stderr, enforces a timeout + memory cap, and parses the `__FLOOM_RESULT__` marker line from stdout.
2. **Proxy app strategy** (`services/proxied-runner.ts`) — forwards an HTTP request to an upstream API (for apps registered via OpenAPI spec URL), injects declared secrets into the auth header / cookie / query param, and classifies HTTP statuses into the `ErrorType` taxonomy.

### Signature

```ts
interface RuntimeAdapter {
  execute(
    app: AppRecord,
    manifest: NormalizedManifest,
    action: string,
    inputs: Record<string, unknown>,
    secrets: Record<string, string>,
    ctx: SessionContext,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    runContext?: RuntimeExecutionContext,
  ): Promise<RuntimeResult>;
}

interface RuntimeExecutionContext {
  runId?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

interface RuntimeResult {
  status: 'success' | 'error' | 'timeout';
  outputs: unknown;
  error?: string;
  error_type?: ErrorType; // timeout | user_input_error | auth_error | ...
  upstream_status?: number;
  duration_ms: number;
  logs: string;
}
```

### Invariants

- **Timeout enforcement.** The adapter MUST kill the run after `runContext.timeoutMs` when supplied, otherwise its configured default (300s for the Docker runtime, see `docker.ts` `RUNNER_TIMEOUT`), and return `{ status: 'timeout', error_type: 'timeout' }`. The job worker relies on this upper bound to make progress — an adapter that silently runs longer will starve the queue.
- **Secret injection.** Values in `secrets` are injected into the execution environment (env vars for containers, auth headers for proxy). Secrets MUST NOT appear in `logs` or `outputs`.
- **Output shape.** `outputs` is the app's successful return payload, verbatim. Errors go to `error` / `error_type`, not to `outputs`.
- **Log capture.** stdout + stderr (or request/response trace) is captured to `logs` for display on `/p/:slug` and `GET /api/run/:id`.
- **Async safety.** `execute` may be called concurrently for different runs of the same app. No shared mutable state outside the per-run container / request.

### Interaction with the job queue

Long-running apps (`is_async = 1`) are invoked via `POST /api/:slug/jobs`, which inserts into the `jobs` table. A background worker (`services/worker.ts`) claims jobs one at a time and calls the runtime adapter synchronously. The timeout invariant above is what the worker relies on to free the slot. If the adapter cannot enforce a timeout (e.g. fire-and-forget serverless), wrap it in a watchdog at the control-plane layer.

### How to write one

Pick your execution substrate (Firecracker, K8s Job, Cloud Run, WASM), implement `execute`, map your native error shape onto the `ErrorType` taxonomy, and pass the resulting `RuntimeResult` back. The selected runtime adapter owns every supported `app_type` for that deployment; `app_type: 'proxied'` can reuse the reference proxy runner unchanged.

**Worked example.** The default Floom server implements `RuntimeAdapter` using `dockerode`. See `apps/server/src/services/runner.ts` (`dispatchRun`) for the dispatch path; the actual container spawn lives in `apps/server/src/services/docker.ts` (`runAppContainer`).

---

## StorageAdapter

**Purpose.** Persists Floom's durable state: apps, runs, run threads/turns, agent tokens, jobs, workspaces, users, and admin secret pointers. (Per-user / per-creator secret ciphertext is owned by `SecretsAdapter`, not this one.)

The reference impl uses `better-sqlite3` against a local file (`data/floom-chat.db`); see `apps/server/src/db.ts` for the schema and migrations.

### Signature

```ts
interface StorageAdapter {
  // apps
  getApp(slug: string): AppRecord | undefined;
  getAppById(id: string): AppRecord | undefined;
  listApps(filter?: AppListFilter): AppRecord[];
  createApp(input: Omit<AppRecord, 'created_at' | 'updated_at'>): AppRecord;
  updateApp(slug: string, patch: Partial<AppRecord>): AppRecord | undefined;
  deleteApp(slug: string): boolean;

  // runs
  createRun(input: { id, app_id, thread_id?, action, inputs }): RunRecord;
  getRun(id: string): RunRecord | undefined;
  listRuns(filter?: RunListFilter): RunRecord[];
  updateRun(id: string, patch: RunPatch): void;

  // run threads + turns
  createRunThread(input: {
    id: string;
    title?: string | null;
    workspace_id?: string;
    user_id?: string | null;
    device_id?: string | null;
  }): RunThreadRecord;
  getRunThread(id: string): RunThreadRecord | undefined;
  listRunTurns(thread_id: string): RunTurnRecord[];
  appendRunTurn(input: {
    id: string;
    thread_id: string;
    kind: 'user' | 'assistant';
    payload: string;
  }): RunTurnRecord;
  updateRunThread(id: string, patch: { title?: string | null }): RunThreadRecord | undefined;

  // agent tokens
  createAgentToken(input: AgentTokenRecord): AgentTokenRecord;
  listAgentTokensForUser(user_id: string): AgentTokenRecord[];
  getAgentTokenForUser(id: string, user_id: string): AgentTokenRecord | undefined;
  revokeAgentTokenForUser(id: string, user_id: string, revoked_at: string): AgentTokenRecord | undefined;

  // jobs
  createJob(input): JobRecord;
  getJob(id: string): JobRecord | undefined;
  claimNextJob(): JobRecord | undefined; // atomic dequeue
  updateJob(id: string, patch: Partial<JobRecord>): void;

  // workspaces + users
  getWorkspace(id: string): WorkspaceRecord | undefined;
  listWorkspacesForUser(user_id: string): Array<WorkspaceRecord & { role }>;
  getUser(id: string): UserRecord | undefined;
  getUserByEmail(email: string): UserRecord | undefined;
  createUser(input): UserRecord;

  // admin secret pointers (global + per-app)
  listAdminSecrets(app_id?: string | null): SecretRecord[];
  upsertAdminSecret(name, value, app_id?): void;
  deleteAdminSecret(name, app_id?): boolean;
}
```

### Invariants

- **FK ordering on delete.** Deleting an app MUST cascade to its runs, jobs, secret-policy rows, and creator-secret rows. The SQLite impl uses `ON DELETE CASCADE`; adapters without FK cascades MUST emulate it.
- **Transaction boundaries.** `createRun` + `updateRun` across the lifecycle of one run MUST be serializable wrt reads. The job worker poll MUST be atomic with `claimJob` — two workers picking the same job is a correctness bug.
- **Run turns.** `appendRunTurn` MUST append at the next monotonically increasing `turn_index` for the thread and `listRunTurns` MUST return rows in ascending `turn_index` order.
- **Agent tokens.** `createAgentToken` MUST persist the pre-hashed token only; plaintext tokens never enter storage. `revokeAgentTokenForUser` MUST be idempotent and preserve the first `revoked_at` timestamp.
- **Tenant scoping.** Every tenant-addressable table filters on `workspace_id`. OSS adapters MAY hardcode `workspace_id = 'local'` but MUST keep the column so the same queries work in Cloud mode.
- **Idempotency.** `createApp` / `createRun` with a pre-existing id MUST either upsert or throw a deterministic error. Callers retry on network failure.

### How to write one

Map each method to your backend's native primitives. For Postgres, most methods are one-line queries and the `claimNextJob` method is a `SELECT ... FOR UPDATE SKIP LOCKED`. For a K/V store, you'll need secondary indexes on slug, workspace_id, and job status. Keep the method surface minimal — add new methods only when a route actually calls them; do not pre-build a "full ORM" surface.

---

## AuthAdapter

**Purpose.** Resolves a request into a `SessionContext` and handles sign-in / sign-up / sign-out.

The reference impl is `apps/server/src/lib/better-auth.ts`, which wraps Better Auth 1.6.3 with email+password + GitHub/Google OAuth + API keys + organizations. In OSS mode the adapter is effectively a no-op: every request resolves to the synthetic local workspace + user.

### Signature

```ts
interface AuthAdapter {
  getSession(request: Request): Promise<SessionContext | null>;
  signIn(input: { email; password? }): Promise<{ session, set_cookie?, token? } | { status: 'magic-link-sent', email }>;
  signUp(input: { email; password?; name? }): Promise<{ session, set_cookie?, token? } | { status: 'magic-link-sent', email }>;
  verifyMagicLink?(token: string): Promise<{ session, set_cookie?, token?, user_id?, session_token? } | null>;
  signOut(session: SessionContext): Promise<void>;
  onUserDelete(cb: (user_id: string) => void | Promise<void>): void;
}
```

### Invariants

- `getSession` returns `null` (not a fake SessionContext) for unauthenticated requests in cloud mode so the middleware can return 401. In OSS mode it MAY always return the local context.
- A successful sign-in MUST emit a cookie or token that `getSession` can later resolve. The adapter owns the cookie name / header format; callers never inspect it directly.
- Some adapters are not password-based. A magic-link adapter MAY return `{ status: 'magic-link-sent', email }` from `signIn` / `signUp`, then expose `verifyMagicLink(token)` as the completion step that emits the resolvable cookie or token.
- `onUserDelete` runs AFTER the account row is gone, not before — callers use it to cascade-delete per-user rows (`app_memory`, `user_secrets`, `connections`).

### What Floom actually needs

Only three things:

1. `{ user_id, workspace_id, email? }` on every authenticated request.
2. Sign in / up / out.
3. An account-deletion hook.

The adapter does NOT need to expose MFA, passkeys, OAuth provider enumeration, session rotation policies, or rate limits. Those are adapter-internal details. Passwordless adapters fit as long as Floom gets the same session context after the adapter-specific completion step.

### Extensions

- `verifyMagicLink(token)` is optional and only required for magic-link-style adapters. It validates the one-time token, consumes it, marks the storage-backed user as verified when the backend supports that state, and returns a normal session result with a JWT/cookie that `getSession` can resolve.

---

## SecretsAdapter

**Purpose.** Stores per-workspace, per-user encrypted secrets and resolves them into plaintext env vars for a run.

The reference impl is split across `apps/server/src/services/user_secrets.ts` (per-user vault) and `apps/server/src/services/app_creator_secrets.ts` (creator override with per-app policy). Both back to AES-256-GCM encrypted columns on SQLite; master key is `FLOOM_MASTER_KEY`, per-workspace DEK is wrapped by it.

### Signature

```ts
interface SecretsAdapter {
  get(ctx: SessionContext, key: string): string | null;
  set(ctx: SessionContext, key: string, plaintext: string): void;
  delete(ctx: SessionContext, key: string): boolean;
  list(ctx: SessionContext): Array<{ key: string; updated_at: string }>;
  loadUserVaultForRun(ctx: SessionContext, keys: string[]): Record<string, string>;
  loadCreatorOverrideForRun(app_id: string, workspace_id: string, keys: string[]): Record<string, string>;
}
```

### Invariants

- **Plaintext is never returned by `list()`** — only key names + timestamps. `get()` is the only unmasking path.
- `loadForRun` methods MUST filter to the caller's `keys` list, never return extras. Callers pass `manifest.secrets_needed` verbatim so unrelated creds never leak into apps that don't need them.
- **Deletion is idempotent** — deleting a missing key returns false, not an error.
- **Creator-override keys MUST NOT fall back to the user vault.** Precedence is control-plane's concern, but the adapter keeps the two namespaces distinct.

### How to write one

Adapters are free to use HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, Bitwarden, or env vars on a single-user box. Floom never reads the plaintext outside the moment of injection — that's what lets the store be fully opaque.

Cloud-KMS adapters use envelope encryption: generate a random per-secret
256-bit DEK locally, AES-GCM-encrypt the plaintext locally with that DEK,
ask the cloud KMS to wrap only the DEK, then persist ciphertext + nonce +
auth tag + wrapped DEK in the backing store. KMS never receives the secret
plaintext; deleting the row deletes the only copy of the wrapped per-secret
DEK.

---

## ObservabilityAdapter

**Purpose.** Captures errors and emits counter / timing / gauge metrics. Optional — a Floom server with neither wired up still runs; callers get a default no-op adapter.

The reference impl is split: `apps/server/src/lib/sentry.ts` for error capture (no-op when `SENTRY_SERVER_DSN` is unset), and `apps/server/src/lib/metrics-counters.ts` for in-process counters surfaced at `GET /api/metrics` as Prometheus text.

### Signature

```ts
interface ObservabilityAdapter {
  captureError(err: unknown, context?: Record<string, unknown>): void;
  increment(metric: string, amount?: number, tags?: Record<string, string>): void;
  timing(metric: string, ms: number, tags?: Record<string, string>): void;
  gauge(metric: string, value: number, tags?: Record<string, string>): void;
}
```

### Invariants

- **Never throw.** An observability bug MUST NOT break the request. The reference Sentry impl wraps `captureException` in try/catch; adapters MUST do the same.
- **Scrub secrets.** `captureError` context MUST NOT leak tokens, passwords, API keys, or cookie values. The reference impl's `scrubSecrets` in `lib/sentry.ts` is a minimal reference.
- **Tags.** Adapters use tag keys verbatim as backend labels (Prom labels, DD tags, OTEL attributes). Callers pick the keys; the adapter does not rename them.

### How to write one

Forward the four methods to your backend of choice. OpenTelemetry is the recommended pattern for production adapters because it keeps Floom vendor-neutral while supporting Datadog, Grafana, Honeycomb, New Relic, Jaeger, and other OTLP-compatible backends. Datadog, StatsD, New Relic, and Honeycomb-specific adapters also fit cleanly. The no-op default is literally four empty function bodies — useful as a fallback when no DSN / endpoint is configured.

---

## Worked example — the default `RuntimeAdapter`

Floom's Docker runtime is implemented in two files:

- `apps/server/src/services/runner.ts` — the dispatch path. `dispatchRun(app, manifest, runId, action, inputs, perCallSecrets?, ctx?)` resolves secret precedence (global → per-app → user vault / creator override → per-call `_auth`), writes the initial `runs` row, and invokes `adapters.runtime.execute`.
- `apps/server/src/services/docker.ts` — the container spawn. `runAppContainer({ appId, runId, action, inputs, secrets, image, onOutput })` builds a Dockerfile (Python or Node) if the image isn't cached, spawns the container with the provided secrets as env, streams stdout + stderr to `onOutput`, enforces `RUNNER_TIMEOUT`, and returns `{ stdout, stderr, exitCode, timedOut, oomKilled, durationMs }`.

The default runtime adapter parses the container's stdout for the `__FLOOM_RESULT__` marker (see `parseEntrypointOutput`), classifies the result into the `ErrorType` taxonomy, and returns a normalized `RuntimeResult`. The runner writes that result via `updateRun`. An alternate runtime adapter can replace `runAppContainer` with its own spawn path and return the same normalized shape.

---

## Source references

- Interface declarations: [`packages/adapter-types/src/index.ts`](../packages/adapter-types/src/index.ts)
- Runtime: [`apps/server/src/services/runner.ts`](../apps/server/src/services/runner.ts), [`services/docker.ts`](../apps/server/src/services/docker.ts), [`services/proxied-runner.ts`](../apps/server/src/services/proxied-runner.ts)
- Storage: [`apps/server/src/db.ts`](../apps/server/src/db.ts), [`services/jobs.ts`](../apps/server/src/services/jobs.ts)
- Auth: [`apps/server/src/lib/better-auth.ts`](../apps/server/src/lib/better-auth.ts), [`lib/auth.ts`](../apps/server/src/lib/auth.ts), [`routes/workspaces.ts`](../apps/server/src/routes/workspaces.ts)
- Secrets: [`apps/server/src/services/user_secrets.ts`](../apps/server/src/services/user_secrets.ts), [`services/app_creator_secrets.ts`](../apps/server/src/services/app_creator_secrets.ts)
- Observability: [`apps/server/src/lib/sentry.ts`](../apps/server/src/lib/sentry.ts), [`lib/metrics-counters.ts`](../apps/server/src/lib/metrics-counters.ts)

---

## Conformance tests

A Floom adapter is conformant iff a fresh server instance with that adapter selected passes the assertion suite for its concern. The reference server ships factory wiring coverage (`test/stress/test-adapters-factory.mjs`) plus per-adapter contract suites at `test/stress/test-adapters-<concern>-contract.mjs`. The conformance runner selects the target implementation via `FLOOM_<CONCERN>=<name-or-module>` and executes the matching suite.

Language below follows RFC 2119: **MUST**, **SHOULD**, **MAY**.

### RuntimeAdapter

A conformant `RuntimeAdapter` MUST pass:

- **success path**: given a no-op action that writes `__FLOOM_RESULT__ {"ok":true}` to stdout, `execute` resolves with `status: 'success'`, `outputs: { ok: true }`, `duration_ms >= 0`, no `error`, no `error_type`.
- **timeout enforcement**: given `runContext.timeoutMs = 500` and an action that sleeps for 5s, `execute` resolves within 2s with `status: 'timeout'`, `error_type: 'timeout'`. The adapter MUST NOT leave an orphan process or container.
- **error classification**: given an action that exits non-zero with a recognizable upstream error, the returned `error_type` is one of the 10 `ErrorType` enum values; an unclassified failure MUST map to `error_type: 'unknown_error'`, not omitted.
- **secret non-leakage**: given `secrets: { API_KEY: 'sk-abc123' }` and an action that echoes its environment to stdout, the returned `logs` and `outputs` MUST NOT contain the string `sk-abc123`. (The adapter is allowed to redact; it is not allowed to pass through.)
- **concurrent isolation**: two parallel `execute` calls for the same app with different inputs MUST each return their own `outputs` with no cross-contamination.
- **stream callback ordering**: if `onOutput` is provided, chunks are delivered in the order the underlying process produced them; stderr and stdout are distinguishable via the `stream` argument.

A conformant impl SHOULD also honor `app.memory_mb` as a hard cap; violation SHOULD return `error_type: 'oom_killed'`. This is SHOULD-level because not every substrate exposes OOM signals (e.g., serverless runtimes).

An impl MAY skip the OOM test if it documents that memory limits are enforced out-of-band.

Reference suite: `test/stress/test-adapters-runtime-contract.mjs`.

### StorageAdapter

A conformant `StorageAdapter` MUST pass:

- **round-trip CRUD** on each of the six core entities (apps, runs, jobs, workspaces, users, admin secrets): create, read back by primary key, list (with and without filter), update, delete. Assert that read-after-write returns structurally equal data.
- **slug collision semantics**: `createApp` with an already-taken slug MUST either throw a deterministic error (`SlugCollision` or semantically equivalent) or upsert. The suite asserts one of the two, not both; the adapter declares which via a compile-time flag. Silent overwrite of an unrelated app is forbidden.
- **missing-row lookup**: `getApp('does-not-exist')`, `getRun('nope')`, `getUser('nope')` MUST return `undefined` (not throw, not null-typed-as-unknown). Callers branch on `undefined`.
- **updated_at refresh**: after `updateApp(slug, { manifest: '...' })`, the returned record's `updated_at` is strictly greater than its `updated_at` before the update. `created_at` MUST NOT change.
- **FK cascade on delete**: after `deleteApp(slug)`, all `runs`, `jobs`, and admin secrets scoped to that app are gone; subsequent listRuns for that app returns `[]`.
- **atomic job claim**: given one queued job and two parallel `claimNextJob` calls, exactly one returns the `JobRecord`; the other returns `undefined`. Run this assertion 50 times to catch races.
- **tenant scoping**: records created under `workspace_id = 'A'` MUST NOT appear in listings filtered by `workspace_id = 'B'`, even if the caller omits the filter (the adapter decides whether the default is tenant-scoped or throws; "all-tenants leak" is non-conformant).
- **transactional read-after-write**: `createRun` followed immediately by `getRun(id)` on another process/connection returns the row. In-flight buffering that lets another reader see a partial row is forbidden.
- **idempotent delete**: deleting a non-existent row returns `false` (StorageAdapter) or equivalent, never throws.

Reference suite: `test/stress/test-adapters-storage-contract.mjs`. Related coverage lives in `test/stress/test-adapters-factory.mjs` (factory wiring) and `test/stress/test-adapters-seed-launchdemos.mjs` (end-to-end sanity through `adapters.storage`).

### AuthAdapter

A conformant `AuthAdapter` MUST pass:

- **null on unauthenticated**: `getSession(new Request(url))` with no cookie / no Authorization header returns `null`. In OSS-single-user mode the adapter MAY return the synthetic local context instead; the suite detects mode via an env flag and skips this assertion under `FLOOM_DEPLOYMENT_MODE=oss`.
- **sign-in then resolve**: password adapters return a session + cookie/token from `signIn({ email, password })`; magic-link adapters return a sent-status and complete through `verifyMagicLink(token)`. In both modes, a follow-up request carrying the emitted cookie/token to `getSession` returns a `SessionContext` with the same `user_id`.
- **sign-up creates a user**: `signUp({ email, password })` creates a row reachable via `storage.getUserByEmail(email)`.
- **sign-out invalidates**: after `signOut(session)`, a request carrying the old cookie/token resolves to `null` via `getSession`.
- **`onUserDelete` fires after deletion**: registered callbacks are invoked after the account row is gone, not before. The suite asserts ordering by attempting `storage.getUser(user_id)` inside the callback and expecting `undefined`.
- **session shape invariants**: every non-null `SessionContext` has `user_id`, `workspace_id`, and (optionally) `email` as strings; `workspace_id` is always populated.

A conformant impl SHOULD support concurrent `getSession` calls without cross-request state leakage. It MAY expose richer features (MFA, passkeys, API key management) as adapter-internal details not visible to Floom.

Reference test skeleton: `test/stress/test-adapters-auth-contract.mjs` (ships on `protocol-v0.2`; today it is executable-as-spec — 4 assertions fail-expected until the Better Auth migration lands, 1 passes). Related coverage: `test/stress/test-auth-401-hints.mjs`, `test-auth-dynamic-baseurl.mjs`.

### SecretsAdapter

A conformant `SecretsAdapter` MUST pass:

- **set / get / delete round-trip**: `set(ctx, 'KEY', 'value')` then `get(ctx, 'KEY')` returns `'value'`; after `delete(ctx, 'KEY')`, `get` returns `null`.
- **`list` masks plaintext**: the returned array contains `key` and `updated_at` only; no `value`, no truncated preview of the plaintext, no ciphertext blob.
- **`loadUserVaultForRun` filters by keys list**: given a vault with `KEY_A, KEY_B, KEY_C` and `keys = ['KEY_A']`, the returned record MUST contain `KEY_A` only. Extra keys MUST NOT leak.
- **creator-override isolation**: keys written via creator-override (per-app) MUST NOT be returned by `loadUserVaultForRun`, and vice versa. The two namespaces are disjoint from the adapter's perspective.
- **tenant isolation**: secrets set with `ctx.workspace_id = 'A'` MUST NOT be readable with `ctx.workspace_id = 'B'`, even if the key name matches.
- **idempotent delete**: `delete(ctx, 'MISSING_KEY')` returns `false`, never throws.
- **ciphertext opacity**: the adapter's backing store (sniffable via `storage.list*` or its native admin surface) MUST NOT contain the plaintext. This is a structural test: the suite writes `plaintext = 'CANARY_SECRET_aaa'` and greps the backing store for that string.

A conformant impl SHOULD use authenticated encryption (AES-GCM, ChaCha20-Poly1305, or a vendor-managed equivalent). Raw AES-CBC without an HMAC is non-conformant.

Reference suite: `test/stress/test-adapters-secrets-contract.mjs`. Related coverage: `test/stress/test-app-creator-secrets.mjs`.

### ObservabilityAdapter

A conformant `ObservabilityAdapter` MUST pass:

- **never throws**: each of the four methods is called with malformed input (`captureError(undefined)`, `increment('', NaN)`, `timing('x', -1)`, `gauge('x', Infinity)`) and returns normally. An impl that throws is non-conformant; an impl that silently drops and logs a warning is conformant.
- **secret scrubbing on error context**: `captureError(new Error('boom'), { password: 'hunter2', api_key: 'sk-abc' })` MUST NOT forward the literal values `hunter2` or `sk-abc` to the backend. The suite runs the adapter against a local capture stub and asserts the outbound payload is scrubbed.
- **tag pass-through**: `increment('run.started', 1, { app_type: 'docker' })` forwards `app_type=docker` as a tag/label on the metric. Tag keys MUST NOT be renamed by the adapter.
- **no-op fallback**: an adapter configured with no DSN / no endpoint MUST still satisfy the "never throws" and tag-pass-through contracts. A silent no-op is acceptable; a crash-on-missing-config is non-conformant.

A conformant impl MAY batch, buffer, or sample internally. The suite does not assert delivery guarantees; it asserts the interface contract.

Reference suite: `test/stress/test-adapters-observability-contract.mjs`.

### Running the suite

Run the factory wiring smoke test:

```bash
npx tsx test/stress/test-adapters-factory.mjs
```

Run a concern-specific contract suite against any registered in-tree value, package specifier, or local module path:

```bash
pnpm test:conformance --concern storage --adapter sqlite
pnpm test:conformance --concern runtime --adapter ./my-runtime-adapter.mjs
pnpm test:conformance --concern auth --adapter @floom-community/auth-example
```

The runner returns non-zero when the suite reports any failing assertion. Direct suite execution (`npx tsx test/stress/test-adapters-storage-contract.mjs`) prints the same assertions against the default implementation.

---

## Third-party adapters

Out-of-tree adapters load through the same env vars used for in-tree adapter selection (see `apps/server/src/adapters/factory.ts`). Built-in names still resolve through the static registry; package and path specifiers resolve through dynamic `import()` at server boot.

### Discovery

The discovery pattern is **npm-module-path resolution via the same five env vars used for in-tree selection**:

- `FLOOM_RUNTIME`, `FLOOM_STORAGE`, `FLOOM_AUTH`, `FLOOM_SECRETS`, `FLOOM_OBSERVABILITY`.

Values starting with `@` or containing `/` are treated as npm module specifiers and resolved via dynamic `import()` at server boot. Values without those markers keep the current static-registry lookup. Examples:

- `FLOOM_STORAGE=sqlite`: in-tree.
- `FLOOM_STORAGE=@floom-community/storage-postgres`: third-party npm package.
- `FLOOM_STORAGE=./local-adapters/my-storage.js`: relative path to a local file (useful for private/internal adapters that never hit npm).

The recommended community naming convention is `@floom-community/<concern>-<backend>`, e.g., `@floom-community/storage-postgres`, `@floom-community/runtime-k8s`, `@floom-community/secrets-vault`.

### Registration pattern

A third-party adapter module MUST default-export an object matching the registration shape:

```ts
export default {
  kind: 'storage', // one of: 'runtime' | 'storage' | 'auth' | 'secrets' | 'observability'
  name: 'postgres', // short identifier, informational (used in logs)
  protocolVersion: '^0.2', // semver range of FLOOM_PROTOCOL_VERSION this adapter supports
  adapter: postgresStorageAdapter, // the instance conforming to the corresponding type
};
```

Adapters that need the already-selected storage adapter can export `create`
instead of `adapter`:

```ts
export default {
  kind: 'secrets' as const,
  name: 'gcp-kms',
  protocolVersion: '^0.2',
  create: ({ storage }) => createGcpKmsSecretsAdapter({ keyName, storage }),
};
```

At boot, the factory:

1. Reads `FLOOM_<CONCERN>`.
2. If the value is a module specifier, calls `await import(value)` and reads `.default`.
3. Validates `kind` matches the expected concern, rejects with a descriptive error otherwise.
4. Validates `protocolVersion` is compatible with the server's `FLOOM_PROTOCOL_VERSION` constant (see below); rejects with a version-mismatch error otherwise.
5. Registers `adapter` in the bundle.

Validation failures MUST halt server boot. A Floom server MUST NOT start with a partially-loaded adapter bundle.

### Version compatibility

The server exposes `FLOOM_PROTOCOL_VERSION` as a compile-time constant (semver, e.g., `0.2.0`). A third-party adapter declares the range it supports via `protocolVersion` in its default export. The factory refuses to load an adapter whose declared range does not include the server's version.

Semver expectation:

- Pre-1.0: minor-version bumps (`0.2.x` to `0.3.x`) MAY be breaking. Adapters SHOULD declare a narrow range like `^0.2` that pins to a single minor.
- Post-1.0: standard semver applies. `^1.x` ranges are safe across patch and minor bumps.

The protocol version is bumped in the `floomhq/floom` repo under `apps/server/src/adapters/version.ts`.

### Security

Third-party adapters run **in-process with full server privileges**. There is no sandbox between an adapter and the rest of the server:

- An adapter can read any env var, including `FLOOM_MASTER_KEY`.
- An adapter can make outbound network calls, read/write the filesystem, spawn processes.
- A malicious `StorageAdapter` can log every run's inputs to a remote server. A malicious `SecretsAdapter` can exfiltrate plaintext.

Operators MUST treat third-party adapter packages as supply-chain dependencies equivalent to the server itself:

- Pin exact versions (`@floom-community/storage-postgres@1.2.3`, not `^1`).
- Review the source before upgrading.
- Prefer adapters published under a trusted namespace (e.g., `@floomhq/*` is first-party; `@floom-community/*` is community-audited but not guaranteed).

Floom does not currently run an audit program for community adapters. This is a v1.0 roadmap item; until then, the trust model is "read the code."

### Example

A minimal third-party `StorageAdapter` package looks like this:

```ts
// @floom-community/storage-postgres/src/index.ts
import type { StorageAdapter } from '@floom/adapter-types';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const postgresStorageAdapter: StorageAdapter = {
  getApp(slug) {
    // SELECT ... FROM apps WHERE slug = $1
    // return row or undefined
  },
  // ... rest of the StorageAdapter methods
};

export default {
  kind: 'storage' as const,
  name: 'postgres',
  protocolVersion: '^0.2',
  adapter: postgresStorageAdapter,
};
```

The `@floom/adapter-types` package referenced above is the standalone type surface for third-party adapters. Its package version matches `FLOOM_PROTOCOL_VERSION` so adapter authors can pin protocol compatibility without depending on the full `floomhq/floom` repo.
