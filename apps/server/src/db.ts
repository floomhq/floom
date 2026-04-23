import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || './data';
export const APPS_DIR = join(DATA_DIR, 'apps');
const DB_PATH = join(DATA_DIR, 'floom-chat.db');

mkdirSync(APPS_DIR, { recursive: true });
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Perf launch-blocker fix (2026-04-20): without busy_timeout, concurrent
// writers against the same SQLite DB (runs, run_turns, jobs, connections,
// app_memory) surface `SQLITE_BUSY` errors to the caller when two
// transactions collide. Setting a 5s busy timeout lets the engine block
// and retry internally, which is what every production SQLite deployment
// does. WAL + busy_timeout is the canonical high-concurrency pairing.
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

/**
 * Synthetic defaults used in OSS solo mode and as the migration target for
 * pre-existing rows. Every tenant-scoped query must include
 * `workspace_id = ?`; these constants keep the solo-mode codepath the same
 * as the multi-tenant codepath (P.4 research, section 4).
 */
export const DEFAULT_WORKSPACE_ID = 'local';
export const DEFAULT_USER_ID = 'local';

// ---------- apps (a flat, slug-addressed set of runnable apps) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    manifest TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    docker_image TEXT,
    code_path TEXT NOT NULL,
    category TEXT,
    author TEXT,
    icon TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_apps_slug ON apps(slug);
  CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category);
