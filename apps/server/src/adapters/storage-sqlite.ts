// SQLite storage adapter wrapper.
//
// Thin shim that exposes the existing `better-sqlite3`-backed data layer
// (`db.ts` schema + direct SQL used across routes and services) as the
// `StorageAdapter` interface declared in `adapters/types.ts`.
//
// Design notes:
//   - The existing codebase does NOT centralize storage in service
//     functions. Most routes call `db.prepare(...)` directly. This
//     wrapper re-uses the same SQL verbatim so behavior is identical.
//   - Where a cleaner helper already exists (services/jobs.ts,
//     services/runner.ts getRun/updateRun), the wrapper delegates to
//     that helper instead of duplicating SQL.
//   - Methods that do not yet have an in-tree caller (createApp,
//     updateApp, deleteApp, createUser, listWorkspacesForUser) are still
//     implemented with minimal SQL so the adapter surface is complete.
//     The follow-on refactor PR (migrating routes to adapters.storage.*)
//     will exercise these.
//
// Follow-on work: once routes/services migrate to `adapters.storage.*`,
// delete the duplicated SQL in routes and leave this wrapper as the
// single source of truth.
//
import { db } from '../db.js';
import {
  createJob as jobsCreateJob,
  getJob as jobsGetJob,
  nextQueuedJob as jobsNextQueuedJob,
  claimJob as jobsClaimJob,
} from '../services/jobs.js';
import {
  getRun as runnerGetRun,
  updateRun as runnerUpdateRun,
} from '../services/runner.js';
import type {
  AppRecord,
  ErrorType,
  JobRecord,
  JobStatus,
  RunRecord,
  RunStatus,
  SecretRecord,
  UserRecord,
  WorkspaceRecord,
  WorkspaceRole,
} from '../types.js';
import type {
  AppListFilter,
  RunListFilter,
  StorageAdapter,
  UserWriteColumn,
  UserWriteInput,
} from './types.js';

const USER_WRITE_COLUMNS = new Set<keyof UserWriteInput>([
  'id',
  'workspace_id',
  'email',
  'name',
  'auth_provider',
  'auth_subject',
  'image',
  'composio_user_id',
]);

function userInsertKeys(input: UserWriteInput): Array<keyof UserWriteInput> {
  return (Object.keys(input) as Array<keyof UserWriteInput>).filter((key) => {
    if (!USER_WRITE_COLUMNS.has(key)) {
      throw new Error(`Unknown users column: ${String(key)}`);
    }
    return input[key] !== undefined;
  });
}

function userInsertValues(
  input: UserWriteInput,
  keys: Array<keyof UserWriteInput>,
): Array<string | null | undefined> {
  return keys.map((key) => input[key]);
}

