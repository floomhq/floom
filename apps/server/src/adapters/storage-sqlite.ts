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
  AppReviewRecord,
  AgentTokenRecord,
  ErrorType,
  JobRecord,
  JobStatus,
  RunRecord,
  RunStatus,
  RunThreadRecord,
  RunTurnRecord,
  SecretRecord,
  UserRecord,
  WorkspaceRecord,
  WorkspaceRole,
} from '../types.js';
import type {
  AppListFilter,
  AppReviewListFilter,
  CreatorSecretCiphertextRow,
  CreatorSecretCiphertextWriteInput,
  RunListFilter,
  SecretCiphertextRow,
  SecretCiphertextWriteInput,
  StudioAppSummaryFilter,
  StudioAppSummaryRecord,
  StorageAdapter,
  UserWriteColumn,
  UserWriteInput,
} from './types.js';

type UserDeleteListener = (user_id: string) => void | Promise<void>;
type SqliteStorageAdapter = StorageAdapter & {
  deleteUser(id: string): Promise<boolean>;
  onUserDelete(cb: UserDeleteListener): void;
};

const userDeleteListeners: UserDeleteListener[] = [];

async function notifyUserDeleteListeners(user_id: string): Promise<void> {
  for (const cb of userDeleteListeners) {
    await cb(user_id);
  }
}

