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
