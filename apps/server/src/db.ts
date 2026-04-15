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