`);

// Migrations: add proxied-app columns if they don't exist yet (idempotent).
const appCols = (db.prepare(`PRAGMA table_info(apps)`).all() as { name: string }[]).map(
  (r) => r.name,
);
if (!appCols.includes('app_type')) {
  db.exec(`ALTER TABLE apps ADD COLUMN app_type TEXT NOT NULL DEFAULT 'docker'`);
}
if (!appCols.includes('base_url')) {
  db.exec(`ALTER TABLE apps ADD COLUMN base_url TEXT`);
}
if (!appCols.includes('auth_type')) {
  db.exec(`ALTER TABLE apps ADD COLUMN auth_type TEXT`);
}
if (!appCols.includes('openapi_spec_url')) {
  db.exec(`ALTER TABLE apps ADD COLUMN openapi_spec_url TEXT`);
}
if (!appCols.includes('openapi_spec_cached')) {
  db.exec(`ALTER TABLE apps ADD COLUMN openapi_spec_cached TEXT`);
}
// auth_config carries auth-type-specific config as a JSON blob
// (apikey_header, oauth2_token_url, oauth2_scopes, etc.). Nullable.
if (!appCols.includes('auth_config')) {
  db.exec(`ALTER TABLE apps ADD COLUMN auth_config TEXT`);
}
// Per-app visibility: 'public' (default) or 'auth-required'.
if (!appCols.includes('visibility')) {
  db.exec(`ALTER TABLE apps ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
}
// Async job queue fields (v0.3.0) — nullable for backward compatibility.
// When `is_async` is 1, calls go through the job queue (POST /api/:slug/jobs)
// and MCP tools/call returns immediately with a job-started message.
if (!appCols.includes('is_async')) {
  db.exec(`ALTER TABLE apps ADD COLUMN is_async INTEGER NOT NULL DEFAULT 0`);
}
// Creator-declared webhook URL. When a job finishes, Floom POSTs the result here.
if (!appCols.includes('webhook_url')) {
  db.exec(`ALTER TABLE apps ADD COLUMN webhook_url TEXT`);
}
// Per-app max job runtime in ms. Default 30 minutes when NULL.
if (!appCols.includes('timeout_ms')) {
  db.exec(`ALTER TABLE apps ADD COLUMN timeout_ms INTEGER`);
}
// Per-app retry count on job failure. Default 0 when NULL.
if (!appCols.includes('retries')) {
  db.exec(`ALTER TABLE apps ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`);
}
// Client contract for async apps: 'poll' (default), 'webhook', or 'stream'.
// Stored for the manifest advertisement; runtime behavior is the same today.
if (!appCols.includes('async_mode')) {
  db.exec(`ALTER TABLE apps ADD COLUMN async_mode TEXT`);
}
// Store-sort fields (fast-apps wave):
//   featured: 1 for apps pinned to the top of /api/hub. Defaults to 0.
//   avg_run_ms: observed mean run duration in milliseconds, refreshed
//   by services/runner.ts after every successful run. NULL until we have
//   at least one sample.
if (!appCols.includes('featured')) {
  db.exec(`ALTER TABLE apps ADD COLUMN featured INTEGER NOT NULL DEFAULT 0`);
}
if (!appCols.includes('avg_run_ms')) {
  db.exec(`ALTER TABLE apps ADD COLUMN avg_run_ms INTEGER`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_apps_featured_avg ON apps(featured, avg_run_ms)`);

// Manual publish-review gate (#362, 2026-04-22). `publish_status` is an
// axis independent of `visibility`:
//   - 'draft'           — not yet submitted for review (reserved; unused in v0).
//   - 'pending_review'  — default for every newly-created app. Not visible on
//                         the public Store until an admin flips it.
//   - 'published'       — admin-approved, visible on the public Store (for
//                         apps whose visibility is also 'public').
//   - 'rejected'        — admin declined. Hidden from the Store like pending.
//
// ONE-SHOT backfill: when adding this column the first time, flip every
// pre-existing row to 'published' so currently-live apps (lead-scorer, all
// utilities, etc.) stay visible post-migration. `visibility='private'` apps
// (e.g. ig-nano-scout) are unaffected by the Store filter regardless of
// publish_status because they're owner-only anyway — but we backfill them
// to 'published' too so they keep behaving identically to before the gate
// landed. New inserts after this migration get 'pending_review' from the
// INSERT statements in seed.ts/openapi-ingest.ts/docker-image-ingest.ts —
// fresh ingests from Codex or creators must be manually approved.
if (!appCols.includes('publish_status')) {
  db.exec(
    `ALTER TABLE apps ADD COLUMN publish_status TEXT NOT NULL DEFAULT 'pending_review'`,
  );
  db.exec(`UPDATE apps SET publish_status = 'published'`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_apps_publish_status ON apps(publish_status)`);

// Store-catalog wireframe parity (2026-04-23). v17 `store.html` shows
// each card with a 120px thumbnail, a star count, a runs-7d count, and
// an optional HERO accent tag. Three of these are net-new columns —
// `runs_7d` is derived at read time from the runs table, not stored,
// so no column for it. All three new columns are nullable/zero-default
// so older rows (and test fixtures) stay valid.
//
// - thumbnail_url: relative or absolute URL to a 640x360 PNG. Null =
//   render the gradient fallback tile (AppIcon on a category tint) so
//   launch doesn't block on manual screenshot authoring. Option 2 of
//   the brief; Option 1 (headless-screenshot at seed time) is a
//   follow-up when we have creator-UI for thumbnail uploads.
// - stars: non-negative integer. Seeded 0 for every app; admins / a
//   future reviews aggregation will backfill. Hot-star threshold
//   (>=100, per wireframe) is a pure render-time decision — no
//   separate column.
// - hero: boolean flag (0/1). Distinct from `featured`: `featured`
//   controls sort (pinned first), `hero` controls the accent "HERO"
//   tag on the card chrome. The wireframe has lead-scorer flagged as
//   HERO but all three AI demos can wear the tag; we set it at seed
//   time below in services/launch-demos.ts.
if (!appCols.includes('thumbnail_url')) {
  db.exec(`ALTER TABLE apps ADD COLUMN thumbnail_url TEXT`);
}
if (!appCols.includes('stars')) {
  db.exec(`ALTER TABLE apps ADD COLUMN stars INTEGER NOT NULL DEFAULT 0`);
}
if (!appCols.includes('hero')) {
  db.exec(`ALTER TABLE apps ADD COLUMN hero INTEGER NOT NULL DEFAULT 0`);
}

// ---------- runs (one per app invocation, optionally bound to a chat turn) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    thread_id TEXT,
    action TEXT NOT NULL,
    inputs TEXT,
    outputs TEXT,
    logs TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    error_type TEXT,
    duration_ms INTEGER,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
  CREATE INDEX IF NOT EXISTS idx_runs_app ON runs(app_id);
`);

// Error taxonomy (2026-04-20): add upstream_status so the client can
// classify user_input_error (4xx non-auth) vs auth_error (401/403) vs
// upstream_outage (5xx) vs network_unreachable (no status) without
// re-parsing the raw error string. Idempotent.
//
// NB: the later "// runs: workspace_id + user_id + device_id" block
// reads PRAGMA table_info(runs) under the name `runCols` too; we use a
// distinct local to keep both migrations block-scoped and ordered.
const runErrCols = (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
  (r) => r.name,
);
if (!runErrCols.includes('upstream_status')) {
  db.exec(`ALTER TABLE runs ADD COLUMN upstream_status INTEGER`);
}

// ---------- jobs (async job queue for long-running apps, v0.3.0) ----------
// A job wraps a `dispatchRun` invocation with queue + timeout + retry + webhook
// semantics. Jobs are claimed by the background worker and run to completion
// in the same process. The client either polls `GET /api/:slug/jobs/:id` or
// waits for a webhook POST to the creator-declared URL.
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    input_json TEXT,
    output_json TEXT,
    error_json TEXT,
    run_id TEXT,
    webhook_url TEXT,
    timeout_ms INTEGER NOT NULL DEFAULT 1800000,
    max_retries INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    per_call_secrets_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_slug_status ON jobs(slug, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`);