const USER_WRITE_COLUMNS = new Set<keyof UserWriteInput>([
  'id',
  'workspace_id',
  'email',
  'name',
  'auth_provider',
  'auth_subject',
  'image',
  'is_admin',
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
): unknown[] {
  return keys.map((key) => input[key]);
}

export const sqliteStorageAdapter: SqliteStorageAdapter = {
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
    workspace_id?: string;
    user_id?: string | null;
    device_id?: string | null;
  }): Promise<RunRecord> {
    db.prepare(
      `INSERT INTO runs (id, app_id, thread_id, action, inputs, status, workspace_id, user_id, device_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      input.id,
      input.app_id,
      input.thread_id ?? null,
      input.action,
      input.inputs ? JSON.stringify(input.inputs) : null,
      input.workspace_id ?? 'local',
      input.user_id ?? null,
      input.device_id ?? null,
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
      is_public?: 0 | 1 | boolean;
    },
  ): Promise<void> {
    runnerUpdateRun(id, patch);
  },

  async listStudioAppSummaries(
    filter: StudioAppSummaryFilter,
  ): Promise<StudioAppSummaryRecord[]> {
    const params: unknown[] = [filter.workspace_id];
    const authorClause =
      filter.author === undefined || filter.author === null ? '' : ' AND apps.author = ?';
    if (authorClause) params.push(filter.author);
    return db.prepare(
      `SELECT apps.id, apps.slug, apps.name, apps.icon, apps.publish_status,
              apps.visibility, apps.created_at, apps.updated_at,
              (
                SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
              ) AS last_run_at,
              (
                SELECT COUNT(*) FROM runs
                 WHERE runs.app_id = apps.id
                   AND runs.started_at >= datetime('now', '-7 days')
              ) AS runs_7d
         FROM apps
        WHERE apps.workspace_id = ?${authorClause}
        ORDER BY
          CASE WHEN (
            SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
          ) IS NULL THEN 1 ELSE 0 END,
          (
            SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
          ) DESC,
          apps.updated_at DESC`,
    ).all(...params) as StudioAppSummaryRecord[];
  },

  async createAppReview(input: AppReviewRecord): Promise<AppReviewRecord> {
    db.prepare(
      `INSERT INTO app_reviews
        (id, workspace_id, app_slug, user_id, rating, title, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.workspace_id,
      input.app_slug,
      input.user_id,
      input.rating,
      input.title,
      input.body,
      input.created_at,
      input.updated_at,
    );
    return (await this.getAppReview(input.id)) as AppReviewRecord;
  },

  async getAppReview(id: string): Promise<AppReviewRecord | undefined> {
    return db
      .prepare('SELECT * FROM app_reviews WHERE id = ?')
      .get(id) as AppReviewRecord | undefined;
  },

  async listAppReviews(filter: AppReviewListFilter = {}): Promise<AppReviewRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.app_slug) {
      clauses.push('app_slug = ?');
      params.push(filter.app_slug);
    }
    if (filter.workspace_id) {
      clauses.push('workspace_id = ?');
      params.push(filter.workspace_id);
    }
    if (filter.user_id) {
      clauses.push('user_id = ?');
      params.push(filter.user_id);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    let sql = `SELECT * FROM app_reviews${where} ORDER BY created_at DESC`;
    if (typeof filter.limit === 'number') {
      sql += ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
      if (typeof filter.offset === 'number') {
        sql += ` OFFSET ${Math.max(0, Math.floor(filter.offset))}`;
      }
    }
    return db.prepare(sql).all(...params) as AppReviewRecord[];
  },

  async updateAppReview(
    id: string,
    patch: Pick<AppReviewRecord, 'rating'> &
      Partial<Pick<AppReviewRecord, 'title' | 'body' | 'updated_at'>>,
  ): Promise<AppReviewRecord | undefined> {
    const updatedAt = patch.updated_at ?? new Date().toISOString();
    db.prepare(
      `UPDATE app_reviews
          SET rating = ?, title = ?, body = ?, updated_at = ?
        WHERE id = ?`,
    ).run(patch.rating, patch.title ?? null, patch.body ?? null, updatedAt, id);
    return this.getAppReview(id);
  },

  async deleteAppReview(id: string): Promise<boolean> {
    const result = db.prepare('DELETE FROM app_reviews WHERE id = ?').run(id);
    return result.changes > 0;
  },

  async createRunThread(input: {
    id: string;
    title?: string | null;
    workspace_id?: string;
    user_id?: string | null;
    device_id?: string | null;
  }): Promise<RunThreadRecord> {
    db.prepare(
      `INSERT INTO run_threads (id, title, workspace_id, user_id, device_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.title ?? null,
      input.workspace_id ?? 'local',
      input.user_id ?? null,
      input.device_id ?? null,
    );
    return db
      .prepare('SELECT * FROM run_threads WHERE id = ?')
      .get(input.id) as RunThreadRecord;
  },

  async getRunThread(id: string): Promise<RunThreadRecord | undefined> {
    return db
      .prepare('SELECT * FROM run_threads WHERE id = ?')
      .get(id) as RunThreadRecord | undefined;
  },

  async listRunTurns(thread_id: string): Promise<RunTurnRecord[]> {
    return db
      .prepare('SELECT * FROM run_turns WHERE thread_id = ? ORDER BY turn_index ASC')
      .all(thread_id) as RunTurnRecord[];
  },

  async appendRunTurn(input: {
    id: string;
    thread_id: string;
    kind: RunTurnRecord['kind'];
    payload: string;
  }): Promise<RunTurnRecord> {
    const lastTurn = db
      .prepare('SELECT MAX(turn_index) as max_idx FROM run_turns WHERE thread_id = ?')
      .get(input.thread_id) as { max_idx: number | null };
    const nextIdx = (lastTurn.max_idx ?? -1) + 1;
    db.prepare(
      `INSERT INTO run_turns (id, thread_id, turn_index, kind, payload)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.id, input.thread_id, nextIdx, input.kind, input.payload);
    return db
      .prepare('SELECT * FROM run_turns WHERE id = ?')
      .get(input.id) as RunTurnRecord;
  },

  async updateRunThread(
    id: string,
    patch: { title?: string | null },
  ): Promise<RunThreadRecord | undefined> {
    if (patch.title !== undefined) {
      db.prepare(
        `UPDATE run_threads SET title = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(patch.title, id);
    } else {
      db.prepare(`UPDATE run_threads SET updated_at = datetime('now') WHERE id = ?`).run(id);
    }
    return db
      .prepare('SELECT * FROM run_threads WHERE id = ?')
      .get(id) as RunThreadRecord | undefined;
  },

  async createAgentToken(input: AgentTokenRecord): Promise<AgentTokenRecord> {
    db.prepare(
      `INSERT INTO agent_tokens
         (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
          last_used_at, revoked_at, rate_limit_per_minute)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.prefix,
      input.hash,
      input.label,
      input.scope,
      input.workspace_id,
      input.user_id,
      input.created_at,
      input.last_used_at,
      input.revoked_at,
      input.rate_limit_per_minute,
    );
    return db
      .prepare('SELECT * FROM agent_tokens WHERE id = ?')
      .get(input.id) as AgentTokenRecord;
  },

  async listAgentTokensForUser(user_id: string): Promise<AgentTokenRecord[]> {
    return db
      .prepare(
        `SELECT * FROM agent_tokens
          WHERE user_id = ?
          ORDER BY created_at DESC`,
      )
      .all(user_id) as AgentTokenRecord[];
  },

  async getAgentTokenForUser(
    id: string,
    user_id: string,
  ): Promise<AgentTokenRecord | undefined> {
    return db
      .prepare(`SELECT * FROM agent_tokens WHERE id = ? AND user_id = ?`)
      .get(id, user_id) as AgentTokenRecord | undefined;
  },

  async revokeAgentTokenForUser(
    id: string,
    user_id: string,
    revoked_at: string,
  ): Promise<AgentTokenRecord | undefined> {
    db.prepare(
      `UPDATE agent_tokens
         SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ?
         AND user_id = ?`,
    ).run(revoked_at, id, user_id);
    return this.getAgentTokenForUser(id, user_id);
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

  async deleteUser(id: string): Promise<boolean> {
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    const deleted = Number(result.changes || 0) > 0;
    if (deleted) await notifyUserDeleteListeners(id);
    return deleted;
  },

  onUserDelete(cb: UserDeleteListener): void {
    userDeleteListeners.push(cb);
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

  // ---------- encrypted per-user / creator secret rows ----------
  getUserSecretRow(
    workspace_id: string,
    user_id: string,
    key: string,
  ): SecretCiphertextRow | undefined {
    return db
      .prepare(
        `SELECT workspace_id, user_id, key, ciphertext, nonce, auth_tag,
                encrypted_dek, updated_at
           FROM user_secrets
          WHERE workspace_id = ?
            AND user_id = ?
            AND key = ?`,
      )
      .get(workspace_id, user_id, key) as SecretCiphertextRow | undefined;
  },

  listUserSecretRows(
    workspace_id: string,
    user_id: string,
    keys: string[],
  ): SecretCiphertextRow[] {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT workspace_id, user_id, key, ciphertext, nonce, auth_tag,
                encrypted_dek, updated_at
           FROM user_secrets
          WHERE workspace_id = ?
            AND user_id = ?
            AND key IN (${placeholders})`,
      )
      .all(workspace_id, user_id, ...keys) as SecretCiphertextRow[];
  },

  listUserSecretMetadata(
    workspace_id: string,
    user_id: string,
  ): Array<{ key: string; updated_at: string }> {
    return db
      .prepare(
        `SELECT key, updated_at
           FROM user_secrets
          WHERE workspace_id = ?
            AND user_id = ?
          ORDER BY key`,
      )
      .all(workspace_id, user_id) as Array<{ key: string; updated_at: string }>;
  },

  upsertUserSecretRow(row: SecretCiphertextWriteInput): void {
    db.prepare(
      `INSERT INTO user_secrets
         (workspace_id, user_id, key, ciphertext, nonce, auth_tag, encrypted_dek, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (workspace_id, user_id, key)
         DO UPDATE SET ciphertext = excluded.ciphertext,
                       nonce = excluded.nonce,
                       auth_tag = excluded.auth_tag,
                       encrypted_dek = excluded.encrypted_dek,
                       updated_at = datetime('now')`,
    ).run(
      row.workspace_id,
      row.user_id,
      row.key,
      row.ciphertext,
      row.nonce,
      row.auth_tag,
      row.encrypted_dek,
    );
  },

  deleteUserSecretRow(
    workspace_id: string,
    user_id: string,
    key: string,
  ): boolean {
    const res = db
      .prepare(
        `DELETE FROM user_secrets
          WHERE workspace_id = ?
            AND user_id = ?
            AND key = ?`,
      )
      .run(workspace_id, user_id, key);
    return res.changes > 0;
  },

  setSecretPolicy(
    app_id: string,
    key: string,
    policy: 'user_vault' | 'creator_override',
  ): void {
    db.prepare(
      `INSERT INTO app_secret_policies (app_id, key, policy, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (app_id, key)
         DO UPDATE SET policy = excluded.policy,
                       updated_at = datetime('now')`,
    ).run(app_id, key, policy);
  },

  upsertCreatorSecretRow(row: CreatorSecretCiphertextWriteInput): void {
    db.prepare(
      `INSERT INTO app_creator_secrets
         (app_id, workspace_id, key, ciphertext, nonce, auth_tag, encrypted_dek, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (app_id, key)
         DO UPDATE SET workspace_id = excluded.workspace_id,
                       ciphertext = excluded.ciphertext,
                       nonce = excluded.nonce,
                       auth_tag = excluded.auth_tag,
                       encrypted_dek = excluded.encrypted_dek,
                       updated_at = datetime('now')`,
    ).run(
      row.app_id,
      row.workspace_id,
      row.key,
      row.ciphertext,
      row.nonce,
      row.auth_tag,
      row.encrypted_dek,
    );
  },

  listCreatorOverrideSecretRowsForRun(
    app_id: string,
    keys: string[],
  ): CreatorSecretCiphertextRow[] {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT s.app_id, s.workspace_id, s.key, s.ciphertext, s.nonce,
                s.auth_tag, s.encrypted_dek, s.updated_at
           FROM app_creator_secrets s
           INNER JOIN app_secret_policies p
             ON p.app_id = s.app_id
            AND p.key = s.key
            AND p.policy = 'creator_override'
          WHERE s.app_id = ?
            AND s.key IN (${placeholders})`,
      )
      .all(app_id, ...keys) as CreatorSecretCiphertextRow[];
  },
};
