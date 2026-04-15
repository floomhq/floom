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

// ---------- chat threads + turns ----------
// v1 stores threads keyed by a browser-generated id. No user auth.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_turns (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    turn_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_turns_thread ON chat_turns(thread_id, turn_index);
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
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_runs_workspace_user ON runs(workspace_id, user_id)`,
);
db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_device ON runs(device_id) WHERE device_id IS NOT NULL`);

// chat_threads: workspace_id + user_id + device_id
const threadCols = (db
  .prepare(`PRAGMA table_info(chat_threads)`)
  .all() as { name: string }[]).map((r) => r.name);
if (!threadCols.includes('workspace_id')) {
  db.exec(`ALTER TABLE chat_threads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local'`);
}
if (!threadCols.includes('user_id')) {
  db.exec(`ALTER TABLE chat_threads ADD COLUMN user_id TEXT`);
}
if (!threadCols.includes('device_id')) {
  db.exec(`ALTER TABLE chat_threads ADD COLUMN device_id TEXT`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_threads_workspace_user ON chat_threads(workspace_id, user_id)`,
);
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_threads_device ON chat_threads(device_id) WHERE device_id IS NOT NULL`,
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
  db.prepare(
    `INSERT INTO users (id, workspace_id, email, name, auth_provider)
     VALUES (?, ?, NULL, 'Local User', 'local')`,
  ).run(DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID);
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
// fallback pattern W2.1 established for app_memory/runs/chat_threads:
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

// Bump user_version so operators can see at a glance which schema
// revision their DB is on. v0.3.0 was at user_version=3; W2.1 lands v4;
// W2.3 lands v5; W3.3 lands v6.
const currentUserVersion = (db.prepare(`PRAGMA user_version`).get() as { user_version: number })
  .user_version;
if (currentUserVersion < 6) {
  db.pragma('user_version = 6');
}