// ---------- secrets (global or per-app) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    app_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_secrets_unique
    ON secrets(name, COALESCE(app_id, '__global__'));
`);

// ---------- run threads + turns ----------
// Threads are keyed by a browser-generated id. Originally named
// `chat_threads`/`chat_turns` when the MVP was chat-shaped; v0.4.0 cleanup
// renames them to `run_threads`/`run_turns` to match the product framing
// (a thread is a sequence of app runs, not a chat).
//
// Migration for pre-cleanup DBs: if the legacy tables exist and the new
// ones don't, RENAME in place. Idempotent and data-preserving.
const legacyTableRows = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chat_threads','chat_turns','run_threads','run_turns')`)
  .all() as { name: string }[];
const legacyTables = new Set(legacyTableRows.map((r) => r.name));
if (legacyTables.has('chat_threads') && !legacyTables.has('run_threads')) {
  db.exec(`ALTER TABLE chat_threads RENAME TO run_threads`);
}
if (legacyTables.has('chat_turns') && !legacyTables.has('run_turns')) {
  db.exec(`ALTER TABLE chat_turns RENAME TO run_turns`);
}
// Drop the old index name if the RENAME left it attached under the stale
// label so the CREATE INDEX below lands on the new name.
db.exec(`DROP INDEX IF EXISTS idx_turns_thread`);

db.exec(`
  CREATE TABLE IF NOT EXISTS run_threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS run_turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES run_threads(id) ON DELETE CASCADE,
    turn_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_run_turns_thread ON run_turns(thread_id, turn_index);
`);

// ---------- embeddings (for the app picker) ----------
// vector is a raw BLOB of packed float32 values (1536 dims = 6144 bytes).
db.exec(`
  CREATE TABLE IF NOT EXISTS embeddings (
    app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    vector BLOB NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// =====================================================================
// ---------- W2.1: multi-tenant schema foundation ----------
// =====================================================================
// P.4 research delivered the full design. We ship the schema in v0.3.1
// with synthetic `workspace_id='local'` + `user_id='local'` defaults so
// OSS solo mode is a special case of multi-tenant (one codepath, no
// feature flag). Cloud (W3.1) adds real workspaces + real user_ids on top
// of the exact same schema.
// ---------------------------------------------------------------------

// ---------- workspaces (tenant container) ----------
// `wrapped_dek` is the per-workspace 32-byte data encryption key wrapped
// with the server-wide master KEK from FLOOM_MASTER_KEY env. Stored as a
// hex string ("nonce:ciphertext:authTag") to stay sqlite-portable and so
// the secrets service can rewrap without BLOB handling.
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'oss',
    wrapped_dek TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
`);