export const sqliteStorageAdapter: StorageAdapter = {
  // ---------- apps ----------
  async getApp(slug: string): Promise<AppRecord | undefined> {
    return db
      .prepare('SELECT * FROM apps WHERE slug = ?')
      .get(slug) as AppRecord | undefined;
  },

  async getAppById(id: string): Promise<AppRecord | undefined> {
    return db
      .prepare('SELECT * FROM apps WHERE id = ?')
      .get(id) as AppRecord | undefined;
  },

  async listApps(filter: AppListFilter = {}): Promise<AppRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(filter.workspace_id);
    }
    if (filter.visibility) {
      clauses.push('visibility = ?');
      params.push(filter.visibility);
    }
    if (filter.category) {
      clauses.push('category = ?');
      params.push(filter.category);
    }
    if (filter.featured !== undefined) {
      clauses.push('featured = ?');
      params.push(filter.featured ? 1 : 0);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM apps${where} ORDER BY created_at DESC`;
    if (typeof filter.limit === 'number') {
      sql += ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
      if (typeof filter.offset === 'number') {
        sql += ` OFFSET ${Math.max(0, Math.floor(filter.offset))}`;
      }
    }
    return db.prepare(sql).all(...params) as AppRecord[];
  },

  async createApp(input: Omit<AppRecord, 'created_at' | 'updated_at'>): Promise<AppRecord> {
    // Columns that actually exist on `apps`. We build the INSERT from the
    // keys provided so unknown fields don't trip the schema. All timestamps
    // default to `datetime('now')` in the CREATE TABLE definition.
    const keys = Object.keys(input);
    const placeholders = keys.map(() => '?').join(', ');
    db.prepare(
      `INSERT INTO apps (${keys.join(', ')}) VALUES (${placeholders})`,
    ).run(...keys.map((k) => (input as Record<string, unknown>)[k]));
    return (await this.getAppById((input as { id: string }).id)) as AppRecord;
  },

  async updateApp(
    slug: string,
    patch: Partial<AppRecord>,
  ): Promise<AppRecord | undefined> {
    const keys = Object.keys(patch).filter((k) => k !== 'slug');
    if (keys.length === 0) return this.getApp(slug);
    const set = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(
      `UPDATE apps SET ${set}, updated_at = datetime('now') WHERE slug = ?`,
    ).run(...keys.map((k) => (patch as Record<string, unknown>)[k]), slug);
    return this.getApp(slug);
  },

  async deleteApp(slug: string): Promise<boolean> {
    const row = db
      .prepare('SELECT id FROM apps WHERE slug = ?')
      .get(slug) as { id: string } | undefined;
    if (!row) return false;
    const remove = db.transaction((appId: string) => {
      db.prepare('DELETE FROM secrets WHERE app_id = ?').run(appId);
      return db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
    });
    const res = remove(row.id);
    return res.changes > 0;
  },

  // ---------- runs ----------
  async createRun(input: {
    id: string;
    app_id: string;
    thread_id?: string | null;
    action: string;
    inputs: Record<string, unknown> | null;
  }): Promise<RunRecord> {
    db.prepare(
      `INSERT INTO runs (id, app_id, thread_id, action, inputs, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).run(
      input.id,
      input.app_id,
      input.thread_id ?? null,
      input.action,
      input.inputs ? JSON.stringify(input.inputs) : null,
    );
    return db.prepare('SELECT * FROM runs WHERE id = ?').get(input.id) as RunRecord;
  },

  async getRun(id: string): Promise<RunRecord | undefined> {
    return runnerGetRun(id);
  },

  async listRuns(filter: RunListFilter = {}): Promise<RunRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.app_id) {
      clauses.push('app_id = ?');
      params.push(filter.app_id);
    }
    if (filter.workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(filter.workspace_id);
    }
    if (filter.user_id) {
      clauses.push('user_id = ?');
      params.push(filter.user_id);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM runs${where} ORDER BY started_at DESC`;
    if (typeof filter.limit === 'number') {
      sql += ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
      if (typeof filter.offset === 'number') {
        sql += ` OFFSET ${Math.max(0, Math.floor(filter.offset))}`;
      }
    }
    return db.prepare(sql).all(...params) as RunRecord[];
  },

  async updateRun(
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
  ): Promise<void> {
    runnerUpdateRun(id, patch);
  },

  // ---------- jobs ----------
  async createJob(
    input: Omit<
      JobRecord,
      'created_at' | 'started_at' | 'finished_at' | 'attempts' | 'status'
    > & { status?: JobStatus },
  ): Promise<JobRecord> {
    // services/jobs.ts createJob takes (jobId, args); re-shape the input.
    const { id, ...rest } = input;
    return jobsCreateJob(id, rest as unknown as Parameters<typeof jobsCreateJob>[1]);
  },

  async getJob(id: string): Promise<JobRecord | undefined> {
    return jobsGetJob(id);
  },

  async claimNextJob(): Promise<JobRecord | undefined> {
    const next = jobsNextQueuedJob();
    if (!next) return undefined;
    return jobsClaimJob(next.id);
  },

  async updateJob(id: string, patch: Partial<JobRecord>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE jobs SET ${set} WHERE id = ?`).run(
      ...keys.map((k) => {
        const v = (patch as Record<string, unknown>)[k];
        // inputs/result are JSON columns; stringify objects.
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
      }),
      id,
    );
  },

  // ---------- workspaces + users ----------
  async getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    return db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRecord | undefined;
  },

  async listWorkspacesForUser(
    user_id: string,
  ): Promise<Array<WorkspaceRecord & { role: WorkspaceRole }>> {
    return db
      .prepare(
        `SELECT w.*, m.role as role
           FROM workspaces w
           INNER JOIN workspace_members m ON m.workspace_id = w.id
          WHERE m.user_id = ?
          ORDER BY w.created_at ASC`,
      )
      .all(user_id) as Array<WorkspaceRecord & { role: WorkspaceRole }>;
  },

  async getUser(id: string): Promise<UserRecord | undefined> {
    return db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as UserRecord | undefined;
  },

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    return db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as UserRecord | undefined;
  },

  async createUser(input: UserWriteInput): Promise<UserRecord> {
    const keys = userInsertKeys(input);
    const placeholders = keys.map(() => '?').join(', ');
    db.prepare(
      `INSERT INTO users (${keys.join(', ')}) VALUES (${placeholders})`,
    ).run(...userInsertValues(input, keys));
    return (await this.getUser(input.id)) as UserRecord;
  },

  async upsertUser(
    input: UserWriteInput,
    updateColumns: UserWriteColumn[],
  ): Promise<UserRecord> {
    const keys = userInsertKeys(input);
    const keySet = new Set(keys);
    for (const column of updateColumns) {
      if (!USER_WRITE_COLUMNS.has(column)) {
        throw new Error(`Unknown users column: ${String(column)}`);
      }
      if (!keySet.has(column)) {
        throw new Error(`Cannot upsert users.${String(column)} from an omitted value`);
      }
    }
    const placeholders = keys.map(() => '?').join(', ');
    const updates = updateColumns
      .map((column) => `${column} = excluded.${column}`)
      .join(', ');
    db.prepare(
      `INSERT INTO users (${keys.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET
         ${updates}`,
    ).run(...userInsertValues(input, keys));
    return (await this.getUser(input.id)) as UserRecord;
  },

  // ---------- admin secret pointers ----------
  async listAdminSecrets(app_id?: string | null): Promise<SecretRecord[]> {
    if (app_id === undefined) {
      return db
        .prepare('SELECT * FROM secrets ORDER BY name')
        .all() as SecretRecord[];
    }
    if (app_id === null) {
      return db
        .prepare('SELECT * FROM secrets WHERE app_id IS NULL ORDER BY name')
        .all() as SecretRecord[];
    }
    return db
      .prepare('SELECT * FROM secrets WHERE app_id = ? ORDER BY name')
      .all(app_id) as SecretRecord[];
  },

  async upsertAdminSecret(
    name: string,
    value: string,
    app_id?: string | null,
  ): Promise<void> {
    const scopedApp = app_id ?? null;
    // `secrets` has a uniqueness constraint on (name, COALESCE(app_id,
    // '__global__')), not a composite PK. We INSERT a new row on first
    // write (new id) and UPDATE by the uniqueness key on subsequent
    // writes. Two statements are cheaper than building a synthetic
    // ON CONFLICT target on top of the COALESCE expression.
    const existing = db
      .prepare(
        scopedApp === null
          ? 'SELECT id FROM secrets WHERE name = ? AND app_id IS NULL'
          : 'SELECT id FROM secrets WHERE name = ? AND app_id = ?',
      )
      .get(
        ...(scopedApp === null ? [name] : [name, scopedApp]),
      ) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE secrets SET value = ? WHERE id = ?').run(value, existing.id);
      return;
    }
    // First write: mint an id. Using randomUUID keeps this dependency-free;
    // the rest of the code only reads `name`/`value`/`app_id` anyway.
    const id = globalThis.crypto?.randomUUID?.() || `sec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(
      'INSERT INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, ?)',
    ).run(id, name, value, scopedApp);
  },

  async deleteAdminSecret(
    name: string,
    app_id?: string | null,
  ): Promise<boolean> {
    if (app_id === null || app_id === undefined) {
      const res = db
        .prepare('DELETE FROM secrets WHERE name = ? AND app_id IS NULL')
        .run(name);
      return res.changes > 0;
    }
    const res = db
      .prepare('DELETE FROM secrets WHERE name = ? AND app_id = ?')
      .run(name, app_id);
    return res.changes > 0;
  },
};
