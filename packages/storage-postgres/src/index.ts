import type {
  AppListFilter,
  AppMemoryRecord,
  AppInviteRecord,
  AppReviewListFilter,
  AppReviewRecord,
  AppRecord,
  AgentTokenRecord,
  ConnectionOwnerKind,
  ConnectionRecord,
  ConnectionStatus,
  EncryptedSecretRecord,
  ErrorType,
  JobRecord,
  JobStatus,
  RunListFilter,
  RunRecord,
  RunStatus,
  RunThreadRecord,
  RunTurnRecord,
  SecretRecord,
  SessionContext,
  StudioAppSummaryFilter,
  StudioAppSummaryRecord,
  StorageAdapter,
  TriggerRecord,
  UserRecord,
  UserWriteColumn,
  UserWriteInput,
  VisibilityAuditRecord,
  WorkspaceInviteRecord,
  WorkspaceMemberRecord,
  WorkspaceMemberRole,
  WorkspaceMemberWithUserRecord,
  WorkspaceRecord,
  WorkspaceRole,
  LinkShareRecord,
} from '@floom/adapter-types';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg, { type Pool as PgPool } from 'pg';

export interface PostgresAdapterOptions {
  connectionString: string;
  setupSchema?: boolean;
  callTimeoutMs?: number;
}

interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;

const { Pool, types } = pg;
types.setTypeParser(20, (value: string) => Number(value));

const APP_COLUMNS = new Set([
  'id',
  'slug',
  'name',
  'description',
  'manifest',
  'status',
  'docker_image',
  'code_path',
  'category',
  'author',
  'icon',
  'app_type',
  'base_url',
  'auth_type',
  'auth_config',
  'openapi_spec_url',
  'openapi_spec_cached',
  'visibility',
  'link_share_token',
  'link_share_requires_auth',
  'review_submitted_at',
  'review_decided_at',
  'review_decided_by',
  'review_comment',
  'is_async',
  'webhook_url',
  'timeout_ms',
  'retries',
  'async_mode',
  'workspace_id',
  'memory_keys',
  'featured',
  'avg_run_ms',
  'publish_status',
  'thumbnail_url',
  'stars',
  'hero',
  'created_at',
  'updated_at',
]);

const APP_BOOLEAN_COLUMNS = new Set(['is_async', 'featured', 'hero']);
const APP_SHARING_BOOLEAN_COLUMNS = new Set(['link_share_requires_auth']);
const RUN_JSON_COLUMNS = new Set(['inputs', 'outputs']);
const RUN_BOOLEAN_COLUMNS = new Set(['is_public']);
const JOB_JSON_COLUMNS = new Set([
  'input_json',
  'output_json',
  'error_json',
  'per_call_secrets_json',
]);
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
const JOB_COLUMNS = new Set([
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
  'created_at',
  'started_at',
  'finished_at',
]);

class PostgresStorageAdapter implements StorageAdapter {
  private readonly pool: PgPool;
  private readonly connectionString: string;
  private readonly setupSchema: boolean;
  private schemaReady: Promise<void> | null = null;

  constructor(opts: PostgresAdapterOptions) {
    this.connectionString = opts.connectionString;
    this.setupSchema = opts.setupSchema ?? true;
    this.pool = new Pool({
      connectionString: opts.connectionString || 'postgres://invalid',
      max: 10,
    });
  }

  async getApp(slug: string): Promise<AppRecord | undefined> {
    return one((await this.query('SELECT * FROM apps WHERE slug = $1', [slug])).map(normalizeApp));
  }

  async getAppById(id: string): Promise<AppRecord | undefined> {
    return one((await this.query('SELECT * FROM apps WHERE id = $1', [id])).map(normalizeApp));
  }