// ---------- users (global identity, shared across workspaces) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT,
    name TEXT,
    auth_provider TEXT NOT NULL DEFAULT 'local',
    auth_subject TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_workspace ON users(workspace_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth
    ON users(auth_provider, auth_subject)
    WHERE auth_subject IS NOT NULL;
`);

// Migration: add profile image to users if missing.
const userCols2 = (db.prepare(`PRAGMA table_info(users)`).all() as {
  name: string;
}[]).map((r) => r.name);
if (!userCols2.includes('image')) {
  db.exec(`ALTER TABLE users ADD COLUMN image TEXT`);
}

// ---------- workspace_members (user <-> workspace <-> role) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin',
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_id, user_id)
  );
`);

// ---------- app_memory: per-(workspace, app, user) JSON blob store ----------
// Creator declares `memory_keys: [...]` in their manifest. Floom gates
// get/set to declared keys only. Values are stored as JSON strings.
// device_id is nullable; it's populated for anonymous sessions so the
// rekey transaction can find the rows when a user logs in.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_memory (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    app_slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    device_id TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_id, app_slug, user_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_app_memory_device
    ON app_memory(device_id)
    WHERE device_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_app_memory_user
    ON app_memory(workspace_id, user_id);
`);

// ---------- user_secrets: AES-256-GCM envelope-encrypted per-user vault ----------
// ciphertext/nonce/auth_tag are stored as hex-encoded strings. Decryption
// pulls the wrapped DEK for the workspace, unwraps with FLOOM_MASTER_KEY,
// then AES-GCM-decrypts in memory. Per P.4 section 3.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_secrets (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (workspace_id, user_id, key)
  );
`);

// ---------- alter existing tables to add multi-tenant columns ----------
// Idempotent column-add migrations (same pattern as app_type + is_async
// above). Every alter uses DEFAULT 'local' so pre-existing v0.2/v0.3 rows
// are automatically scoped to the synthetic default workspace and user
// on first boot after upgrade.

