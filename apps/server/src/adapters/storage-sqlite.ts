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
import { invalidateHubCache } from '../lib/hub-cache.js';
import type {
  AppRecord,
  AppReviewRecord,
  AgentTokenRecord,
  ConnectionOwnerKind,
  ConnectionRecord,
  ConnectionStatus,
  ErrorType,
  JobRecord,
  JobStatus,
  RunRecord,
  RunStatus,
  RunThreadRecord,
  RunTurnRecord,
  SecretRecord,
  TriggerRecord,
  UserRecord,
  WorkspaceInviteRecord,
  WorkspaceMemberRecord,
  WorkspaceMemberRole,
  WorkspaceRecord,
  WorkspaceRole,
} from '../types.js';
import type {
  AppListFilter,
  AppMemoryRecord,
  AppInviteRecord,
  AppReviewListFilter,
  CreatorSecretCiphertextRow,
  CreatorSecretCiphertextWriteInput,
  EncryptedSecretRecord,
  LinkShareRecord,
  JobListFilter,
  RunListFilter,
  SecretCiphertextRow,
  SecretCiphertextWriteInput,
  SessionContext,
  StudioAppSummaryFilter,
  StudioAppSummaryRecord,
  StorageAdapter,
  UserWriteColumn,
  UserWriteInput,
  VisibilityAuditRecord,
  WorkspaceMemberWithUserRecord,
} from './types.js';

type UserDeleteListener = (user_id: string) => void | Promise<void>;
type AppendRunTurnInput = {
  id: string;
  thread_id: string;
  kind: RunTurnRecord['kind'];
  payload: string;
};
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

const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

const JOB_COLUMNS = new Set<keyof JobRecord>([
  'id',
  'slug',
  'app_id',
  'action',
  'status',
  'input_json',
  'output_json',
  'error_json',
  'run_id',
  'webhook_url',
  'timeout_ms',
  'max_retries',
  'attempts',
  'per_call_secrets_json',
  'workspace_id',
  'user_id',
  'device_id',
  'created_at',
  'started_at',
  'finished_at',
]);