  async listApps(filter: AppListFilter = {}, ctx?: SessionContext): Promise<AppRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const workspaceId = filter.workspace_id ?? ctx?.workspace_id;
    if (workspaceId) {
      params.push(workspaceId);
      clauses.push(`workspace_id = $${params.length}`);
    }
    if (filter.visibility) {
      params.push(filter.visibility);
      clauses.push(`visibility = $${params.length}`);
    }
    if (filter.category) {
      params.push(filter.category);
      clauses.push(`category = $${params.length}`);
    }
    if (filter.featured !== undefined) {
      params.push(filter.featured);
      clauses.push(`featured = $${params.length}`);
    }
    let sql = `SELECT * FROM apps${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`;
    if (typeof filter.limit === 'number') {
      params.push(nonNegativeInt(filter.limit));
      sql += ` LIMIT $${params.length}`;
      if (typeof filter.offset === 'number') {
        params.push(nonNegativeInt(filter.offset));
        sql += ` OFFSET $${params.length}`;
      }
    }
    return (await this.query(sql, params)).map(normalizeApp);
  }

  async createApp(input: Omit<AppRecord, 'created_at' | 'updated_at'>): Promise<AppRecord> {
    const keys = Object.keys(input).filter((key) => key !== 'created_at' && key !== 'updated_at');
    assertColumns('apps', keys, APP_COLUMNS);
    const values = keys.map((key) =>
      appValueToDb(key, (input as Record<string, unknown>)[key]),
    );
    const columns = keys.join(', ');
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
    await this.execute(`INSERT INTO apps (${columns}) VALUES (${placeholders})`, values);
    const row = await this.getAppById(input.id);
    if (!row) throw new Error(`createApp: failed to re-read row ${input.id}`);
    return row;
  }

  async updateApp(
    slug: string,
    patch: Partial<AppRecord>,
  ): Promise<AppRecord | undefined> {
    const keys = Object.keys(patch).filter((key) => key !== 'slug');
    assertColumns('apps', keys, APP_COLUMNS);
    if (keys.length === 0) return this.getApp(slug);
    const values = keys.map((key) =>
      appValueToDb(key, (patch as Record<string, unknown>)[key]),
    );
    values.push(slug);
    const set = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    await this.execute(
      `UPDATE apps SET ${set}, updated_at = now() WHERE slug = $${values.length}`,
      values,
    );
    return this.getApp(slug);
  }

  async deleteApp(slug: string): Promise<boolean> {
    const row = one(await this.query('SELECT id FROM apps WHERE slug = $1', [slug]));
    if (!row || typeof row.id !== 'string') return false;
    const result = await this.execute('DELETE FROM apps WHERE id = $1', [row.id]);
    return result.rowCount > 0;
  }

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
    const app = await this.getAppById(input.app_id);
    await this.execute(
      `INSERT INTO runs (id, app_id, thread_id, action, inputs, status, workspace_id, user_id, device_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7, $8)`,
      [
        input.id,
        input.app_id,
        input.thread_id ?? null,
        input.action,
        input.inputs === null ? null : JSON.stringify(input.inputs),
        input.workspace_id ?? app?.workspace_id ?? 'local',
        input.user_id ?? null,
        input.device_id ?? null,
      ],
    );
    const row = await this.getRun(input.id);
    if (!row) throw new Error(`createRun: failed to re-read row ${input.id}`);
    return row;
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return one((await this.query('SELECT * FROM runs WHERE id = $1', [id])).map(normalizeRun));
  }

  async listRuns(filter: RunListFilter = {}, ctx?: SessionContext): Promise<RunRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.app_id) {
      params.push(filter.app_id);
      clauses.push(`app_id = $${params.length}`);
    }
    const workspaceId = filter.workspace_id ?? ctx?.workspace_id;
    if (workspaceId) {
      params.push(workspaceId);
      clauses.push(`workspace_id = $${params.length}`);
    }
    if (filter.user_id) {
      params.push(filter.user_id);
      clauses.push(`user_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    let sql = `SELECT * FROM runs${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY started_at DESC`;
    if (typeof filter.limit === 'number') {
      params.push(nonNegativeInt(filter.limit));
      sql += ` LIMIT $${params.length}`;
      if (typeof filter.offset === 'number') {
        params.push(nonNegativeInt(filter.offset));
        sql += ` OFFSET $${params.length}`;
      }
    }
    return (await this.query(sql, params)).map(normalizeRun);
  }

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
      cols.push(`status = $${values.length + 1}`);
      values.push(patch.status);
    }
    if (patch.outputs !== undefined) {
      cols.push(`outputs = $${values.length + 1}::jsonb`);
      values.push(JSON.stringify(patch.outputs));
    }
    if (patch.error !== undefined) {
      cols.push(`error = $${values.length + 1}`);
      values.push(patch.error);
    }
    if (patch.error_type !== undefined) {
      cols.push(`error_type = $${values.length + 1}`);
      values.push(patch.error_type);
    }
    if (patch.upstream_status !== undefined) {
      cols.push(`upstream_status = $${values.length + 1}`);
      values.push(patch.upstream_status);
    }
    if (patch.logs !== undefined) {
      cols.push(`logs = $${values.length + 1}`);
      values.push(patch.logs);
    }
    if (patch.duration_ms !== undefined) {
      cols.push(`duration_ms = $${values.length + 1}`);
      values.push(patch.duration_ms);
    }
    if (patch.is_public !== undefined) {
      cols.push(`is_public = $${values.length + 1}`);
      values.push(Boolean(patch.is_public));
    }
    if (patch.finished) {
      cols.push('finished_at = now()');
    }
    if (cols.length === 0) return;
    values.push(id);
    await this.execute(`UPDATE runs SET ${cols.join(', ')} WHERE id = $${values.length}`, values);
    if (
      patch.finished &&
      patch.status === 'success' &&
      typeof patch.duration_ms === 'number'
    ) {
      await this.refreshAppAvgRunMs(id);
    }
  }

  async listStudioAppSummaries(
    filter: StudioAppSummaryFilter,
    ctx?: SessionContext,
  ): Promise<StudioAppSummaryRecord[]> {
    const params: unknown[] = [filter.workspace_id ?? ctx?.workspace_id];
    const authorClause =
      filter.author === undefined || filter.author === null ? '' : ` AND apps.author = $2`;
    if (authorClause) params.push(filter.author);
    return (await this.query(
      `SELECT apps.id, apps.slug, apps.name, apps.icon, apps.publish_status,
              apps.visibility, apps.created_at, apps.updated_at,
              (
                SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
              ) AS last_run_at,
              (
                SELECT COUNT(*) FROM runs
                 WHERE runs.app_id = apps.id
                   AND runs.started_at >= now() - interval '7 days'
              ) AS runs_7d
         FROM apps
        WHERE apps.workspace_id = $1${authorClause}
        ORDER BY
          CASE WHEN (
            SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
          ) IS NULL THEN 1 ELSE 0 END,
          (
            SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
          ) DESC,
          apps.updated_at DESC`,
      params,
    )).map(normalizeStudioAppSummary);
  }

  async createAppReview(input: AppReviewRecord): Promise<AppReviewRecord> {
    await this.execute(
      `INSERT INTO app_reviews
        (id, workspace_id, app_slug, user_id, rating, title, body, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        input.workspace_id,
        input.app_slug,
        input.user_id,
        input.rating,
        input.title,
        input.body,
        input.created_at,
        input.updated_at,
      ],
    );
    const row = await this.getAppReview(input.id);
    if (!row) throw new Error(`createAppReview: failed to re-read row ${input.id}`);
    return row;
  }

  async getAppReview(id: string): Promise<AppReviewRecord | undefined> {
    return one((await this.query('SELECT * FROM app_reviews WHERE id = $1', [id])).map(normalizeAppReview));
  }

  async listAppReviews(filter: AppReviewListFilter = {}, ctx?: SessionContext): Promise<AppReviewRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.app_slug) {
      params.push(filter.app_slug);
      clauses.push(`app_slug = $${params.length}`);
    }
    const workspaceId = filter.workspace_id ?? ctx?.workspace_id;
    if (workspaceId) {
      params.push(workspaceId);
      clauses.push(`workspace_id = $${params.length}`);
    }
    if (filter.user_id) {
      params.push(filter.user_id);
      clauses.push(`user_id = $${params.length}`);
    }
    let sql = `SELECT * FROM app_reviews${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`;
    if (typeof filter.limit === 'number') {
      params.push(nonNegativeInt(filter.limit));
      sql += ` LIMIT $${params.length}`;
      if (typeof filter.offset === 'number') {
        params.push(nonNegativeInt(filter.offset));
        sql += ` OFFSET $${params.length}`;
      }
    }
    return (await this.query(sql, params)).map(normalizeAppReview);
  }

  async updateAppReview(
    id: string,
    patch: Pick<AppReviewRecord, 'rating'> &
      Partial<Pick<AppReviewRecord, 'title' | 'body' | 'updated_at'>>,
  ): Promise<AppReviewRecord | undefined> {
    const rows = await this.query(
      `UPDATE app_reviews
          SET rating = $1,
              title = $2,
              body = $3,
              updated_at = $4
        WHERE id = $5
        RETURNING *`,
      [patch.rating, patch.title ?? null, patch.body ?? null, patch.updated_at ?? new Date().toISOString(), id],
    );
    return one(rows.map(normalizeAppReview));
  }

  async deleteAppReview(id: string): Promise<boolean> {
    const result = await this.execute('DELETE FROM app_reviews WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async createRunThread(input: {
    id: string;
    title?: string | null;
    workspace_id?: string;
    user_id?: string | null;
    device_id?: string | null;
  }): Promise<RunThreadRecord> {
    const row = one(
      (await this.query(
        `INSERT INTO run_threads (id, title, workspace_id, user_id, device_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.id,
          input.title ?? null,
          input.workspace_id ?? 'local',
          input.user_id ?? null,
          input.device_id ?? null,
        ],
      )).map(normalizeRunThread),
    );
    if (!row) throw new Error(`createRunThread: failed to re-read row ${input.id}`);
    return row;
  }

  async getRunThread(id: string): Promise<RunThreadRecord | undefined> {
    return one(
      (await this.query('SELECT * FROM run_threads WHERE id = $1', [id])).map(
        normalizeRunThread,
      ),
    );
  }

  async listRunTurns(thread_id: string, ctx?: SessionContext): Promise<RunTurnRecord[]> {
    if (ctx?.workspace_id) {
      return (
        await this.query(
          `SELECT run_turns.*
             FROM run_turns
             INNER JOIN run_threads ON run_threads.id = run_turns.thread_id
            WHERE run_turns.thread_id = $1
              AND run_threads.workspace_id = $2
            ORDER BY run_turns.turn_index ASC`,
          [thread_id, ctx.workspace_id],
        )
      ).map(normalizeRunTurn);
    }
    return (
      await this.query(
        'SELECT * FROM run_turns WHERE thread_id = $1 ORDER BY turn_index ASC',
        [thread_id],
      )
    ).map(normalizeRunTurn);
  }

  async appendRunTurn(input: {
    id: string;
    thread_id: string;
    kind: RunTurnRecord['kind'];
    payload: string;
  }): Promise<RunTurnRecord> {
    const row = one(
      (await this.query(
        `INSERT INTO run_turns (id, thread_id, turn_index, kind, payload)
         SELECT $1, $2, COALESCE(MAX(turn_index), -1) + 1, $3, $4
           FROM run_turns
          WHERE thread_id = $2
         RETURNING *`,
        [input.id, input.thread_id, input.kind, input.payload],
      )).map(normalizeRunTurn),
    );
    if (!row) throw new Error(`appendRunTurn: failed to re-read row ${input.id}`);
    return row;
  }

  async updateRunThread(
    id: string,
    patch: { title?: string | null },
  ): Promise<RunThreadRecord | undefined> {
    const rows =
      patch.title !== undefined
        ? await this.query(
            `UPDATE run_threads
                SET title = $1,
                    updated_at = now()
              WHERE id = $2
              RETURNING *`,
            [patch.title, id],
          )
        : await this.query(
            `UPDATE run_threads
                SET updated_at = now()
              WHERE id = $1
              RETURNING *`,
            [id],
          );
    return one(rows.map(normalizeRunThread));
  }

  async createAgentToken(input: AgentTokenRecord): Promise<AgentTokenRecord> {
    const row = one(
      (await this.query(
        `INSERT INTO agent_tokens
           (id, prefix, hash, label, scope, workspace_id, user_id, created_at,
            last_used_at, revoked_at, rate_limit_per_minute)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
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
        ],
      )).map(normalizeAgentToken),
    );
    if (!row) throw new Error(`createAgentToken: failed to re-read row ${input.id}`);
    return row;
  }

  async listAgentTokensForUser(user_id: string, ctx?: SessionContext): Promise<AgentTokenRecord[]> {
    if (ctx?.workspace_id) {
      return (
        await this.query(
          `SELECT * FROM agent_tokens
            WHERE user_id = $1
              AND workspace_id = $2
            ORDER BY created_at DESC`,
          [user_id, ctx.workspace_id],
        )
      ).map(normalizeAgentToken);
    }
    return (
      await this.query(
        `SELECT * FROM agent_tokens
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [user_id],
      )
    ).map(normalizeAgentToken);
  }

  async getAgentTokenForUser(
    id: string,
    user_id: string,
  ): Promise<AgentTokenRecord | undefined> {
    return one(
      (await this.query(
        'SELECT * FROM agent_tokens WHERE id = $1 AND user_id = $2',
        [id, user_id],
      )).map(normalizeAgentToken),
    );
  }

  async revokeAgentTokenForUser(
    id: string,
    user_id: string,
    revoked_at: string,
  ): Promise<AgentTokenRecord | undefined> {
    return one(
      (await this.query(
        `UPDATE agent_tokens
            SET revoked_at = COALESCE(revoked_at, $1)
          WHERE id = $2
            AND user_id = $3
          RETURNING *`,
        [revoked_at, id, user_id],
      )).map(normalizeAgentToken),
    );
  }

  async createJob(
    input: Omit<
      JobRecord,
      'created_at' | 'started_at' | 'finished_at' | 'attempts' | 'status'
    > & { status?: JobStatus },
  ): Promise<JobRecord> {
    const normalized = normalizeCreateJobInput(input);
    await this.execute(
      `INSERT INTO jobs (
         id, slug, app_id, action, status, input_json, output_json, error_json,
         run_id, webhook_url, timeout_ms, max_retries, attempts, per_call_secrets_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
         $9, $10, $11, $12, $13, $14::jsonb
       )`,
      [
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
      ],
    );
    const row = await this.getJob(normalized.id);
    if (!row) throw new Error(`createJob: failed to re-read row ${normalized.id}`);
    return row;
  }

  async getJob(id: string): Promise<JobRecord | undefined> {
    return one((await this.query('SELECT * FROM jobs WHERE id = $1', [id])).map(normalizeJob));
  }

  async claimNextJob(): Promise<JobRecord | undefined> {
    const rows = (await this.query(
      `WITH next AS (
         SELECT id FROM jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE jobs
          SET status = 'running',
              started_at = now(),
              attempts = jobs.attempts + 1
         FROM next
        WHERE jobs.id = next.id
        RETURNING jobs.*`,
      [],
    )).map(normalizeJob);
    return one(rows);
  }

  async updateJob(id: string, patch: Partial<JobRecord>): Promise<void> {
    const keys = Object.keys(patch).filter((key) => key !== 'id');
    assertColumns('jobs', keys, JOB_COLUMNS);
    if (keys.length === 0) return;
    const values = keys.map((key) =>
      JOB_JSON_COLUMNS.has(key)
        ? toNullableJson((patch as Record<string, unknown>)[key])
        : (patch as Record<string, unknown>)[key],
    );
    values.push(id);
    const set = keys
      .map((key, index) =>
        JOB_JSON_COLUMNS.has(key) ? `${key} = $${index + 1}::jsonb` : `${key} = $${index + 1}`,
      )
      .join(', ');
    await this.execute(`UPDATE jobs SET ${set} WHERE id = $${values.length}`, values);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | undefined> {
    return one(
      (await this.query('SELECT id, slug, name, plan, wrapped_dek, created_at FROM workspaces WHERE id = $1', [
        id,
      ])).map(normalizeWorkspace),
    );
  }

  async getWorkspaceBySlug(slug: string): Promise<WorkspaceRecord | undefined> {
    return one(
      (await this.query(
        'SELECT id, slug, name, plan, wrapped_dek, created_at FROM workspaces WHERE slug = $1',
        [slug],
      )).map(normalizeWorkspace),
    );
  }

  async createWorkspace(input: {
    id: string;
    slug: string;
    name: string;
    plan: string;
  }): Promise<WorkspaceRecord> {
    const row = one(
      (await this.query(
        `INSERT INTO workspaces (id, slug, name, plan)
         VALUES ($1, $2, $3, $4)
         RETURNING id, slug, name, plan, wrapped_dek, created_at`,
        [input.id, input.slug, input.name, input.plan],
      )).map(normalizeWorkspace),
    );
    if (!row) throw new Error(`createWorkspace: failed to re-read row ${input.id}`);
    return row;
  }

  async updateWorkspace(
    id: string,
    patch: Partial<Pick<WorkspaceRecord, 'name' | 'slug' | 'plan' | 'wrapped_dek'>>,
  ): Promise<WorkspaceRecord | undefined> {
    const keys = Object.keys(patch);
    assertColumns('workspaces', keys, new Set(['name', 'slug', 'plan', 'wrapped_dek']));
    if (keys.length === 0) return this.getWorkspace(id);
    const values = keys.map((key) => (patch as Record<string, unknown>)[key]);
    values.push(id);
    const set = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    return one(
      (await this.query(
        `UPDATE workspaces SET ${set}
          WHERE id = $${values.length}
          RETURNING id, slug, name, plan, wrapped_dek, created_at`,
        values,
      )).map(normalizeWorkspace),
    );
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const result = await this.execute('DELETE FROM workspaces WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async listWorkspacesForUser(
    user_id: string,
    ctx?: SessionContext,
  ): Promise<Array<WorkspaceRecord & { role: WorkspaceRole }>> {
    if (ctx?.workspace_id) {
      return (await this.query(
        `SELECT w.id, w.slug, w.name, w.plan, w.wrapped_dek, w.created_at, m.role
           FROM workspaces w
           INNER JOIN workspace_members m ON m.workspace_id = w.id
          WHERE m.user_id = $1
            AND w.id = $2
          ORDER BY w.created_at ASC`,
        [user_id, ctx.workspace_id],
      )).map(normalizeWorkspaceWithRole);
    }
    return (await this.query(
      `SELECT w.id, w.slug, w.name, w.plan, w.wrapped_dek, w.created_at, m.role
         FROM workspaces w
         INNER JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = $1
        ORDER BY w.created_at ASC`,
      [user_id],
    )).map(normalizeWorkspaceWithRole);
  }

  async addUserToWorkspace(
    workspace_id: string,
    user_id: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberRecord> {
    const row = one(
      (await this.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING *`,
        [workspace_id, user_id, role],
      )).map(normalizeWorkspaceMember),
    );
    if (!row) throw new Error(`addUserToWorkspace: failed to re-read ${workspace_id}:${user_id}`);
    return row;
  }

  async updateWorkspaceMemberRole(
    workspace_id: string,
    user_id: string,
    role: WorkspaceMemberRole,
  ): Promise<WorkspaceMemberRecord | undefined> {
    return one(
      (await this.query(
        `UPDATE workspace_members
            SET role = $1
          WHERE workspace_id = $2 AND user_id = $3
          RETURNING *`,
        [role, workspace_id, user_id],
      )).map(normalizeWorkspaceMember),
    );
  }

  async removeUserFromWorkspace(workspace_id: string, user_id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await this.ensureReady();
      await client.query('BEGIN');
      const result = await client.query(
        'DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
        [workspace_id, user_id],
      );
      await client.query(
        'DELETE FROM user_active_workspace WHERE user_id = $1 AND workspace_id = $2',
        [user_id, workspace_id],
      );
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getWorkspaceMemberRole(
    workspace_id: string,
    user_id: string,
  ): Promise<WorkspaceMemberRole | null> {
    const row = one(await this.query(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspace_id, user_id],
    ));
    if (!row || typeof row.role !== 'string') return null;
    return row.role === 'admin' || row.role === 'editor' || row.role === 'viewer'
      ? row.role
      : 'viewer';
  }

  async countWorkspaceAdmins(workspace_id: string): Promise<number> {
    const row = one(await this.query(
      `SELECT COUNT(*) AS c FROM workspace_members
        WHERE workspace_id = $1 AND role = 'admin'`,
      [workspace_id],
    ));
    return Number(row?.c || 0);
  }

  async listWorkspaceMembers(workspace_id: string, ctx?: SessionContext): Promise<WorkspaceMemberWithUserRecord[]> {
    if (ctx?.workspace_id && workspace_id !== ctx.workspace_id) return [];
    return (await this.query(
      `SELECT m.workspace_id, m.user_id, m.role, m.joined_at, u.email, u.name
         FROM workspace_members m
         LEFT JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY m.joined_at ASC`,
      [workspace_id],
    )).map(normalizeWorkspaceMemberWithUser);
  }

  async getActiveWorkspaceId(user_id: string): Promise<string | null> {
    const row = one(await this.query(
      'SELECT workspace_id FROM user_active_workspace WHERE user_id = $1',
      [user_id],
    ));
    return typeof row?.workspace_id === 'string' ? row.workspace_id : null;
  }

  async setActiveWorkspace(user_id: string, workspace_id: string): Promise<void> {
    await this.execute(
      `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         updated_at = EXCLUDED.updated_at`,
      [user_id, workspace_id],
    );
  }

  async clearActiveWorkspaceForWorkspace(workspace_id: string): Promise<void> {
    await this.execute('DELETE FROM user_active_workspace WHERE workspace_id = $1', [workspace_id]);
  }

  async createWorkspaceInvite(
    input: Omit<WorkspaceInviteRecord, 'created_at' | 'accepted_at'>,
  ): Promise<WorkspaceInviteRecord> {
    const row = one(
      (await this.query(
        `INSERT INTO workspace_invites
           (id, workspace_id, email, role, invited_by_user_id, token, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          input.id,
          input.workspace_id,
          input.email,
          input.role,
          input.invited_by_user_id,
          input.token,
          input.status,
          input.expires_at,
        ],
      )).map(normalizeWorkspaceInvite),
    );
    if (!row) throw new Error(`createWorkspaceInvite: failed to re-read row ${input.id}`);
    return row;
  }

  async getPendingWorkspaceInviteByToken(token: string): Promise<WorkspaceInviteRecord | undefined> {
    return one(
      (await this.query(
        `SELECT * FROM workspace_invites WHERE token = $1 AND status = 'pending'`,
        [token],
      )).map(normalizeWorkspaceInvite),
    );
  }

  async listWorkspaceInvites(workspace_id: string, ctx?: SessionContext): Promise<WorkspaceInviteRecord[]> {
    if (ctx?.workspace_id && workspace_id !== ctx.workspace_id) return [];
    return (await this.query(
      `SELECT * FROM workspace_invites
        WHERE workspace_id = $1
        ORDER BY created_at DESC`,
      [workspace_id],
    )).map(normalizeWorkspaceInvite);
  }

  async deletePendingWorkspaceInvites(workspace_id: string, email: string): Promise<number> {
    const result = await this.execute(
      `DELETE FROM workspace_invites
        WHERE workspace_id = $1 AND email = $2 AND status = 'pending'`,
      [workspace_id, email],
    );
    return result.rowCount;
  }

  async markWorkspaceInviteStatus(id: string, status: WorkspaceInviteRecord['status']): Promise<void> {
    await this.execute('UPDATE workspace_invites SET status = $1 WHERE id = $2', [status, id]);
  }

  async acceptWorkspaceInvite(id: string): Promise<void> {
    await this.execute(
      `UPDATE workspace_invites
          SET status = 'accepted',
              accepted_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  async revokeWorkspaceInvite(workspace_id: string, invite_id: string): Promise<boolean> {
    const result = await this.execute(
      `UPDATE workspace_invites
          SET status = 'revoked'
        WHERE id = $1 AND workspace_id = $2 AND status = 'pending'`,
      [invite_id, workspace_id],
    );
    return result.rowCount > 0;
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    return one(
      (await this.query(
        `SELECT id, workspace_id, email, name, auth_provider, auth_subject, image,
                is_admin, deleted_at, delete_at, composio_user_id, created_at
           FROM users WHERE id = $1`,
        [id],
      )).map(normalizeUser),
    );
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    return one(
      (await this.query(
        `SELECT id, workspace_id, email, name, auth_provider, auth_subject, image,
                is_admin, deleted_at, delete_at, composio_user_id, created_at
           FROM users WHERE email = $1`,
        [email],
      )).map(normalizeUser),
    );
  }

  async findUserByUsername(
    username: string,
  ): Promise<Pick<UserRecord, 'id' | 'email' | 'name'> | undefined> {
    const normalized = username.trim().replace(/^@/, '').toLowerCase();
    if (!normalized) return undefined;
    return one(await this.query(
      `SELECT id, email, name
         FROM users
        WHERE LOWER(name) = $1
           OR LOWER(email) = $1
           OR LOWER(split_part(email, '@', 1)) = $1
        LIMIT 1`,
      [normalized],
    )) as Pick<UserRecord, 'id' | 'email' | 'name'> | undefined;
  }

  async searchUsers(
    query: string,
    limit = 10,
  ): Promise<Array<Pick<UserRecord, 'id' | 'email' | 'name'>>> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (await this.query(
      `SELECT id, email, name
         FROM users
        WHERE LOWER(COALESCE(name, '')) LIKE $1
           OR LOWER(COALESCE(email, '')) LIKE $1
        ORDER BY name, email
        LIMIT $2`,
      [`%${q}%`, nonNegativeInt(limit)],
    )) as Array<Pick<UserRecord, 'id' | 'email' | 'name'>>;
  }

  async createUser(input: UserWriteInput): Promise<UserRecord> {
    const keys = userInsertKeys(input);
    const values = keys.map((key) => input[key]);
    const columns = keys.join(', ');
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
    await this.execute(`INSERT INTO users (${columns}) VALUES (${placeholders})`, values);
    const row = await this.getUser(input.id);
    if (!row) throw new Error(`createUser: failed to re-read row ${input.id}`);
    return row;
  }

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
    const values = keys.map((key) => input[key]);
    const columns = keys.join(', ');
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
    const updates =
      updateColumns.length > 0
        ? `DO UPDATE SET ${updateColumns
            .map((column) => `${column} = EXCLUDED.${column}`)
            .join(', ')}`
        : 'DO NOTHING';
    await this.execute(
      `INSERT INTO users (${columns}) VALUES (${placeholders})
       ON CONFLICT (id) ${updates}`,
      values,
    );
    const row = await this.getUser(input.id);
    if (!row) throw new Error(`upsertUser: failed to re-read row ${input.id}`);
    return row;
  }

  async getAppMemory(
    row: Pick<AppMemoryRecord, 'workspace_id' | 'app_slug' | 'user_id' | 'key'>,
  ): Promise<AppMemoryRecord | undefined> {
    return one(
      (await this.query(
        `SELECT * FROM app_memory
          WHERE workspace_id = $1
            AND app_slug = $2
            AND user_id = $3
            AND key = $4`,
        [row.workspace_id, row.app_slug, row.user_id, row.key],
      )).map(normalizeAppMemory),
    );
  }

  async upsertAppMemory(
    input: Omit<AppMemoryRecord, 'updated_at'>,
  ): Promise<AppMemoryRecord> {
    const row = one(
      (await this.query(
        `INSERT INTO app_memory (workspace_id, app_slug, user_id, device_id, key, value, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (workspace_id, app_slug, user_id, key)
           DO UPDATE SET value = EXCLUDED.value,
                         device_id = COALESCE(EXCLUDED.device_id, app_memory.device_id),
                         updated_at = now()
         RETURNING *`,
        [
          input.workspace_id,
          input.app_slug,
          input.user_id,
          input.device_id,
          input.key,
          input.value,
        ],
      )).map(normalizeAppMemory),
    );
    if (!row) throw new Error(`upsertAppMemory: failed to re-read ${input.app_slug}:${input.key}`);
    return row;
  }

  async deleteAppMemory(
    row: Pick<AppMemoryRecord, 'workspace_id' | 'app_slug' | 'user_id' | 'key'>,
  ): Promise<boolean> {
    const result = await this.execute(
      `DELETE FROM app_memory
        WHERE workspace_id = $1
          AND app_slug = $2
          AND user_id = $3
          AND key = $4`,
      [row.workspace_id, row.app_slug, row.user_id, row.key],
    );
    return result.rowCount > 0;
  }

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
    const keyClause = keys && keys.length > 0 ? ` AND key = ANY($4::text[])` : '';
    if (keys && keys.length > 0) params.push(keys);
    return (await this.query(
      `SELECT * FROM app_memory
        WHERE workspace_id = $1
          AND app_slug = $2
          AND user_id = $3${keyClause}
        ORDER BY key`,
      params,
    )).map(normalizeAppMemory);
  }

  async listConnections(input: {
    workspace_id: string;
    owner_kind: ConnectionOwnerKind;
    owner_id: string;
    status?: ConnectionStatus;
  }, ctx?: SessionContext): Promise<ConnectionRecord[]> {
    if (ctx?.workspace_id && input.workspace_id !== ctx.workspace_id) return [];
    const params: unknown[] = [input.workspace_id, input.owner_kind, input.owner_id];
    const statusClause = input.status ? ` AND status = $4` : '';
    if (input.status) params.push(input.status);
    return (await this.query(
      `SELECT * FROM connections
        WHERE workspace_id = $1
          AND owner_kind = $2
          AND owner_id = $3${statusClause}
        ORDER BY provider`,
      params,
    )).map(normalizeConnection);
  }

  async getConnection(id: string): Promise<ConnectionRecord | undefined> {
    return one((await this.query('SELECT * FROM connections WHERE id = $1', [id])).map(normalizeConnection));
  }

  async getConnectionByOwnerProvider(input: {
    workspace_id: string;
    owner_kind: ConnectionOwnerKind;
    owner_id: string;
    provider: string;
  }): Promise<ConnectionRecord | undefined> {
    return one((await this.query(
      `SELECT * FROM connections
        WHERE workspace_id = $1
          AND owner_kind = $2
          AND owner_id = $3
          AND provider = $4`,
      [input.workspace_id, input.owner_kind, input.owner_id, input.provider],
    )).map(normalizeConnection));
  }

  async getConnectionByOwnerComposioId(input: {
    workspace_id: string;
    owner_kind: ConnectionOwnerKind;
    owner_id: string;
    composio_connection_id: string;
  }): Promise<ConnectionRecord | undefined> {
    return one((await this.query(
      `SELECT * FROM connections
        WHERE workspace_id = $1
          AND owner_kind = $2
          AND owner_id = $3
          AND composio_connection_id = $4`,
      [input.workspace_id, input.owner_kind, input.owner_id, input.composio_connection_id],
    )).map(normalizeConnection));
  }

  async upsertConnection(
    input: Omit<ConnectionRecord, 'created_at' | 'updated_at'>,
  ): Promise<ConnectionRecord> {
    const row = one((await this.query(
      `INSERT INTO connections
         (id, workspace_id, owner_kind, owner_id, provider,
          composio_connection_id, composio_account_id, status, metadata_json,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())
       ON CONFLICT (workspace_id, owner_kind, owner_id, provider)
         DO UPDATE SET composio_connection_id = EXCLUDED.composio_connection_id,
                       composio_account_id = EXCLUDED.composio_account_id,
                       status = EXCLUDED.status,
                       metadata_json = EXCLUDED.metadata_json,
                       updated_at = now()
       RETURNING *`,
      [
        input.id,
        input.workspace_id,
        input.owner_kind,
        input.owner_id,
        input.provider,
        input.composio_connection_id,
        input.composio_account_id,
        input.status,
        input.metadata_json,
      ],
    )).map(normalizeConnection));
    if (!row) throw new Error(`upsertConnection: failed to re-read ${input.provider}`);
    return row;
  }

  async updateConnection(
    id: string,
    patch: Partial<Pick<ConnectionRecord, 'status' | 'metadata_json' | 'composio_connection_id' | 'composio_account_id'>>,
  ): Promise<ConnectionRecord | undefined> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return this.getConnection(id);
    const values = keys.map((key) => (patch as Record<string, unknown>)[key]);
    values.push(id);
    const set = keys
      .map((key, index) =>
        key === 'metadata_json' ? `${key} = $${index + 1}::jsonb` : `${key} = $${index + 1}`,
      )
      .join(', ');
    return one((await this.query(
      `UPDATE connections SET ${set}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    )).map(normalizeConnection));
  }

  async deleteConnection(id: string): Promise<boolean> {
    const result = await this.execute('DELETE FROM connections WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async getLinkShareByAppSlug(slug: string): Promise<LinkShareRecord | undefined> {
    return one((await this.query(
      `SELECT id AS app_id, slug AS app_slug, visibility, link_share_token,
              link_share_requires_auth, updated_at
         FROM apps
        WHERE slug = $1`,
      [slug],
    )).map(normalizeLinkShare));
  }

  async updateAppSharing(
    app_id: string,
    patch: Partial<Pick<AppRecord, 'visibility' | 'link_share_token' | 'link_share_requires_auth' | 'publish_status' | 'review_submitted_at' | 'review_decided_at' | 'review_decided_by' | 'review_comment'>>,
  ): Promise<AppRecord | undefined> {
    const keys = Object.keys(patch);
    assertColumns('apps', keys, APP_COLUMNS);
    if (keys.length === 0) return this.getAppById(app_id);
    const values = keys.map((key) =>
      APP_SHARING_BOOLEAN_COLUMNS.has(key)
        ? Boolean((patch as Record<string, unknown>)[key])
        : (patch as Record<string, unknown>)[key],
    );
    values.push(app_id);
    const set = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    return one((await this.query(
      `UPDATE apps SET ${set}, updated_at = now()
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    )).map(normalizeApp));
  }

  async createVisibilityAudit(
    input: Omit<VisibilityAuditRecord, 'created_at'>,
  ): Promise<VisibilityAuditRecord> {
    const row = one((await this.query(
      `INSERT INTO app_visibility_audit
         (id, app_id, from_state, to_state, actor_user_id, reason, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.id,
        input.app_id,
        input.from_state,
        input.to_state,
        input.actor_user_id,
        input.reason,
        input.metadata,
      ],
    )).map(normalizeVisibilityAudit));
    if (!row) throw new Error(`createVisibilityAudit: failed to re-read row ${input.id}`);
    return row;
  }

  async listVisibilityAudit(app_id?: string | null, ctx?: SessionContext): Promise<VisibilityAuditRecord[]> {
    if (app_id) {
      if (ctx?.workspace_id) {
        return (await this.query(
          `SELECT app_visibility_audit.*
             FROM app_visibility_audit
             INNER JOIN apps ON apps.id = app_visibility_audit.app_id
            WHERE app_visibility_audit.app_id = $1
              AND apps.workspace_id = $2
            ORDER BY app_visibility_audit.created_at DESC`,
          [app_id, ctx.workspace_id],
        )).map(normalizeVisibilityAudit);
      }
      return (await this.query(
        `SELECT * FROM app_visibility_audit
          WHERE app_id = $1
          ORDER BY created_at DESC`,
        [app_id],
      )).map(normalizeVisibilityAudit);
    }
    if (ctx?.workspace_id) {
      return (await this.query(
        `SELECT app_visibility_audit.*
           FROM app_visibility_audit
           INNER JOIN apps ON apps.id = app_visibility_audit.app_id
          WHERE apps.workspace_id = $1
          ORDER BY app_visibility_audit.created_at DESC
          LIMIT 200`,
        [ctx.workspace_id],
      )).map(normalizeVisibilityAudit);
    }
    return (await this.query(
      `SELECT * FROM app_visibility_audit ORDER BY created_at DESC LIMIT 200`,
      [],
    )).map(normalizeVisibilityAudit);
  }

  async listAppInvites(app_id: string, ctx?: SessionContext): Promise<AppInviteRecord[]> {
    const workspaceClause = ctx?.workspace_id ? ' AND apps.workspace_id = $2' : '';
    const params = ctx?.workspace_id ? [app_id, ctx.workspace_id] : [app_id];
    return (await this.query(
      `SELECT app_invites.*,
              users.name AS invited_user_name,
              users.email AS invited_user_email
         FROM app_invites
         INNER JOIN apps ON apps.id = app_invites.app_id
         LEFT JOIN users ON users.id = app_invites.invited_user_id
        WHERE app_invites.app_id = $1${workspaceClause}
        ORDER BY app_invites.created_at DESC`,
      params,
    )).map(normalizeAppInvite);
  }

  async upsertAppInvite(
    input: Omit<AppInviteRecord, 'id' | 'created_at' | 'accepted_at' | 'revoked_at'> & { id: string },
  ): Promise<AppInviteRecord> {
    const existing = one((await this.query(
      `SELECT * FROM app_invites
        WHERE app_id = $1
          AND (
            ($2::text IS NOT NULL AND invited_user_id = $2)
            OR ($3::text IS NOT NULL AND LOWER(invited_email) = LOWER($3))
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.app_id, input.invited_user_id || null, input.invited_email || null],
    )).map(normalizeAppInvite));
    if (existing && !['revoked', 'declined'].includes(existing.state)) return existing;
    const row = one((await this.query(
      `INSERT INTO app_invites
         (id, app_id, invited_user_id, invited_email, state, invited_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.id,
        input.app_id,
        input.invited_user_id || null,
        input.invited_email || null,
        input.state,
        input.invited_by_user_id,
      ],
    )).map(normalizeAppInvite));
    if (!row) throw new Error(`upsertAppInvite: failed to re-read row ${input.id}`);
    return row;
  }

  async revokeAppInvite(invite_id: string, app_id: string): Promise<AppInviteRecord | undefined> {
    const existing = one((await this.query(
      'SELECT * FROM app_invites WHERE id = $1 AND app_id = $2',
      [invite_id, app_id],
    )).map(normalizeAppInvite));
    if (!existing) return undefined;
    if (existing.state === 'revoked') return existing;
    return one((await this.query(
      `UPDATE app_invites
          SET state = 'revoked',
              revoked_at = now()
        WHERE id = $1
        RETURNING *`,
      [invite_id],
    )).map(normalizeAppInvite));
  }

  async acceptAppInvite(invite_id: string, user_id: string): Promise<{ invite: AppInviteRecord | undefined; changed: boolean }> {
    const existing = one((await this.query(
      'SELECT * FROM app_invites WHERE id = $1',
      [invite_id],
    )).map(normalizeAppInvite));
    if (!existing || existing.invited_user_id !== user_id) return { invite: undefined, changed: false };
    if (existing.state === 'accepted') return { invite: existing, changed: false };
    if (existing.state !== 'pending_accept') return { invite: existing, changed: false };
    const invite = one((await this.query(
      `UPDATE app_invites
          SET state = 'accepted',
              accepted_at = now()
        WHERE id = $1
        RETURNING *`,
      [invite_id],
    )).map(normalizeAppInvite));
    return { invite, changed: true };
  }

  async declineAppInvite(invite_id: string, user_id: string): Promise<AppInviteRecord | undefined> {
    const existing = one((await this.query(
      'SELECT * FROM app_invites WHERE id = $1',
      [invite_id],
    )).map(normalizeAppInvite));
    if (!existing || existing.invited_user_id !== user_id) return undefined;
    if (existing.state === 'accepted' || existing.state === 'pending_accept') {
      return one((await this.query(
        `UPDATE app_invites SET state = 'declined' WHERE id = $1 RETURNING *`,
        [invite_id],
      )).map(normalizeAppInvite));
    }
    return existing;
  }

  async linkPendingEmailAppInvites(user_id: string, email: string): Promise<number> {
    const result = await this.execute(
      `UPDATE app_invites
          SET invited_user_id = $1,
              state = 'pending_accept'
        WHERE state = 'pending_email'
          AND LOWER(invited_email) = LOWER($2)`,
      [user_id, email],
    );
    return result.rowCount;
  }

  async listPendingAppInvitesForUser(user_id: string, ctx?: SessionContext): Promise<AppInviteRecord[]> {
    const workspaceClause = ctx?.workspace_id ? ' AND apps.workspace_id = $2' : '';
    const params = ctx?.workspace_id ? [user_id, ctx.workspace_id] : [user_id];
    return (await this.query(
      `SELECT app_invites.*,
              apps.slug AS app_slug,
              apps.name AS app_name,
              apps.description AS app_description
         FROM app_invites
         JOIN apps ON apps.id = app_invites.app_id
        WHERE app_invites.invited_user_id = $1
          AND app_invites.state = 'pending_accept'${workspaceClause}
        ORDER BY app_invites.created_at DESC`,
      params,
    )).map(normalizeAppInvite);
  }

  async userHasAcceptedAppInvite(app_id: string, user_id: string): Promise<boolean> {
    const row = one(await this.query(
      `SELECT 1 AS ok
         FROM app_invites
        WHERE app_id = $1
          AND invited_user_id = $2
          AND state = 'accepted'
        LIMIT 1`,
      [app_id, user_id],
    ));
    return Boolean(row);
  }

  async createTrigger(input: TriggerRecord): Promise<TriggerRecord> {
    const row = one((await this.query(
      `INSERT INTO triggers (
         id, app_id, user_id, workspace_id, action, inputs, trigger_type,
         cron_expression, tz, webhook_secret, webhook_url_path, next_run_at,
         last_fired_at, enabled, retry_policy, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12,
         $13, $14, $15::jsonb, $16, $17
       )
       RETURNING *`,
      [
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
        Boolean(input.enabled),
        input.retry_policy,
        input.created_at,
        input.updated_at,
      ],
    )).map(normalizeTrigger));
    if (!row) throw new Error(`createTrigger: failed to re-read row ${input.id}`);
    return row;
  }

  async getTrigger(id: string): Promise<TriggerRecord | undefined> {
    return one((await this.query('SELECT * FROM triggers WHERE id = $1', [id])).map(normalizeTrigger));
  }

  async getTriggerByWebhookPath(path: string): Promise<TriggerRecord | undefined> {
    return one((await this.query('SELECT * FROM triggers WHERE webhook_url_path = $1', [path])).map(normalizeTrigger));
  }

  async listTriggersForUser(user_id: string, ctx?: SessionContext): Promise<TriggerRecord[]> {
    if (ctx?.workspace_id) {
      return (await this.query(
        `SELECT * FROM triggers
          WHERE user_id = $1
            AND workspace_id = $2
          ORDER BY created_at DESC`,
        [user_id, ctx.workspace_id],
      )).map(normalizeTrigger);
    }
    return (await this.query(
      'SELECT * FROM triggers WHERE user_id = $1 ORDER BY created_at DESC',
      [user_id],
    )).map(normalizeTrigger);
  }

  async listTriggersForApp(app_id: string, ctx?: SessionContext): Promise<TriggerRecord[]> {
    if (ctx?.workspace_id) {
      return (await this.query(
        `SELECT * FROM triggers
          WHERE app_id = $1
            AND workspace_id = $2
          ORDER BY created_at DESC`,
        [app_id, ctx.workspace_id],
      )).map(normalizeTrigger);
    }
    return (await this.query(
      'SELECT * FROM triggers WHERE app_id = $1 ORDER BY created_at DESC',
      [app_id],
    )).map(normalizeTrigger);
  }

  async listDueTriggers(now_ms: number, ctx?: SessionContext): Promise<TriggerRecord[]> {
    const workspaceClause = ctx?.workspace_id ? ' AND workspace_id = $2' : '';
    const params = ctx?.workspace_id ? [now_ms, ctx.workspace_id] : [now_ms];
    return (await this.query(
      `SELECT * FROM triggers
        WHERE trigger_type = 'schedule'
          AND enabled = true
          AND next_run_at IS NOT NULL
          AND next_run_at <= $1${workspaceClause}
        ORDER BY next_run_at ASC`,
      params,
    )).map(normalizeTrigger);
  }

  async updateTrigger(id: string, patch: Partial<TriggerRecord>): Promise<TriggerRecord | undefined> {
    const keys = Object.keys(patch).filter((key) => key !== 'id');
    if (keys.length === 0) return this.getTrigger(id);
    const values = keys.map((key) => {
      const value = (patch as Record<string, unknown>)[key];
      if (key === 'inputs' || key === 'retry_policy') return toNullableJson(value);
      if (key === 'enabled') return Boolean(value);
      return value;
    });
    values.push(id);
    const set = keys.map((key, index) =>
      key === 'inputs' || key === 'retry_policy'
        ? `${key} = $${index + 1}::jsonb`
        : `${key} = $${index + 1}`,
    ).join(', ');
    return one((await this.query(
      `UPDATE triggers SET ${set}
        WHERE id = $${values.length}
        RETURNING *`,
      values,
    )).map(normalizeTrigger));
  }

  async deleteTrigger(id: string): Promise<boolean> {
    const result = await this.execute('DELETE FROM triggers WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  async markTriggerFired(id: string, now_ms: number): Promise<void> {
    await this.execute(
      `UPDATE triggers SET last_fired_at = $1, updated_at = $1 WHERE id = $2`,
      [now_ms, id],
    );
  }

  async advanceTriggerSchedule(
    id: string,
    next_run_at: number,
    now_ms: number,
    expected_next_run_at?: number | null,
    fire = true,
  ): Promise<boolean> {
    const values: unknown[] = [next_run_at, now_ms, id];
    const fireSet = fire ? ', last_fired_at = $2' : '';
    let where = 'id = $3';
    if (expected_next_run_at !== undefined) {
      values.push(expected_next_run_at);
      where += ` AND next_run_at IS NOT DISTINCT FROM $4`;
    }
    const result = await this.execute(
      `UPDATE triggers
          SET next_run_at = $1${fireSet},
              updated_at = $2
        WHERE ${where}`,
      values,
    );
    return result.rowCount > 0;
  }

  async recordTriggerWebhookDelivery(
    trigger_id: string,
    request_id: string,
    now_ms: number,
    ttl_ms: number,
  ): Promise<boolean> {
    await this.execute('DELETE FROM trigger_webhook_deliveries WHERE received_at < $1', [
      now_ms - ttl_ms,
    ]);
    const result = await this.execute(
      `INSERT INTO trigger_webhook_deliveries (trigger_id, request_id, received_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (trigger_id, request_id) DO NOTHING`,
      [trigger_id, request_id, now_ms],
    );
    return result.rowCount > 0;
  }

  async listAdminSecrets(app_id?: string | null, _ctx?: SessionContext): Promise<SecretRecord[]> {
    if (app_id === undefined) {
      return (await this.query('SELECT * FROM secrets ORDER BY name', [])).map(normalizeSecret);
    }
    if (app_id === null) {
      return (await this.query(
        'SELECT * FROM secrets WHERE app_id IS NULL ORDER BY name',
        [],
      )).map(normalizeSecret);
    }
    return (await this.query(
      'SELECT * FROM secrets WHERE app_id = $1 ORDER BY name',
      [app_id],
    )).map(normalizeSecret);
  }

  async upsertAdminSecret(
    name: string,
    value: string,
    app_id?: string | null,
  ): Promise<void> {
    await this.execute(
      `INSERT INTO secrets (id, name, value, app_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, (COALESCE(app_id, '__global__')))
       DO UPDATE SET value = EXCLUDED.value`,
      [randomUUID(), name, value, app_id ?? null],
    );
  }

  async deleteAdminSecret(name: string, app_id?: string | null): Promise<boolean> {
    const result =
      app_id === null || app_id === undefined
        ? await this.execute('DELETE FROM secrets WHERE name = $1 AND app_id IS NULL', [name])
        : await this.execute('DELETE FROM secrets WHERE name = $1 AND app_id = $2', [
            name,
            app_id,
          ]);
    return result.rowCount > 0;
  }

  async getEncryptedSecret(
    ctx: { workspace_id: string },
    key: string,
  ): Promise<EncryptedSecretRecord | undefined> {
    return one(
      (await this.query(
        `SELECT workspace_id, key, ciphertext, nonce, auth_tag, encrypted_dek,
                created_at, updated_at
           FROM encrypted_secrets
          WHERE workspace_id = $1
            AND key = $2`,
        [ctx.workspace_id, key],
      )).map(normalizeEncryptedSecret),
    );
  }

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
    await this.execute(
      `INSERT INTO encrypted_secrets
         (workspace_id, key, ciphertext, nonce, auth_tag, encrypted_dek, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (workspace_id, key)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                     nonce = EXCLUDED.nonce,
                     auth_tag = EXCLUDED.auth_tag,
                     encrypted_dek = EXCLUDED.encrypted_dek,
                     updated_at = now()`,
      [
        ctx.workspace_id,
        key,
        payload.ciphertext,
        payload.nonce,
        payload.auth_tag,
        payload.encrypted_dek,
      ],
    );
  }

  async listEncryptedSecrets(
    ctx: { workspace_id: string },
  ): Promise<Array<{ key: string; updated_at: string }>> {
    return (await this.query(
      `SELECT key, updated_at
         FROM encrypted_secrets
        WHERE workspace_id = $1
        ORDER BY key`,
      [ctx.workspace_id],
    )).map((row) => ({
      key: String(row.key),
      updated_at: timestampColumnToString(row.updated_at),
    }));
  }

  async deleteEncryptedSecret(
    ctx: { workspace_id: string },
    key: string,
  ): Promise<boolean> {
    const result = await this.execute(
      `DELETE FROM encrypted_secrets
        WHERE workspace_id = $1
          AND key = $2`,
      [ctx.workspace_id, key],
    );
    return result.rowCount > 0;
  }

  private async query(
    sql: string,
    values: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    return (await this.execute(sql, values)).rows;
  }

  private async execute(sql: string, values: unknown[]): Promise<QueryResult> {
    await this.ensureReady();
    const result = await this.pool.query(sql, values);
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount ?? 0,
    };
  }

  private async ensureReady(): Promise<void> {
    if (!this.connectionString) {
      throw new Error(
        'Postgres StorageAdapter requires a connection string via createPostgresAdapter({ connectionString }) or DATABASE_URL',
      );
    }
    if (!this.schemaReady) {
      this.schemaReady = this.setupSchema ? this.setupDatabaseSchema() : Promise.resolve();
    }
    await this.schemaReady;
  }

  private async setupDatabaseSchema(): Promise<void> {
    const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    await this.pool.query(schemaSql);
  }

  private async refreshAppAvgRunMs(runId: string): Promise<void> {
    const row = one(await this.query('SELECT app_id FROM runs WHERE id = $1', [runId]));
    if (!row || typeof row.app_id !== 'string') return;
    const avgRow = one(
      await this.query(
        `SELECT AVG(duration_ms) AS avg_ms FROM (
           SELECT duration_ms FROM runs
            WHERE app_id = $1 AND status = 'success' AND duration_ms IS NOT NULL
            ORDER BY started_at DESC
            LIMIT 20
         ) recent`,
        [row.app_id],
      ),
    );
    const avg = avgRow?.avg_ms;
    if (typeof avg === 'number' && Number.isFinite(avg)) {
      await this.execute('UPDATE apps SET avg_run_ms = $1 WHERE id = $2', [
        Math.round(avg),
        row.app_id,
      ]);
    }
  }
}

export function createPostgresAdapter(
  opts: PostgresAdapterOptions,
): StorageAdapter {
  return new PostgresStorageAdapter(opts);
}

export const postgresStorageAdapter: StorageAdapter = createPostgresAdapter({
  connectionString:
    process.env.DATABASE_URL || process.env.FLOOM_DATABASE_URL || process.env.POSTGRES_URL || '',
});

export default {
  kind: 'storage' as const,
  name: 'postgres',
  protocolVersion: '^0.2',
  adapter: postgresStorageAdapter,
};

function assertColumns(
  table: string,
  columns: string[],
  allowed: Set<string>,
): void {
  for (const column of columns) {
    if (!allowed.has(column)) {
      throw new Error(`Unknown ${table} column: ${column}`);
    }
  }
}

function nonNegativeInt(value: number): number {
  return Math.max(0, Math.floor(value));
}

function one<T>(rows: T[]): T | undefined {
  return rows[0];
}

function appValueToDb(key: string, value: unknown): unknown {
  if (APP_BOOLEAN_COLUMNS.has(key)) return value === true || value === 1;
  return value;
}

function booleanToTinyInt(value: unknown): 0 | 1 {
  return value === true || value === 1 ? 1 : 0;
}

function toNullableJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function jsonColumnToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function timestampColumnToString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeApp(row: Record<string, unknown>): AppRecord {
  return {
    ...row,
    is_async: booleanToTinyInt(row.is_async),
    link_share_requires_auth: booleanToTinyInt(row.link_share_requires_auth),
    featured: booleanToTinyInt(row.featured),
    hero: booleanToTinyInt(row.hero),
    created_at: timestampColumnToString(row.created_at),
    updated_at: timestampColumnToString(row.updated_at),
  } as AppRecord;
}

function normalizeRun(row: Record<string, unknown>): RunRecord {
  const out: Record<string, unknown> = { ...row };
  for (const column of RUN_JSON_COLUMNS) {
    out[column] = jsonColumnToString(out[column]);
  }
  for (const column of RUN_BOOLEAN_COLUMNS) {
    out[column] = booleanToTinyInt(out[column]);
  }
  out.started_at = timestampColumnToString(out.started_at);
  out.finished_at =
    out.finished_at === null || out.finished_at === undefined
      ? null
      : timestampColumnToString(out.finished_at);
  return out as unknown as RunRecord;
}

function normalizeStudioAppSummary(row: Record<string, unknown>): StudioAppSummaryRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
    updated_at: timestampColumnToString(row.updated_at),
    last_run_at:
      row.last_run_at === null || row.last_run_at === undefined
        ? null
        : timestampColumnToString(row.last_run_at),
  } as StudioAppSummaryRecord;
}

function normalizeAppReview(row: Record<string, unknown>): AppReviewRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
    updated_at: timestampColumnToString(row.updated_at),
  } as AppReviewRecord;
}

function normalizeRunThread(row: Record<string, unknown>): RunThreadRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
    updated_at: timestampColumnToString(row.updated_at),
  } as RunThreadRecord;
}

function normalizeRunTurn(row: Record<string, unknown>): RunTurnRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
  } as RunTurnRecord;
}

function normalizeAgentToken(row: Record<string, unknown>): AgentTokenRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
    last_used_at:
      row.last_used_at === null || row.last_used_at === undefined
        ? null
        : timestampColumnToString(row.last_used_at),
    revoked_at:
      row.revoked_at === null || row.revoked_at === undefined
        ? null
        : timestampColumnToString(row.revoked_at),
  } as AgentTokenRecord;
}

function normalizeJob(row: Record<string, unknown>): JobRecord {
  const out: Record<string, unknown> = { ...row };
  for (const column of JOB_JSON_COLUMNS) {
    out[column] = jsonColumnToString(out[column]);
  }
  out.created_at = timestampColumnToString(out.created_at);
  out.started_at =
    out.started_at === null || out.started_at === undefined
      ? null
      : timestampColumnToString(out.started_at);
  out.finished_at =
    out.finished_at === null || out.finished_at === undefined
      ? null
      : timestampColumnToString(out.finished_at);
  return out as unknown as JobRecord;
}

function normalizeWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
  } as WorkspaceRecord;
}

function normalizeWorkspaceWithRole(
  row: Record<string, unknown>,
): WorkspaceRecord & { role: WorkspaceRole } {
  return normalizeWorkspace(row) as WorkspaceRecord & { role: WorkspaceRole };
}

function normalizeWorkspaceMember(row: Record<string, unknown>): WorkspaceMemberRecord {
  return {
    ...row,
    joined_at: timestampColumnToString(row.joined_at),
  } as WorkspaceMemberRecord;
}

function normalizeWorkspaceMemberWithUser(
  row: Record<string, unknown>,
): WorkspaceMemberWithUserRecord {
  return normalizeWorkspaceMember(row) as WorkspaceMemberWithUserRecord;
}

function normalizeWorkspaceInvite(row: Record<string, unknown>): WorkspaceInviteRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
    expires_at: timestampColumnToString(row.expires_at),
    accepted_at:
      row.accepted_at === null || row.accepted_at === undefined
        ? null
        : timestampColumnToString(row.accepted_at),
  } as WorkspaceInviteRecord;
}

function normalizeUser(row: Record<string, unknown>): UserRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
  } as UserRecord;
}

function normalizeAppMemory(row: Record<string, unknown>): AppMemoryRecord {
  return {
    ...row,
    updated_at: timestampColumnToString(row.updated_at),
  } as AppMemoryRecord;
}

function normalizeConnection(row: Record<string, unknown>): ConnectionRecord {
  return {
    ...row,
    metadata_json: jsonColumnToString(row.metadata_json),
    created_at: timestampColumnToString(row.created_at),
    updated_at: timestampColumnToString(row.updated_at),
  } as ConnectionRecord;
}

function normalizeLinkShare(row: Record<string, unknown>): LinkShareRecord {
  return {
    ...row,
    link_share_requires_auth: booleanToTinyInt(row.link_share_requires_auth),
    updated_at: timestampColumnToString(row.updated_at),
  } as LinkShareRecord;
}

function normalizeVisibilityAudit(row: Record<string, unknown>): VisibilityAuditRecord {
  return {
    ...row,
    metadata: jsonColumnToString(row.metadata),
    created_at: timestampColumnToString(row.created_at),
  } as VisibilityAuditRecord;
}

function normalizeAppInvite(row: Record<string, unknown>): AppInviteRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
    accepted_at:
      row.accepted_at === null || row.accepted_at === undefined
        ? null
        : timestampColumnToString(row.accepted_at),
    revoked_at:
      row.revoked_at === null || row.revoked_at === undefined
        ? null
        : timestampColumnToString(row.revoked_at),
  } as AppInviteRecord;
}

function normalizeTrigger(row: Record<string, unknown>): TriggerRecord {
  return {
    ...row,
    inputs: jsonColumnToString(row.inputs) || '{}',
    retry_policy: jsonColumnToString(row.retry_policy),
    enabled: booleanToTinyInt(row.enabled),
    next_run_at:
      row.next_run_at === null || row.next_run_at === undefined
        ? null
        : Number(row.next_run_at),
    last_fired_at:
      row.last_fired_at === null || row.last_fired_at === undefined
        ? null
        : Number(row.last_fired_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  } as TriggerRecord;
}

function normalizeSecret(row: Record<string, unknown>): SecretRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
  } as SecretRecord;
}

function normalizeEncryptedSecret(row: Record<string, unknown>): EncryptedSecretRecord {
  return {
    ...row,
    created_at: timestampColumnToString(row.created_at),
    updated_at: timestampColumnToString(row.updated_at),
  } as EncryptedSecretRecord;
}

function normalizeCreateJobInput(
  input: Omit<
    JobRecord,
    'created_at' | 'started_at' | 'finished_at' | 'attempts' | 'status'
  > & { status?: JobStatus },
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
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function userInsertKeys(input: UserWriteInput): Array<keyof UserWriteInput> {
  return (Object.keys(input) as Array<keyof UserWriteInput>).filter((key) => {
    if (!USER_WRITE_COLUMNS.has(key)) {
      throw new Error(`Unknown users column: ${String(key)}`);
    }
    return input[key] !== undefined;
  });
}