// apps: workspace_id + memory_keys (JSON array of allowed keys)
if (!appCols.includes('workspace_id')) {
  db.exec(`ALTER TABLE apps ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local'`);
}
if (!appCols.includes('memory_keys')) {
  db.exec(`ALTER TABLE apps ADD COLUMN memory_keys TEXT`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_apps_workspace ON apps(workspace_id)`);

// runs: workspace_id + user_id + device_id
const runCols = (db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]).map(
  (r) => r.name,
);
if (!runCols.includes('workspace_id')) {
  db.exec(`ALTER TABLE runs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local'`);
}
if (!runCols.includes('user_id')) {
  db.exec(`ALTER TABLE runs ADD COLUMN user_id TEXT`);
}
if (!runCols.includes('device_id')) {
  db.exec(`ALTER TABLE runs ADD COLUMN device_id TEXT`);
}
// Security (P0 2026-04-20, run-auth lockdown): runs default to owner-only
// reads. When a creator explicitly hits POST /api/run/:id/share, we flip
// this to 1 so anonymous callers can view the run's outputs (inputs and
// logs stay owner-only even when shared — inputs can hold user secrets
// that a "share this output" intent never meant to expose). Default 0 =
// private. Idempotent migration; existing rows come back as 0 and stay
// unreachable from anon until the owner opts in.
if (!runCols.includes('is_public')) {
  db.exec(`ALTER TABLE runs ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_runs_workspace_user ON runs(workspace_id, user_id)`,
);
db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_device ON runs(device_id) WHERE device_id IS NOT NULL`);

// run_threads: workspace_id + user_id + device_id
const threadCols = (db
  .prepare(`PRAGMA table_info(run_threads)`)
  .all() as { name: string }[]).map((r) => r.name);
if (!threadCols.includes('workspace_id')) {
  db.exec(`ALTER TABLE run_threads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local'`);
}
if (!threadCols.includes('user_id')) {
  db.exec(`ALTER TABLE run_threads ADD COLUMN user_id TEXT`);
}
if (!threadCols.includes('device_id')) {
  db.exec(`ALTER TABLE run_threads ADD COLUMN device_id TEXT`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_threads_workspace_user ON run_threads(workspace_id, user_id)`,
);
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_threads_device ON run_threads(device_id) WHERE device_id IS NOT NULL`,
);

// ---------- bootstrap: ensure the synthetic 'local' workspace exists ----------
// Idempotent. Runs on every boot so the row is always present even after
// a DB restore. The wrapped_dek column is left NULL here — user_secrets
// lazily generates and persists the DEK the first time a secret is set
// for this workspace, because doing it at boot would require reading
// FLOOM_MASTER_KEY before the env is fully loaded in tests.
const existingLocal = db
  .prepare(`SELECT id FROM workspaces WHERE id = ?`)
  .get(DEFAULT_WORKSPACE_ID) as { id: string } | undefined;
if (!existingLocal) {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'oss')`,
  ).run(DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, 'Local');
}
const existingLocalUser = db
  .prepare(`SELECT id FROM users WHERE id = ?`)
  .get(DEFAULT_USER_ID) as { id: string } | undefined;
if (!existingLocalUser) {
  // Intentionally empty name (not 'Local User'): the web greeting derives
  // from user.name → email local-part → 'there'. Storing a literal name here
  // caused MePage to render "Hey Local User" for signed-out/OSS sessions,
  // which leaked the implementation detail. Leaving name empty keeps the
  // greeting neutral ("Hey there") across all modes.
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, name, auth_provider)
     VALUES (?, ?, NULL, '', 'local')`,
  ).run(DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID);
} else {
  // Backfill for DBs seeded before 2026-04-20: strip the legacy 'Local User'
  // name so existing deployments stop showing "Hey Local User" too.
  db.prepare(
    `UPDATE users SET name = '' WHERE id = ? AND name = 'Local User'`,
  ).run(DEFAULT_USER_ID);
}
const existingLocalMember = db
  .prepare(
    `SELECT 1 as n FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
  )
  .get(DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID) as { n: number } | undefined;
if (!existingLocalMember) {
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES (?, ?, 'admin')`,
  ).run(DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID);
}

// =====================================================================
// ---------- W2.3: Composio connections (OAuth via Composio SDK) -------
// =====================================================================
// P.2 research (research/composio-validation.md) validated Composio as
// the primary vendor for the /build "Connect a tool" ramp. Because this
// wave ships before W3.1 Better Auth, we use the same `device_id`
// fallback pattern W2.1 established for app_memory/runs/run_threads:
//
//   - owner_kind='device' + owner_id=<floom_device cookie>  (pre-login)
//   - owner_kind='user'   + owner_id=<users.id>             (post-login)
//
// On the first authenticated request, `rekeyDevice` (below) rewrites
// the rows from device→user in the same transaction that re-keys the
// other tables. Composio's own user_id (the opaque string we pass to
// `composio.connectedAccounts.initiate`) is stored in
// `connections.composio_account_id` and never rewritten; after re-key
// we simply map the local user to the old Composio account via
// `users.composio_user_id`.

// ---------- connections (per-user OAuth state for Composio) ------------
db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('device', 'user')),
    owner_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    composio_connection_id TEXT NOT NULL,
    composio_account_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (workspace_id, owner_kind, owner_id, provider)
  );
  CREATE INDEX IF NOT EXISTS idx_connections_owner
    ON connections(workspace_id, owner_kind, owner_id);
  CREATE INDEX IF NOT EXISTS idx_connections_provider
    ON connections(workspace_id, provider);
  CREATE INDEX IF NOT EXISTS idx_connections_composio
    ON connections(composio_connection_id);