const JOB_JSON_COLUMNS = new Set<keyof JobRecord>([
  'input_json',
  'output_json',
  'error_json',
  'per_call_secrets_json',
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

function ensureEncryptedSecretsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS encrypted_secrets (
      workspace_id TEXT NOT NULL,
      key TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      encrypted_dek TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, key)
    );
  `);
}

const appendRunTurnTxn = db.transaction((input: AppendRunTurnInput) => {
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
});

function refreshAppAvgRunMs(runId: string): void {
  try {
    const row = db
      .prepare('SELECT app_id FROM runs WHERE id = ?')
      .get(runId) as { app_id: string } | undefined;
    if (!row) return;
    const avgRow = db
      .prepare(
        `SELECT AVG(duration_ms) AS avg_ms FROM (
           SELECT duration_ms FROM runs
           WHERE app_id = ? AND status = 'success' AND duration_ms IS NOT NULL
           ORDER BY started_at DESC
           LIMIT 20
         )`,
      )
      .get(row.app_id) as { avg_ms: number | null } | undefined;
    const avg = avgRow?.avg_ms;
    if (typeof avg === 'number' && Number.isFinite(avg)) {
      db.prepare('UPDATE apps SET avg_run_ms = ? WHERE id = ?').run(
        Math.round(avg),
        row.app_id,
      );
      invalidateHubCache();
    }
  } catch (err) {
    console.warn(`[storage-sqlite] failed to refresh avg_run_ms: ${(err as Error).message}`);
  }
}

function isRunTurnIndexConstraint(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown };
  return (
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof error.message === 'string' &&
    /run_turns\.thread_id, run_turns\.turn_index|uniq_run_turns_thread_turn_index/.test(
      error.message,
    )
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toNullableJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function normalizeCreateJobInput(
  input: Omit<
    JobRecord,
    | 'created_at'
    | 'started_at'
    | 'finished_at'
    | 'attempts'
    | 'status'
    | 'workspace_id'
    | 'user_id'
    | 'device_id'
  > & {
    status?: JobStatus;
    workspace_id?: string | null;
    user_id?: string | null;
    device_id?: string | null;
  },
): Omit<JobRecord, 'created_at' | 'started_at' | 'finished_at'> {
  const raw = input as unknown as Record<string, unknown>;
  if (raw.app && typeof raw.app === 'object') {
    const app = raw.app as AppRecord;
    const timeoutOverride = raw.timeoutMsOverride;
    const maxRetriesOverride = raw.maxRetriesOverride;
    const perCallSecrets = raw.perCallSecrets;
    return {
      id: String(raw.id),
      slug: app.slug,
      app_id: app.id,
      action: String(raw.action),
      status: 'queued',
      input_json: JSON.stringify(raw.inputs ?? {}),
      output_json: null,
      error_json: null,
      run_id: null,
      webhook_url: stringOrNull(raw.webhookUrlOverride) ?? app.webhook_url,
      timeout_ms:
        typeof timeoutOverride === 'number'
          ? timeoutOverride
          : app.timeout_ms && app.timeout_ms > 0
            ? app.timeout_ms
            : DEFAULT_JOB_TIMEOUT_MS,
      max_retries:
        typeof maxRetriesOverride === 'number'
          ? maxRetriesOverride
          : typeof app.retries === 'number' && app.retries >= 0
            ? app.retries
            : 0,
      attempts: 0,
      per_call_secrets_json:
        perCallSecrets && typeof perCallSecrets === 'object'
          ? JSON.stringify(perCallSecrets)
          : null,
      workspace_id: stringOrNull(raw.workspace_id),
      user_id: stringOrNull(raw.user_id),
      device_id: stringOrNull(raw.device_id),
    };
  }
  return {
    id: input.id,
    slug: input.slug,
    app_id: input.app_id,
    action: input.action,
    status: input.status ?? 'queued',
    input_json: toNullableJson(input.input_json),
    output_json: toNullableJson(input.output_json),
    error_json: toNullableJson(input.error_json),
    run_id: input.run_id,
    webhook_url: input.webhook_url,
    timeout_ms: input.timeout_ms,
    max_retries: input.max_retries,
    attempts: 0,
    per_call_secrets_json: toNullableJson(input.per_call_secrets_json),
    workspace_id: input.workspace_id ?? null,
    user_id: input.user_id ?? null,
    device_id: input.device_id ?? null,
  };
}

function jobPatchValue(key: string, value: unknown): unknown {
  if (JOB_JSON_COLUMNS.has(key as keyof JobRecord)) return toNullableJson(value);
  return value;
}

const claimNextJobTxn = db.transaction(() => {
  const next = db
    .prepare(`SELECT id FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1`)
    .get() as { id: string } | undefined;
  if (!next) return undefined;
  const res = db
    .prepare(
      `UPDATE jobs
         SET status='running',
             started_at=datetime('now'),
             attempts=attempts + 1
       WHERE id = ? AND status = 'queued'`,
    )
    .run(next.id);
  if (res.changes === 0) return undefined;
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(next.id) as
    | JobRecord
    | undefined;
});

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

  async listApps(filter: AppListFilter = {}, ctx?: SessionContext): Promise<AppRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const workspaceId = filter.workspace_id ?? ctx?.workspace_id;
    if (workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(workspaceId);
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
    return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined;
  },

  async listRuns(filter: RunListFilter = {}, ctx?: SessionContext): Promise<RunRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.app_id) {
      clauses.push('app_id = ?');
      params.push(filter.app_id);
    }
    const workspaceId = filter.workspace_id ?? ctx?.workspace_id;
    if (workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(workspaceId);
    }
    if (filter.user_id) {
      clauses.push('user_id = ?');
      params.push(filter.user_id);
    }
    if (filter.device_id) {
      clauses.push('device_id = ?');
      params.push(filter.device_id);
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
    const cols: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      cols.push('status = ?');
      values.push(patch.status);
    }
    if (patch.outputs !== undefined) {
      cols.push('outputs = ?');
      values.push(JSON.stringify(patch.outputs));
    }
    if (patch.error !== undefined) {
      cols.push('error = ?');
      values.push(patch.error);
    }
    if (patch.error_type !== undefined) {
      cols.push('error_type = ?');
      values.push(patch.error_type);
    }
    if (patch.upstream_status !== undefined) {
      cols.push('upstream_status = ?');
      values.push(patch.upstream_status);
    }
    if (patch.logs !== undefined) {
      cols.push('logs = ?');
      values.push(patch.logs);
    }
    if (patch.duration_ms !== undefined) {
      cols.push('duration_ms = ?');
      values.push(patch.duration_ms);
    }
    if (patch.is_public !== undefined) {
      cols.push('is_public = ?');
      values.push(patch.is_public ? 1 : 0);
    }
    if (patch.finished) {
      cols.push("finished_at = datetime('now')");
    }
    if (cols.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE runs SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    if (
      patch.finished &&
      patch.status === 'success' &&
      typeof patch.duration_ms === 'number'
    ) {
      refreshAppAvgRunMs(id);
    }
  },

  async listStudioAppSummaries(
    filter: StudioAppSummaryFilter,
    ctx?: SessionContext,
  ): Promise<StudioAppSummaryRecord[]> {
    const params: unknown[] = [filter.workspace_id ?? ctx?.workspace_id];
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

  async listAppReviews(filter: AppReviewListFilter = {}, ctx?: SessionContext): Promise<AppReviewRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.app_slug) {
      clauses.push('app_slug = ?');
      params.push(filter.app_slug);
    }
    const workspaceId = filter.workspace_id ?? ctx?.workspace_id;
    if (workspaceId) {
      clauses.push('workspace_id = ?');
      params.push(workspaceId);
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

  async listRunTurns(thread_id: string, ctx?: SessionContext): Promise<RunTurnRecord[]> {
    if (ctx?.workspace_id) {
      return db
        .prepare(
          `SELECT run_turns.*
             FROM run_turns
             INNER JOIN run_threads ON run_threads.id = run_turns.thread_id
            WHERE run_turns.thread_id = ?
              AND run_threads.workspace_id = ?
            ORDER BY run_turns.turn_index ASC`,
        )
        .all(thread_id, ctx.workspace_id) as RunTurnRecord[];
    }
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
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return appendRunTurnTxn(input);
      } catch (err) {
        if (!isRunTurnIndexConstraint(err) || attempt === 4) throw err;
      }
    }
    throw new Error(`appendRunTurn: failed to append turn ${input.id}`);
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

  async listAgentTokensForUser(user_id: string, ctx?: SessionContext): Promise<AgentTokenRecord[]> {
    if (ctx?.workspace_id) {
      return db
        .prepare(
          `SELECT * FROM agent_tokens
            WHERE user_id = ?
              AND workspace_id = ?
            ORDER BY created_at DESC`,
        )
        .all(user_id, ctx.workspace_id) as AgentTokenRecord[];
    }
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
      | 'created_at'
      | 'started_at'
      | 'finished_at'
      | 'attempts'
      | 'status'
      | 'workspace_id'
      | 'user_id'
      | 'device_id'
    > & {
      status?: JobStatus;
      workspace_id?: string | null;
      user_id?: string | null;
      device_id?: string | null;
    },
  ): Promise<JobRecord> {
    const normalized = normalizeCreateJobInput(input);
    db.prepare(
      `INSERT INTO jobs (
         id, slug, app_id, action, status, input_json, output_json, error_json,
         run_id, webhook_url, timeout_ms, max_retries, attempts, per_call_secrets_json,
         workspace_id, user_id, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      normalized.id,
      normalized.slug,
      normalized.app_id,
      normalized.action,
      normalized.status,
      normalized.input_json,
      normalized.output_json,
      normalized.error_json,
      normalized.run_id,
      normalized.webhook_url,
      normalized.timeout_ms,
      normalized.max_retries,
      normalized.attempts,
      normalized.per_call_secrets_json,
      normalized.workspace_id,
      normalized.user_id,
      normalized.device_id,
    );
    const row = await this.getJob(normalized.id);
    if (!row) throw new Error(`createJob: failed to re-read row ${normalized.id}`);
    return row;
  },

  async getJob(id: string): Promise<JobRecord | undefined> {
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      | JobRecord
      | undefined;
  },

  async listJobs(filter: JobListFilter = {}): Promise<JobRecord[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.slug) {
      where.push('slug = ?');
      values.push(filter.slug);
    }
    if (filter.app_id) {
      where.push('app_id = ?');
      values.push(filter.app_id);
    }
    if (filter.status) {
      where.push('status = ?');
      values.push(filter.status);
    }
    let sql = 'SELECT * FROM jobs';
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at ASC';
    if (typeof filter.limit === 'number' && filter.limit > 0) {
      sql += ' LIMIT ?';
      values.push(filter.limit);
    }
    return db.prepare(sql).all(...values) as JobRecord[];
  },

  async claimJob(id: string): Promise<JobRecord | undefined> {
    const res = db
      .prepare(
        `UPDATE jobs
           SET status='running',
               started_at=datetime('now'),
               attempts=attempts + 1
         WHERE id = ? AND status = 'queued'`,
      )
      .run(id);
    if (res.changes === 0) return undefined;
    return this.getJob(id);
  },

  async claimNextJob(): Promise<JobRecord | undefined> {
    return claimNextJobTxn();
  },

  async updateJob(id: string, patch: Partial<JobRecord>): Promise<void> {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    for (const key of keys) {
      if (!JOB_COLUMNS.has(key as keyof JobRecord)) {
        throw new Error(`Unknown jobs column: ${key}`);
      }
    }
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE jobs SET ${set} WHERE id = ?`).run(
      ...keys.map((k) => jobPatchValue(k, (patch as Record<string, unknown>)[k])),
      id,
    );
  },

  async markJobComplete(
    id: string,
    outputs: unknown,
    run_id: string | null,
  ): Promise<JobRecord | undefined> {
    db.prepare(
      `UPDATE jobs
         SET status='succeeded',
             output_json=?,
             run_id=?,
             finished_at=datetime('now')
       WHERE id = ?`,
    ).run(toNullableJson(outputs), run_id, id);
    return this.getJob(id);
  },

  async markJobFailed(
    id: string,
    error: unknown,
    run_id: string | null,
  ): Promise<JobRecord | undefined> {
    db.prepare(
      `UPDATE jobs
         SET status='failed',
             error_json=?,
             run_id=?,
             finished_at=datetime('now')
       WHERE id = ?`,
    ).run(toNullableJson(error), run_id, id);
    return this.getJob(id);
  },

  async cancelJob(id: string): Promise<JobRecord | undefined> {
    db.prepare(
      `UPDATE jobs
         SET status='cancelled',
             finished_at=datetime('now')
       WHERE id = ? AND status IN ('queued', 'running')`,
    ).run(id);
    return this.getJob(id);
  },

  // ---------- workspaces + users ----------
  async getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    return db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRecord | undefined;
  },

  async getWorkspaceBySlug(slug: string): Promise<WorkspaceRecord | undefined> {
    return db
      .prepare('SELECT * FROM workspaces WHERE slug = ?')
      .get(slug) as WorkspaceRecord | undefined;
  },

  async createWorkspace(input: {
    id: string;
    slug: string;
    name: string;
    plan: string;
  }): Promise<WorkspaceRecord> {
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, ?)`,
    ).run(input.id, input.slug, input.name, input.plan);
    return (await this.getWorkspace(input.id)) as WorkspaceRecord;
  },

  async updateWorkspace(
    id: string,
    patch: Partial<Pick<WorkspaceRecord, 'name' | 'slug' | 'plan' | 'wrapped_dek'>>,
  ): Promise<WorkspaceRecord | undefined> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return this.getWorkspace(id);
    const allowed = new Set(['name', 'slug', 'plan', 'wrapped_dek']);
    for (const key of keys) {
      if (!allowed.has(key)) throw new Error(`Unknown workspaces column: ${key}`);
    }
    const set = keys.map((key) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE workspaces SET ${set} WHERE id = ?`).run(
      ...keys.map((key) => (patch as Record<string, unknown>)[key]),
      id,
    );
    return this.getWorkspace(id);
  },

  async deleteWorkspace(id: string): Promise<boolean> {
    const result = db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    return result.changes > 0;
  },

  async listWorkspacesForUser(
    user_id: string,
    ctx?: SessionContext,
  ): Promise<Array<WorkspaceRecord & { role: WorkspaceRole }>> {
    if (ctx?.workspace_id) {
      return db
        .prepare(
          `SELECT w.*, m.role as role
             FROM workspaces w
             INNER JOIN workspace_members m ON m.workspace_id = w.id
            WHERE m.user_id = ?
              AND w.id = ?
            ORDER BY w.created_at ASC`,
        )
        .all(user_id, ctx.workspace_id) as Array<WorkspaceRecord & { role: WorkspaceRole }>;
    }
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

  async addUserToWorkspace(
    workspace_id: string,
    user_id: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberRecord> {
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES (?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`,
    ).run(workspace_id, user_id, role);
    return db
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspace_id, user_id) as WorkspaceMemberRecord;
  },

  async updateWorkspaceMemberRole(
    workspace_id: string,
    user_id: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberRecord | undefined> {
    db.prepare(
      `UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`,
    ).run(role, workspace_id, user_id);
    return db
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspace_id, user_id) as WorkspaceMemberRecord | undefined;
  },

  async removeUserFromWorkspace(
    workspace_id: string,
    user_id: string,
  ): Promise<boolean> {
    const tx = db.transaction(() => {
      const res = db
        .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .run(workspace_id, user_id);
      db.prepare(
        'DELETE FROM user_active_workspace WHERE user_id = ? AND workspace_id = ?',
      ).run(user_id, workspace_id);
      return res.changes;
    });
    return tx() > 0;
  },

  async getWorkspaceMemberRole(
    workspace_id: string,
    user_id: string,
  ): Promise<WorkspaceMemberRole | null> {
    const row = db
      .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspace_id, user_id) as { role: string } | undefined;
    if (!row) return null;
    return row.role === 'admin' || row.role === 'editor' || row.role === 'viewer'
      ? row.role
      : 'viewer';
  },

  async countWorkspaceAdmins(workspace_id: string): Promise<number> {
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM workspace_members WHERE workspace_id = ? AND role = 'admin'`,
      )
      .get(workspace_id) as { c: number };
    return row.c;
  },

  async listWorkspaceMembers(
    workspace_id: string,
    ctx?: SessionContext,
  ): Promise<WorkspaceMemberWithUserRecord[]> {
    if (ctx?.workspace_id && workspace_id !== ctx.workspace_id) return [];
    return db
      .prepare(
        `SELECT m.workspace_id, m.user_id, m.role, m.joined_at, u.email, u.name
           FROM workspace_members m
           LEFT JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ?
          ORDER BY m.joined_at ASC`,
      )
      .all(workspace_id) as WorkspaceMemberWithUserRecord[];
  },

  async getActiveWorkspaceId(user_id: string): Promise<string | null> {
    const row = db
      .prepare('SELECT workspace_id FROM user_active_workspace WHERE user_id = ?')
      .get(user_id) as { workspace_id: string } | undefined;
    return row?.workspace_id || null;
  },

  async setActiveWorkspace(user_id: string, workspace_id: string): Promise<void> {
    db.prepare(
      `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         updated_at = excluded.updated_at`,
    ).run(user_id, workspace_id);
  },

  async clearActiveWorkspaceForWorkspace(workspace_id: string): Promise<void> {
    db.prepare('DELETE FROM user_active_workspace WHERE workspace_id = ?').run(workspace_id);
  },

  async createWorkspaceInvite(
    input: Omit<WorkspaceInviteRecord, 'created_at' | 'accepted_at'>,
  ): Promise<WorkspaceInviteRecord> {
    db.prepare(
      `INSERT INTO workspace_invites
         (id, workspace_id, email, role, invited_by_user_id, token, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.workspace_id,
      input.email,
      input.role,
      input.invited_by_user_id,
      input.token,
      input.status,
      input.expires_at,
    );
    return db
      .prepare('SELECT * FROM workspace_invites WHERE id = ?')
      .get(input.id) as WorkspaceInviteRecord;
  },

  async getPendingWorkspaceInviteByToken(
    token: string,
  ): Promise<WorkspaceInviteRecord | undefined> {
    return db
      .prepare(`SELECT * FROM workspace_invites WHERE token = ? AND status = 'pending'`)
      .get(token) as WorkspaceInviteRecord | undefined;
  },

  async listWorkspaceInvites(workspace_id: string, ctx?: SessionContext): Promise<WorkspaceInviteRecord[]> {
    if (ctx?.workspace_id && workspace_id !== ctx.workspace_id) return [];
    return db
      .prepare(
        `SELECT * FROM workspace_invites
          WHERE workspace_id = ?
          ORDER BY created_at DESC`,
      )
      .all(workspace_id) as WorkspaceInviteRecord[];
  },

  async deletePendingWorkspaceInvites(
    workspace_id: string,
    email: string,
  ): Promise<number> {
    const res = db
      .prepare(
        `DELETE FROM workspace_invites
          WHERE workspace_id = ? AND email = ? AND status = 'pending'`,
      )
      .run(workspace_id, email);
    return res.changes;
  },

  async markWorkspaceInviteStatus(
    id: string,
    status: WorkspaceInviteRecord['status'],
  ): Promise<void> {
    db.prepare(`UPDATE workspace_invites SET status = ? WHERE id = ?`).run(status, id);
  },

  async acceptWorkspaceInvite(id: string): Promise<void> {
    db.prepare(
      `UPDATE workspace_invites
          SET status = 'accepted',
              accepted_at = datetime('now')
        WHERE id = ?`,
    ).run(id);
  },

  async revokeWorkspaceInvite(
    workspace_id: string,
    invite_id: string,
  ): Promise<boolean> {
    const res = db
      .prepare(
        `UPDATE workspace_invites SET status = 'revoked'
          WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
      )
      .run(invite_id, workspace_id);
    return res.changes > 0;
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

  async findUserByUsername(
    username: string,
  ): Promise<Pick<UserRecord, 'id' | 'email' | 'name'> | undefined> {
    const normalized = username.trim().replace(/^@/, '').toLowerCase();
    if (!normalized) return undefined;
    return db
      .prepare(
        `SELECT id, email, name
           FROM users
          WHERE LOWER(name) = ?
             OR LOWER(email) = ?
             OR LOWER(substr(email, 1, instr(email, '@') - 1)) = ?
          LIMIT 1`,
      )
      .get(normalized, normalized, normalized) as
      | Pick<UserRecord, 'id' | 'email' | 'name'>
      | undefined;
  },

  async searchUsers(
    query: string,
    limit = 10,
  ): Promise<Array<Pick<UserRecord, 'id' | 'email' | 'name'>>> {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return db
      .prepare(
        `SELECT id, email, name
           FROM users
          WHERE LOWER(COALESCE(name, '')) LIKE ?
             OR LOWER(COALESCE(email, '')) LIKE ?
          ORDER BY name, email
          LIMIT ?`,
      )
      .all(`%${q}%`, `%${q}%`, Math.max(1, Math.floor(limit))) as Array<
      Pick<UserRecord, 'id' | 'email' | 'name'>
    >;
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

  // ---------- app memory ----------
  async getAppMemory(
    row: Pick<AppMemoryRecord, 'workspace_id' | 'app_slug' | 'user_id' | 'key'>,
  ): Promise<AppMemoryRecord | undefined> {
    return db
      .prepare(
        `SELECT * FROM app_memory
          WHERE workspace_id = ?
            AND app_slug = ?
            AND user_id = ?
            AND key = ?`,
      )
      .get(row.workspace_id, row.app_slug, row.user_id, row.key) as
      | AppMemoryRecord
      | undefined;
  },

  async upsertAppMemory(
    input: Omit<AppMemoryRecord, 'updated_at'>,
  ): Promise<AppMemoryRecord> {
    db.prepare(
      `INSERT INTO app_memory (workspace_id, app_slug, user_id, device_id, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (workspace_id, app_slug, user_id, key)
         DO UPDATE SET value = excluded.value,
                       device_id = COALESCE(excluded.device_id, app_memory.device_id),
                       updated_at = datetime('now')`,
    ).run(
      input.workspace_id,
      input.app_slug,
      input.user_id,
      input.device_id,
      input.key,
      input.value,
    );
    return (await this.getAppMemory(input)) as AppMemoryRecord;
  },

  async deleteAppMemory(
    row: Pick<AppMemoryRecord, 'workspace_id' | 'app_slug' | 'user_id' | 'key'>,
  ): Promise<boolean> {
    const res = db
      .prepare(
        `DELETE FROM app_memory
          WHERE workspace_id = ?
            AND app_slug = ?
            AND user_id = ?
            AND key = ?`,
      )
      .run(row.workspace_id, row.app_slug, row.user_id, row.key);
    return res.changes > 0;
  },

  async listAppMemory(
    workspace_id: string,
    app_slug: string,
    user_id: string,
    keys?: string[],
    ctx?: SessionContext,
  ): Promise<AppMemoryRecord[]> {
    if (ctx?.workspace_id && workspace_id !== ctx.workspace_id) return [];
    if (keys && keys.length === 0) return [];
    const params: unknown[] = [workspace_id, app_slug, user_id];
    let keyClause = '';
    if (keys && keys.length > 0) {
      keyClause = ` AND key IN (${keys.map(() => '?').join(', ')})`;
      params.push(...keys);
    }
    return db
      .prepare(
        `SELECT * FROM app_memory
          WHERE workspace_id = ?
            AND app_slug = ?
            AND user_id = ?${keyClause}
          ORDER BY key`,
      )
      .all(...params) as AppMemoryRecord[];
  },

  // ---------- connections ----------
  async listConnections(input: {
    workspace_id: string;
    owner_kind: ConnectionOwnerKind;
    owner_id: string;
    status?: ConnectionStatus;
  }, ctx?: SessionContext): Promise<ConnectionRecord[]> {
    if (ctx?.workspace_id && input.workspace_id !== ctx.workspace_id) return [];
    const params: unknown[] = [input.workspace_id, input.owner_kind, input.owner_id];
    let statusClause = '';
    if (input.status) {
      statusClause = ' AND status = ?';
      params.push(input.status);
    }
    return db
      .prepare(
        `SELECT * FROM connections
          WHERE workspace_id = ?
            AND owner_kind = ?
            AND owner_id = ?${statusClause}
          ORDER BY provider`,
      )
      .all(...params) as ConnectionRecord[];
  },

  async getConnection(id: string): Promise<ConnectionRecord | undefined> {
    return db
      .prepare('SELECT * FROM connections WHERE id = ?')
      .get(id) as ConnectionRecord | undefined;
  },

  async getConnectionByOwnerProvider(input: {
    workspace_id: string;
    owner_kind: ConnectionOwnerKind;
    owner_id: string;
    provider: string;
  }): Promise<ConnectionRecord | undefined> {
    return db
      .prepare(
        `SELECT * FROM connections
          WHERE workspace_id = ?
            AND owner_kind = ?
            AND owner_id = ?
            AND provider = ?`,
      )
      .get(input.workspace_id, input.owner_kind, input.owner_id, input.provider) as
      | ConnectionRecord
      | undefined;
  },

  async getConnectionByOwnerComposioId(input: {
    workspace_id: string;
    owner_kind: ConnectionOwnerKind;
    owner_id: string;
    composio_connection_id: string;
  }): Promise<ConnectionRecord | undefined> {
    return db
      .prepare(
        `SELECT * FROM connections
          WHERE workspace_id = ?
            AND owner_kind = ?
            AND owner_id = ?
            AND composio_connection_id = ?`,
      )
      .get(
        input.workspace_id,
        input.owner_kind,
        input.owner_id,
        input.composio_connection_id,
      ) as ConnectionRecord | undefined;
  },

  async upsertConnection(
    input: Omit<ConnectionRecord, 'created_at' | 'updated_at'>,
  ): Promise<ConnectionRecord> {
    db.prepare(
      `INSERT INTO connections
         (id, workspace_id, owner_kind, owner_id, provider,
          composio_connection_id, composio_account_id, status, metadata_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT (workspace_id, owner_kind, owner_id, provider)
         DO UPDATE SET composio_connection_id = excluded.composio_connection_id,
                       composio_account_id = excluded.composio_account_id,
                       status = excluded.status,
                       metadata_json = excluded.metadata_json,
                       updated_at = datetime('now')`,
    ).run(
      input.id,
      input.workspace_id,
      input.owner_kind,
      input.owner_id,
      input.provider,
      input.composio_connection_id,
      input.composio_account_id,
      input.status,
      input.metadata_json,
    );
    return (await this.getConnectionByOwnerProvider(input)) as ConnectionRecord;
  },

  async updateConnection(
    id: string,
    patch: Partial<
      Pick<
        ConnectionRecord,
        'status' | 'metadata_json' | 'composio_connection_id' | 'composio_account_id'
      >
    >,
  ): Promise<ConnectionRecord | undefined> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return this.getConnection(id);
    const set = keys.map((key) => `${key} = ?`).join(', ');
    db.prepare(
      `UPDATE connections SET ${set}, updated_at = datetime('now') WHERE id = ?`,
    ).run(...keys.map((key) => (patch as Record<string, unknown>)[key]), id);
    return this.getConnection(id);
  },

  async deleteConnection(id: string): Promise<boolean> {
    const res = db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    return res.changes > 0;
  },

  // ---------- sharing ----------
  async getLinkShareByAppSlug(slug: string): Promise<LinkShareRecord | undefined> {
    const row = db
      .prepare(
        `SELECT id AS app_id, slug AS app_slug, visibility, link_share_token,
                link_share_requires_auth, updated_at
           FROM apps
          WHERE slug = ?`,
      )
      .get(slug) as LinkShareRecord | undefined;
    return row;
  },

  async updateAppSharing(
    app_id: string,
    patch: Partial<
      Pick<
        AppRecord,
        | 'visibility'
        | 'link_share_token'
        | 'link_share_requires_auth'
        | 'publish_status'
        | 'review_submitted_at'
        | 'review_decided_at'
        | 'review_decided_by'
        | 'review_comment'
      >
    >,
  ): Promise<AppRecord | undefined> {
    const keys = Object.keys(patch);
    if (keys.length > 0) {
      const set = keys.map((key) => `${key} = ?`).join(', ');
      db.prepare(
        `UPDATE apps SET ${set}, updated_at = datetime('now') WHERE id = ?`,
      ).run(...keys.map((key) => (patch as Record<string, unknown>)[key]), app_id);
    }
    return db.prepare('SELECT * FROM apps WHERE id = ?').get(app_id) as
      | AppRecord
      | undefined;
  },

  async createVisibilityAudit(
    input: Omit<VisibilityAuditRecord, 'created_at'>,
  ): Promise<VisibilityAuditRecord> {
    db.prepare(
      `INSERT INTO app_visibility_audit
         (id, app_id, from_state, to_state, actor_user_id, reason, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.app_id,
      input.from_state,
      input.to_state,
      input.actor_user_id,
      input.reason,
      input.metadata,
    );
    return db
      .prepare('SELECT * FROM app_visibility_audit WHERE id = ?')
      .get(input.id) as VisibilityAuditRecord;
  },

  async listVisibilityAudit(app_id?: string | null, ctx?: SessionContext): Promise<VisibilityAuditRecord[]> {
    if (app_id) {
      if (ctx?.workspace_id) {
        return db
          .prepare(
            `SELECT app_visibility_audit.*
               FROM app_visibility_audit
               INNER JOIN apps ON apps.id = app_visibility_audit.app_id
              WHERE app_visibility_audit.app_id = ?
                AND apps.workspace_id = ?
              ORDER BY app_visibility_audit.created_at DESC`,
          )
          .all(app_id, ctx.workspace_id) as VisibilityAuditRecord[];
      }
      return db
        .prepare(
          `SELECT * FROM app_visibility_audit
            WHERE app_id = ?
            ORDER BY created_at DESC`,
        )
        .all(app_id) as VisibilityAuditRecord[];
    }
    if (ctx?.workspace_id) {
      return db
        .prepare(
          `SELECT app_visibility_audit.*
             FROM app_visibility_audit
             INNER JOIN apps ON apps.id = app_visibility_audit.app_id
            WHERE apps.workspace_id = ?
            ORDER BY app_visibility_audit.created_at DESC
            LIMIT 200`,
        )
        .all(ctx.workspace_id) as VisibilityAuditRecord[];
    }
    return db
      .prepare(`SELECT * FROM app_visibility_audit ORDER BY created_at DESC LIMIT 200`)
      .all() as VisibilityAuditRecord[];
  },

  async listAppInvites(app_id: string, ctx?: SessionContext): Promise<AppInviteRecord[]> {
    const workspaceClause = ctx?.workspace_id ? ' AND apps.workspace_id = ?' : '';
    const params = ctx?.workspace_id ? [app_id, ctx.workspace_id] : [app_id];
    return db
      .prepare(
        `SELECT app_invites.*,
                users.name AS invited_user_name,
                users.email AS invited_user_email
           FROM app_invites
           INNER JOIN apps ON apps.id = app_invites.app_id
           LEFT JOIN users ON users.id = app_invites.invited_user_id
          WHERE app_invites.app_id = ?${workspaceClause}
          ORDER BY app_invites.created_at DESC`,
      )
      .all(...params) as AppInviteRecord[];
  },

  async upsertAppInvite(
    input: Omit<AppInviteRecord, 'id' | 'created_at' | 'accepted_at' | 'revoked_at'> & {
      id: string;
    },
  ): Promise<AppInviteRecord> {
    const existing = db
      .prepare(
        `SELECT * FROM app_invites
          WHERE app_id = ?
            AND (
              (? IS NOT NULL AND invited_user_id = ?)
              OR (? IS NOT NULL AND LOWER(invited_email) = LOWER(?))
            )
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .get(
        input.app_id,
        input.invited_user_id || null,
        input.invited_user_id || null,
        input.invited_email || null,
        input.invited_email || null,
      ) as AppInviteRecord | undefined;
    if (existing && !['revoked', 'declined'].includes(existing.state)) {
      return existing;
    }
    db.prepare(
      `INSERT INTO app_invites
         (id, app_id, invited_user_id, invited_email, state, invited_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.app_id,
      input.invited_user_id || null,
      input.invited_email || null,
      input.state,
      input.invited_by_user_id,
    );
    return db.prepare('SELECT * FROM app_invites WHERE id = ?').get(input.id) as AppInviteRecord;
  },

  async revokeAppInvite(
    invite_id: string,
    app_id: string,
  ): Promise<AppInviteRecord | undefined> {
    const invite = db
      .prepare('SELECT * FROM app_invites WHERE id = ? AND app_id = ?')
      .get(invite_id, app_id) as AppInviteRecord | undefined;
    if (!invite) return undefined;
    if (invite.state !== 'revoked') {
      db.prepare(
        `UPDATE app_invites
            SET state = 'revoked',
                revoked_at = datetime('now')
          WHERE id = ?`,
      ).run(invite.id);
    }
    return db.prepare('SELECT * FROM app_invites WHERE id = ?').get(invite.id) as AppInviteRecord;
  },

  async acceptAppInvite(
    invite_id: string,
    user_id: string,
  ): Promise<{ invite: AppInviteRecord | undefined; changed: boolean }> {
    const invite = db
      .prepare('SELECT * FROM app_invites WHERE id = ?')
      .get(invite_id) as AppInviteRecord | undefined;
    if (!invite || invite.invited_user_id !== user_id) {
      return { invite: undefined, changed: false };
    }
    if (invite.state === 'accepted') return { invite, changed: false };
    if (invite.state !== 'pending_accept') return { invite, changed: false };
    db.prepare(
      `UPDATE app_invites
          SET state = 'accepted',
              accepted_at = datetime('now')
        WHERE id = ?`,
    ).run(invite.id);
    return {
      invite: db.prepare('SELECT * FROM app_invites WHERE id = ?').get(invite.id) as AppInviteRecord,
      changed: true,
    };
  },

  async declineAppInvite(
    invite_id: string,
    user_id: string,
  ): Promise<AppInviteRecord | undefined> {
    const invite = db
      .prepare('SELECT * FROM app_invites WHERE id = ?')
      .get(invite_id) as AppInviteRecord | undefined;
    if (!invite || invite.invited_user_id !== user_id) return undefined;
    if (invite.state === 'accepted' || invite.state === 'pending_accept') {
      db.prepare(`UPDATE app_invites SET state = 'declined' WHERE id = ?`).run(invite.id);
    }
    return db.prepare('SELECT * FROM app_invites WHERE id = ?').get(invite.id) as AppInviteRecord;
  },

  async linkPendingEmailAppInvites(user_id: string, email: string): Promise<number> {
    const res = db
      .prepare(
        `UPDATE app_invites
            SET invited_user_id = ?,
                state = 'pending_accept'
          WHERE state = 'pending_email'
            AND LOWER(invited_email) = LOWER(?)`,
      )
      .run(user_id, email);
    return res.changes;
  },

  async listPendingAppInvitesForUser(user_id: string, ctx?: SessionContext): Promise<AppInviteRecord[]> {
    const workspaceClause = ctx?.workspace_id ? ' AND apps.workspace_id = ?' : '';
    const params = ctx?.workspace_id ? [user_id, ctx.workspace_id] : [user_id];
    return db
      .prepare(
        `SELECT app_invites.*,
                apps.slug AS app_slug,
                apps.name AS app_name,
                apps.description AS app_description
           FROM app_invites
           JOIN apps ON apps.id = app_invites.app_id
          WHERE app_invites.invited_user_id = ?
            AND app_invites.state = 'pending_accept'${workspaceClause}
          ORDER BY app_invites.created_at DESC`,
      )
      .all(...params) as AppInviteRecord[];
  },

  async userHasAcceptedAppInvite(app_id: string, user_id: string): Promise<boolean> {
    const row = db
      .prepare(
        `SELECT 1 AS ok
           FROM app_invites
          WHERE app_id = ?
            AND invited_user_id = ?
            AND state = 'accepted'
          LIMIT 1`,
      )
      .get(app_id, user_id) as { ok: number } | undefined;
    return Boolean(row);
  },

  // ---------- triggers ----------
  async createTrigger(input: TriggerRecord): Promise<TriggerRecord> {
    db.prepare(
      `INSERT INTO triggers (
         id, app_id, user_id, workspace_id, action, inputs, trigger_type,
         cron_expression, tz, webhook_secret, webhook_url_path, next_run_at,
         last_fired_at, enabled, retry_policy, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.app_id,
      input.user_id,
      input.workspace_id,
      input.action,
      input.inputs,
      input.trigger_type,
      input.cron_expression,
      input.tz,
      input.webhook_secret,
      input.webhook_url_path,
      input.next_run_at,
      input.last_fired_at,
      input.enabled,
      input.retry_policy,
      input.created_at,
      input.updated_at,
    );
    return (await this.getTrigger(input.id)) as TriggerRecord;
  },

  async getTrigger(id: string): Promise<TriggerRecord | undefined> {
    return db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as
      | TriggerRecord
      | undefined;
  },

  async getTriggerByWebhookPath(path: string): Promise<TriggerRecord | undefined> {
    return db
      .prepare('SELECT * FROM triggers WHERE webhook_url_path = ?')
      .get(path) as TriggerRecord | undefined;
  },

  async listTriggersForUser(user_id: string, ctx?: SessionContext): Promise<TriggerRecord[]> {
    if (ctx?.workspace_id) {
      return db
        .prepare(
          `SELECT * FROM triggers
            WHERE user_id = ?
              AND workspace_id = ?
            ORDER BY created_at DESC`,
        )
        .all(user_id, ctx.workspace_id) as TriggerRecord[];
    }
    return db
      .prepare('SELECT * FROM triggers WHERE user_id = ? ORDER BY created_at DESC')
      .all(user_id) as TriggerRecord[];
  },

  async listTriggersForApp(app_id: string, ctx?: SessionContext): Promise<TriggerRecord[]> {
    if (ctx?.workspace_id) {
      return db
        .prepare(
          `SELECT * FROM triggers
            WHERE app_id = ?
              AND workspace_id = ?
            ORDER BY created_at DESC`,
        )
        .all(app_id, ctx.workspace_id) as TriggerRecord[];
    }
    return db
      .prepare('SELECT * FROM triggers WHERE app_id = ? ORDER BY created_at DESC')
      .all(app_id) as TriggerRecord[];
  },

  async listDueTriggers(now_ms: number, ctx?: SessionContext): Promise<TriggerRecord[]> {
    const workspaceClause = ctx?.workspace_id ? ' AND workspace_id = ?' : '';
    const params = ctx?.workspace_id ? [now_ms, ctx.workspace_id] : [now_ms];
    return db
      .prepare(
        `SELECT * FROM triggers
          WHERE trigger_type = 'schedule'
            AND enabled = 1
            AND next_run_at IS NOT NULL
            AND next_run_at <= ?${workspaceClause}
          ORDER BY next_run_at ASC`,
      )
      .all(...params) as TriggerRecord[];
  },

  async updateTrigger(
    id: string,
    patch: Partial<TriggerRecord>,
  ): Promise<TriggerRecord | undefined> {
    const keys = Object.keys(patch).filter((key) => key !== 'id');
    if (keys.length > 0) {
      const set = keys.map((key) => `${key} = ?`).join(', ');
      db.prepare(`UPDATE triggers SET ${set} WHERE id = ?`).run(
        ...keys.map((key) => (patch as Record<string, unknown>)[key]),
        id,
      );
    }
    return this.getTrigger(id);
  },

  async deleteTrigger(id: string): Promise<boolean> {
    const res = db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
    return res.changes > 0;
  },

  async markTriggerFired(id: string, now_ms: number): Promise<void> {
    db.prepare(
      `UPDATE triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now_ms, now_ms, id);
  },

  async advanceTriggerSchedule(
    id: string,
    next_run_at: number,
    now_ms: number,
    expected_next_run_at?: number | null,
    fire = true,
  ): Promise<boolean> {
    const set = fire
      ? `next_run_at = ?, last_fired_at = ?, updated_at = ?`
      : `next_run_at = ?, updated_at = ?`;
    const values: unknown[] = fire
      ? [next_run_at, now_ms, now_ms, id]
      : [next_run_at, now_ms, id];
    let where = 'id = ?';
    if (expected_next_run_at !== undefined) {
      where += ' AND next_run_at IS ?';
      values.push(expected_next_run_at);
    }
    const res = db.prepare(`UPDATE triggers SET ${set} WHERE ${where}`).run(...values);
    return res.changes > 0;
  },

  async recordTriggerWebhookDelivery(
    trigger_id: string,
    request_id: string,
    now_ms: number,
    ttl_ms: number,
  ): Promise<boolean> {
    db.prepare('DELETE FROM trigger_webhook_deliveries WHERE received_at < ?').run(
      now_ms - ttl_ms,
    );
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO trigger_webhook_deliveries
           (trigger_id, request_id, received_at)
         VALUES (?, ?, ?)`,
      )
      .run(trigger_id, request_id, now_ms);
    return res.changes > 0;
  },

  // ---------- admin secret pointers ----------
  async listAdminSecrets(app_id?: string | null, ctx?: SessionContext): Promise<SecretRecord[]> {
    if (app_id === undefined) {
      if (ctx?.workspace_id) {
        return db
          .prepare(
            `SELECT secrets.*
               FROM secrets
               INNER JOIN apps ON apps.id = secrets.app_id
              WHERE apps.workspace_id = ?
              ORDER BY secrets.name`,
          )
          .all(ctx.workspace_id) as SecretRecord[];
      }
      return db
        .prepare('SELECT * FROM secrets ORDER BY name')
        .all() as SecretRecord[];
    }
    if (app_id === null) {
      return db
        .prepare('SELECT * FROM secrets WHERE app_id IS NULL ORDER BY name')
        .all() as SecretRecord[];
    }
    if (ctx?.workspace_id) {
      return db
        .prepare(
          `SELECT secrets.*
             FROM secrets
             INNER JOIN apps ON apps.id = secrets.app_id
            WHERE secrets.app_id = ?
              AND apps.workspace_id = ?
            ORDER BY secrets.name`,
        )
        .all(app_id, ctx.workspace_id) as SecretRecord[];
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

  async getEncryptedSecret(
    ctx: { workspace_id: string },
    key: string,
  ): Promise<EncryptedSecretRecord | undefined> {
    ensureEncryptedSecretsTable();
    return db
      .prepare(
        `SELECT workspace_id, key, ciphertext, nonce, auth_tag, encrypted_dek,
                created_at, updated_at
           FROM encrypted_secrets
          WHERE workspace_id = ?
            AND key = ?`,
      )
      .get(ctx.workspace_id, key) as EncryptedSecretRecord | undefined;
  },

  async setEncryptedSecret(
    ctx: { workspace_id: string },
    key: string,
    payload: {
      ciphertext: string;
      nonce: string;
      auth_tag: string;
      encrypted_dek: string;
    },
  ): Promise<void> {
    ensureEncryptedSecretsTable();
    db.prepare(
      `INSERT INTO encrypted_secrets
         (workspace_id, key, ciphertext, nonce, auth_tag, encrypted_dek, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (workspace_id, key)
         DO UPDATE SET ciphertext = excluded.ciphertext,
                       nonce = excluded.nonce,
                       auth_tag = excluded.auth_tag,
                       encrypted_dek = excluded.encrypted_dek,
                       updated_at = datetime('now')`,
    ).run(
      ctx.workspace_id,
      key,
      payload.ciphertext,
      payload.nonce,
      payload.auth_tag,
      payload.encrypted_dek,
    );
  },

  async listEncryptedSecrets(
    ctx: { workspace_id: string },
  ): Promise<Array<{ key: string; updated_at: string }>> {
    ensureEncryptedSecretsTable();
    return db
      .prepare(
        `SELECT key, updated_at
           FROM encrypted_secrets
          WHERE workspace_id = ?
          ORDER BY key`,
      )
      .all(ctx.workspace_id) as Array<{ key: string; updated_at: string }>;
  },

  async deleteEncryptedSecret(
    ctx: { workspace_id: string },
    key: string,
  ): Promise<boolean> {
    ensureEncryptedSecretsTable();
    const res = db
      .prepare(
        `DELETE FROM encrypted_secrets
          WHERE workspace_id = ?
            AND key = ?`,
      )
      .run(ctx.workspace_id, key);
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
    ctx?: SessionContext,
  ): SecretCiphertextRow[] {
    if (ctx?.workspace_id && workspace_id !== ctx.workspace_id) return [];
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
    ctx?: SessionContext,
  ): Array<{ key: string; updated_at: string }> {
    if (ctx?.workspace_id && workspace_id !== ctx.workspace_id) return [];
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
    ctx?: SessionContext,
  ): CreatorSecretCiphertextRow[] {
    if (keys.length === 0) return [];
    const workspaceClause = ctx?.workspace_id ? ' AND s.workspace_id = ?' : '';
    const placeholders = keys.map(() => '?').join(', ');
    const params = ctx?.workspace_id ? [app_id, ...keys, ctx.workspace_id] : [app_id, ...keys];
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
            AND s.key IN (${placeholders})${workspaceClause}`,
      )
      .all(...params) as CreatorSecretCiphertextRow[];
  },
};