`);

// users.composio_user_id: populated on first login when we map the
// pre-auth `device:<uuid>` Composio user id to the authenticated user.
// Nullable — only set once the user has connected at least one tool.
const userCols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map(
  (r) => r.name,
);
if (!userCols.includes('composio_user_id')) {
  db.exec(`ALTER TABLE users ADD COLUMN composio_user_id TEXT`);
}

// =====================================================================
// ---------- W3.3: Stripe Connect partner app schema -------------------
// =====================================================================
// P.3 research (research/stripe-connect-validation.md) locked the design:
// Express accounts default, direct charges only, application_fee_amount
// = floor(amount * 0.05), Stripe Tax Basic per-merchant. Floom never
// becomes the merchant of record. Each creator (workspace+user) onboards
// to their own Stripe Express connected account; payments hit their
// account directly and a 5% application fee is auto-transferred to the
// Floom platform account.
//
// Two tables:
//
//   stripe_accounts:           one row per (workspace, user) creator.
//                              Persists the Stripe account id + capability
//                              flags so the creator dashboard can render
//                              "ready / pending / rejected" without an
//                              upstream poll on every page load. Updated
//                              by the `account.updated` webhook.
//
//   stripe_webhook_events:     event-id dedupe ledger. The webhook handler
//                              inserts (event_id) on first delivery and
//                              skips on conflict. Stripe retries deliver
//                              the same event id, so this gives us at-most-
//                              once handling without distributed locking.

db.exec(`
  CREATE TABLE IF NOT EXISTS stripe_accounts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    stripe_account_id TEXT NOT NULL UNIQUE,
    account_type TEXT NOT NULL DEFAULT 'express'
      CHECK (account_type IN ('express', 'standard')),
    country TEXT,
    charges_enabled INTEGER NOT NULL DEFAULT 0,
    payouts_enabled INTEGER NOT NULL DEFAULT 0,
    details_submitted INTEGER NOT NULL DEFAULT 0,
    requirements_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (workspace_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_stripe_accounts_workspace
    ON stripe_accounts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_stripe_accounts_user
    ON stripe_accounts(workspace_id, user_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    livemode INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type
    ON stripe_webhook_events(event_type);
`);

// =====================================================================
// ---------- W3.1: workspace invites + active-workspace state ----------
// =====================================================================
// Better Auth (cloud mode) owns the user / session / account / verification
// tables it needs for OAuth + magic link + email+password. Floom keeps its
// own users / workspaces / workspace_members tables (unchanged from W2.1)
// and stays the source of truth for tenant scoping. The two coexist by
// using a separate table prefix (Better Auth's defaults: `user`,
// `session`, `account`, etc., singular; Floom's are plural). On first
// authenticated request the Better Auth user is mirrored into Floom's
// `users` table by `services/session.ts`, then re-keyed.
//
// W3.1 adds two pieces of state on top of W2.1's schema:
//
//   1. `workspace_invites` — pending email invitations to a workspace.
//      Created by POST /api/workspaces/:id/members/invite, accepted by
//      POST /api/workspaces/:id/members/accept-invite with the token.
//   2. `user_active_workspace` — which workspace a given user is "looking
//      at" right now. Switched by POST /api/session/switch-workspace.
//      A user always has exactly zero or one row here.

db.exec(`
  CREATE TABLE IF NOT EXISTS workspace_invites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    invited_by_user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    accepted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_invites_workspace
    ON workspace_invites(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_invites_email
    ON workspace_invites(email);
  CREATE INDEX IF NOT EXISTS idx_invites_token
    ON workspace_invites(token);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_active_workspace (
    user_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// users.email lookup: needed so the invite-accept flow can resolve a
// pending invite to the right user when they sign up. Index on lowercased
// email (we already have `email` on the column from W2.1).
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

// ---------- W4-minimal: app reviews ----------
// Per-user review rows. Unique (workspace_id, app_slug, user_id): each user
// can only leave ONE review per app; re-submitting updates the existing row.
// In OSS mode the user is the synthetic local user; in Cloud mode the real
// Better Auth user. Device-scoped reviews are NOT persisted — anonymous
// visitors cannot leave reviews (enforced in the route handler).
db.exec(`
  CREATE TABLE IF NOT EXISTS app_reviews (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    app_slug TEXT NOT NULL,
    user_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title TEXT,
    body TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (workspace_id, app_slug, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_app_reviews_slug ON app_reviews(app_slug);
  CREATE INDEX IF NOT EXISTS idx_app_reviews_user ON app_reviews(user_id);
`);

// ---------- W4-minimal: product feedback ----------
// Raw feedback entries from the floating feedback button. Accepts from
// anonymous and authenticated callers; stores URL + user_id for context.
// Rate-limited at the route layer.
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    user_id TEXT,
    device_id TEXT,
    email TEXT,
    url TEXT,
    text TEXT NOT NULL,
    ip_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
`);

// ---------- Deploy waitlist (launch 2026-04-27) ----------
// Email capture for the floom.dev production rollout. When DEPLOY_ENABLED
// is false on prod, every "Deploy / Publish" CTA swaps to a waitlist
// affordance that POSTs here. preview.floom.dev keeps DEPLOY_ENABLED=true
// so the real deploy flow is unaffected.
//
// - email: stored as-is (case preserved for display) but uniqueness is
//   enforced on LOWER(email) so "Alice@x.com" and "alice@x.com" dedupe.
// - source: which surface the signup came from (hero, studio-deploy,
//   me-publish, direct, etc.). Free-form TEXT; truncated to 64 chars at
//   insert time to match the spec.
// - user_agent: raw UA header, capped to 512 chars so we don't store
//   megabytes of spoofed nonsense.
// - ip_hash: sha256(ip + WAITLIST_IP_HASH_SECRET) hex. Never store raw
//   IP. Lets the route layer rate-limit per-IP without retaining PII.
//
// Postgres would use citext + gen_random_uuid + timestamptz here; on
// SQLite we hand-roll a UUID at insert time and use the standard TEXT
// datetime('now') pattern used by every other Floom table.
db.exec(`
  CREATE TABLE IF NOT EXISTS waitlist_signups (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    source TEXT,
    user_agent TEXT,
    ip_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email_lower
    ON waitlist_signups(LOWER(email));
  CREATE INDEX IF NOT EXISTS idx_waitlist_created
    ON waitlist_signups(created_at);
`);

// =====================================================================
// ---------- Secrets policy (per-app creator-override vs user-vault) ---
// =====================================================================
// Every key in an app's `manifest.secrets_needed` has a resolution policy
// that decides whose value gets injected at run time:
//
//   'user_vault'        — each running user supplies their own value
//                         via /api/secrets (the existing user_secrets
//                         table). This is the default and preserves the
//                         pre-existing behavior.
//
//   'creator_override'  — the app's creator sets ONE value in
//                         app_creator_secrets; every user's run of this
//                         app sees that value. Used for shared infra
//                         credentials the creator owns (residential
//                         proxy URL, shared Gemini key, etc.) and which
//                         users should not have to configure.
//
// When no row exists in app_secret_policies for a given (app_id, key),
// the policy defaults to 'user_vault' so existing apps keep working
// without any admin action.
//
// app_creator_secrets reuses the W2.1 envelope scheme: values are
// AES-256-GCM encrypted with the creator's workspace DEK, which is
// itself wrapped by the server-wide master KEK. See
// services/user_secrets.ts for the crypto layer; the helpers are
// exported and reused by services/app_creator_secrets.ts.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_secret_policies (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    policy TEXT NOT NULL CHECK (policy IN ('user_vault', 'creator_override')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (app_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_app_secret_policies_app
    ON app_secret_policies(app_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_creator_secrets (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    nonce TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (app_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_app_creator_secrets_app
    ON app_creator_secrets(app_id);
  CREATE INDEX IF NOT EXISTS idx_app_creator_secrets_workspace
    ON app_creator_secrets(workspace_id);
`);

// ---------------------------------------------------------------------
// Idempotent data migrations (audit 2026-04-20, Fix 3)
// ---------------------------------------------------------------------
// `primary_action` is a new optional manifest field. The schema itself
// doesn't change (manifests are JSON blobs inside `apps.manifest`), so
// there's nothing to ALTER. But for a handful of seed apps where the
// intended primary action is known, we stamp it on first boot so the
// /p/:slug runner picks the right tab without requiring a full re-seed.
// Guards: only patch when the manifest has ≥2 actions, the target
// action exists, and the field isn't already set. Safe to run on every
// boot — becomes a no-op once the field is persisted.
const PRIMARY_ACTION_SEEDS: Array<{ slug: string; action: string }> = [
  { slug: 'openslides', action: 'generate' },
];
for (const seed of PRIMARY_ACTION_SEEDS) {
  try {
    const row = db
      .prepare('SELECT id, manifest FROM apps WHERE slug = ?')
      .get(seed.slug) as { id: string; manifest: string } | undefined;
    if (!row) continue;
    let manifest: {
      actions?: Record<string, unknown>;
      primary_action?: string;
    };
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      continue;
    }
    if (!manifest || !manifest.actions) continue;
    const actionKeys = Object.keys(manifest.actions);
    if (actionKeys.length < 2) continue;
    if (!actionKeys.includes(seed.action)) continue;
    if (manifest.primary_action === seed.action) continue;
    manifest.primary_action = seed.action;
    db.prepare(`UPDATE apps SET manifest = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(manifest),
      row.id,
    );
  } catch {
    // Never let a data-migration failure block boot. These are cosmetic
    // tab defaults, not critical schema changes.
  }
}

// =====================================================================
// ---------- Triggers (unified schedule + webhook) ---------------------
// =====================================================================
// A trigger fires an app run from an external event. Two `trigger_type`
// values share one table + one dispatch path:
//
//   'schedule' — scheduler worker polls every 30s; fires if next_run_at<=NOW.
//                Requires cron_expression; optional tz (default 'UTC').
//   'webhook'  — POST /hook/:webhook_url_path is signature-verified with
//                HMAC-SHA256(body, webhook_secret). Headers:
//                X-Floom-Signature: sha256=<hex>
//                Optional X-Request-ID for 24h idempotency.
//
// Both shapes converge on the same job-queue dispatch (v0.3.0) so the
// outgoing webhook delivery + retry + timeout logic is reused.
db.exec(`
  CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    inputs TEXT NOT NULL DEFAULT '{}',
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'webhook')),
    cron_expression TEXT,
    tz TEXT,
    webhook_secret TEXT,
    webhook_url_path TEXT,
    next_run_at INTEGER,
    last_fired_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    retry_policy TEXT,
    created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_triggers_schedule
    ON triggers(trigger_type, enabled, next_run_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_webhook_path
    ON triggers(webhook_url_path)
    WHERE webhook_url_path IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_triggers_app ON triggers(app_id);
  CREATE INDEX IF NOT EXISTS idx_triggers_user ON triggers(user_id);
`);

// Idempotency ledger for incoming webhook POSTs. Insert (trigger_id, request_id)
// on first delivery; reject duplicates within 24h via the composite PK.
// Garbage-collected lazily by the scheduler worker (see triggers-worker.ts).
db.exec(`
  CREATE TABLE IF NOT EXISTS trigger_webhook_deliveries (
    trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (trigger_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS idx_trigger_deliveries_received
    ON trigger_webhook_deliveries(received_at);
`);

// Bump user_version so operators can see at a glance which schema
// revision their DB is on. v0.3.0 was at user_version=3; W2.1 lands v4;
// W2.3 lands v5; W3.3 + W3.1 land v6 (rolled into the same alpha series).
// W4-minimal lands v7 with app_reviews + feedback tables.
// Fast-apps wave lands v8 with apps.featured + apps.avg_run_ms columns.
// v0.4.0 cleanup sprint lands v9: chat_threads → run_threads, chat_turns → run_turns.
// secrets-policy lands v10: app_secret_policies + app_creator_secrets.
// triggers (unified schedule + webhook) lands v11.
// Manual publish-review gate (#362) lands v12: apps.publish_status.
// Deploy waitlist (launch 2026-04-27) lands v13: waitlist_signups.
const currentUserVersion = (db.prepare(`PRAGMA user_version`).get() as { user_version: number })
  .user_version;
if (currentUserVersion < 13) {
  db.pragma('user_version = 13');
}
