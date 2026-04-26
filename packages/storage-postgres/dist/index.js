import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));
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
const RUN_JSON_COLUMNS = new Set(['inputs', 'outputs']);
const RUN_BOOLEAN_COLUMNS = new Set(['is_public']);
const JOB_JSON_COLUMNS = new Set([
    'input_json',
    'output_json',
    'error_json',
    'per_call_secrets_json',
]);
const USER_WRITE_COLUMNS = new Set([
    'id',
    'workspace_id',
    'email',
    'name',
    'auth_provider',
    'auth_subject',
    'image',
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
class PostgresStorageAdapter {
    pool;
    connectionString;
    setupSchema;
    schemaReady = null;
    constructor(opts) {
        this.connectionString = opts.connectionString;
        this.setupSchema = opts.setupSchema ?? true;
        this.pool = new Pool({
            connectionString: opts.connectionString || 'postgres://invalid',
            max: 10,
        });
    }
    async getApp(slug) {
        return one((await this.query('SELECT * FROM apps WHERE slug = $1', [slug])).map(normalizeApp));
    }
    async getAppById(id) {
        return one((await this.query('SELECT * FROM apps WHERE id = $1', [id])).map(normalizeApp));
    }
    async listApps(filter = {}) {
        const clauses = [];
        const params = [];
        if (filter.workspace_id) {
            params.push(filter.workspace_id);
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
    async createApp(input) {
        const keys = Object.keys(input).filter((key) => key !== 'created_at' && key !== 'updated_at');
        assertColumns('apps', keys, APP_COLUMNS);
        const values = keys.map((key) => appValueToDb(key, input[key]));
        const columns = keys.join(', ');
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
        await this.execute(`INSERT INTO apps (${columns}) VALUES (${placeholders})`, values);
        const row = await this.getAppById(input.id);
        if (!row)
            throw new Error(`createApp: failed to re-read row ${input.id}`);
        return row;
    }
    async updateApp(slug, patch) {
        const keys = Object.keys(patch).filter((key) => key !== 'slug');
        assertColumns('apps', keys, APP_COLUMNS);
        if (keys.length === 0)
            return this.getApp(slug);
        const values = keys.map((key) => appValueToDb(key, patch[key]));
        values.push(slug);
        const set = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
        await this.execute(`UPDATE apps SET ${set}, updated_at = now() WHERE slug = $${values.length}`, values);
        return this.getApp(slug);
    }
    async deleteApp(slug) {
        const row = one(await this.query('SELECT id FROM apps WHERE slug = $1', [slug]));
        if (!row || typeof row.id !== 'string')
            return false;
        const result = await this.execute('DELETE FROM apps WHERE id = $1', [row.id]);
        return result.rowCount > 0;
    }
    async createRun(input) {
        const app = await this.getAppById(input.app_id);
        await this.execute(`INSERT INTO runs (id, app_id, thread_id, action, inputs, status, workspace_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6)`, [
            input.id,
            input.app_id,
            input.thread_id ?? null,
            input.action,
            input.inputs === null ? null : JSON.stringify(input.inputs),
            app?.workspace_id ?? 'local',
        ]);
        const row = await this.getRun(input.id);
        if (!row)
            throw new Error(`createRun: failed to re-read row ${input.id}`);
        return row;
    }
    async getRun(id) {
        return one((await this.query('SELECT * FROM runs WHERE id = $1', [id])).map(normalizeRun));
    }
    async listRuns(filter = {}) {
        const clauses = [];
        const params = [];
        if (filter.app_id) {
            params.push(filter.app_id);
            clauses.push(`app_id = $${params.length}`);
        }
        if (filter.workspace_id) {
            params.push(filter.workspace_id);
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
    async updateRun(id, patch) {
        const cols = [];
        const values = [];
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
        if (patch.finished) {
            cols.push('finished_at = now()');
        }
        if (cols.length === 0)
            return;
        values.push(id);
        await this.execute(`UPDATE runs SET ${cols.join(', ')} WHERE id = $${values.length}`, values);
        if (patch.finished &&
            patch.status === 'success' &&
            typeof patch.duration_ms === 'number') {
            await this.refreshAppAvgRunMs(id);
        }
    }
    async createJob(input) {
        const normalized = normalizeCreateJobInput(input);
        await this.execute(`INSERT INTO jobs (
         id, slug, app_id, action, status, input_json, output_json, error_json,
         run_id, webhook_url, timeout_ms, max_retries, attempts, per_call_secrets_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
         $9, $10, $11, $12, $13, $14::jsonb
       )`, [
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
        ]);
        const row = await this.getJob(normalized.id);
        if (!row)
            throw new Error(`createJob: failed to re-read row ${normalized.id}`);
        return row;
    }
    async getJob(id) {
        return one((await this.query('SELECT * FROM jobs WHERE id = $1', [id])).map(normalizeJob));
    }
    async claimNextJob() {
        const rows = (await this.query(`WITH next AS (
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
        RETURNING jobs.*`, [])).map(normalizeJob);
        return one(rows);
    }
    async updateJob(id, patch) {
        const keys = Object.keys(patch).filter((key) => key !== 'id');
        assertColumns('jobs', keys, JOB_COLUMNS);
        if (keys.length === 0)
            return;
        const values = keys.map((key) => JOB_JSON_COLUMNS.has(key)
            ? toNullableJson(patch[key])
            : patch[key]);
        values.push(id);
        const set = keys
            .map((key, index) => JOB_JSON_COLUMNS.has(key) ? `${key} = $${index + 1}::jsonb` : `${key} = $${index + 1}`)
            .join(', ');
        await this.execute(`UPDATE jobs SET ${set} WHERE id = $${values.length}`, values);
    }
    async getWorkspace(id) {
        return one((await this.query('SELECT id, slug, name, plan, wrapped_dek, created_at FROM workspaces WHERE id = $1', [
            id,
        ])).map(normalizeWorkspace));
    }
    async listWorkspacesForUser(user_id) {
        return (await this.query(`SELECT w.id, w.slug, w.name, w.plan, w.wrapped_dek, w.created_at, m.role
         FROM workspaces w
         INNER JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = $1
        ORDER BY w.created_at ASC`, [user_id])).map(normalizeWorkspaceWithRole);
    }
    async getUser(id) {
        return one((await this.query(`SELECT id, workspace_id, email, name, auth_provider, auth_subject, created_at
           FROM users WHERE id = $1`, [id])).map(normalizeUser));
    }
    async getUserByEmail(email) {
        return one((await this.query(`SELECT id, workspace_id, email, name, auth_provider, auth_subject, created_at
           FROM users WHERE email = $1`, [email])).map(normalizeUser));
    }
    async createUser(input) {
        const keys = userInsertKeys(input);
        const values = keys.map((key) => input[key]);
        const columns = keys.join(', ');
        const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
        await this.execute(`INSERT INTO users (${columns}) VALUES (${placeholders})`, values);
        const row = await this.getUser(input.id);
        if (!row)
            throw new Error(`createUser: failed to re-read row ${input.id}`);
        return row;
    }
    async upsertUser(input, updateColumns) {
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
        const updates = updateColumns.length > 0
            ? `DO UPDATE SET ${updateColumns
                .map((column) => `${column} = EXCLUDED.${column}`)
                .join(', ')}`
            : 'DO NOTHING';
        await this.execute(`INSERT INTO users (${columns}) VALUES (${placeholders})
       ON CONFLICT (id) ${updates}`, values);
        const row = await this.getUser(input.id);
        if (!row)
            throw new Error(`upsertUser: failed to re-read row ${input.id}`);
        return row;
    }
    async listAdminSecrets(app_id) {
        if (app_id === undefined) {
            return (await this.query('SELECT * FROM secrets ORDER BY name', [])).map(normalizeSecret);
        }
        if (app_id === null) {
            return (await this.query('SELECT * FROM secrets WHERE app_id IS NULL ORDER BY name', [])).map(normalizeSecret);
        }
        return (await this.query('SELECT * FROM secrets WHERE app_id = $1 ORDER BY name', [app_id])).map(normalizeSecret);
    }
    async upsertAdminSecret(name, value, app_id) {
        await this.execute(`INSERT INTO secrets (id, name, value, app_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, (COALESCE(app_id, '__global__')))
       DO UPDATE SET value = EXCLUDED.value`, [randomUUID(), name, value, app_id ?? null]);
    }
    async deleteAdminSecret(name, app_id) {
        const result = app_id === null || app_id === undefined
            ? await this.execute('DELETE FROM secrets WHERE name = $1 AND app_id IS NULL', [name])
            : await this.execute('DELETE FROM secrets WHERE name = $1 AND app_id = $2', [
                name,
                app_id,
            ]);
        return result.rowCount > 0;
    }
    async query(sql, values) {
        return (await this.execute(sql, values)).rows;
    }
    async execute(sql, values) {
        await this.ensureReady();
        const result = await this.pool.query(sql, values);
        return {
            rows: result.rows,
            rowCount: result.rowCount ?? 0,
        };
    }
    async ensureReady() {
        if (!this.connectionString) {
            throw new Error('Postgres StorageAdapter requires a connection string via createPostgresAdapter({ connectionString }) or DATABASE_URL');
        }
        if (!this.schemaReady) {
            this.schemaReady = this.setupSchema ? this.setupDatabaseSchema() : Promise.resolve();
        }
        await this.schemaReady;
    }
    async setupDatabaseSchema() {
        const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
        await this.pool.query(schemaSql);
    }
    async refreshAppAvgRunMs(runId) {
        const row = one(await this.query('SELECT app_id FROM runs WHERE id = $1', [runId]));
        if (!row || typeof row.app_id !== 'string')
            return;
        const avgRow = one(await this.query(`SELECT AVG(duration_ms) AS avg_ms FROM (
           SELECT duration_ms FROM runs
            WHERE app_id = $1 AND status = 'success' AND duration_ms IS NOT NULL
            ORDER BY started_at DESC
            LIMIT 20
         ) recent`, [row.app_id]));
        const avg = avgRow?.avg_ms;
        if (typeof avg === 'number' && Number.isFinite(avg)) {
            await this.execute('UPDATE apps SET avg_run_ms = $1 WHERE id = $2', [
                Math.round(avg),
                row.app_id,
            ]);
        }
    }
}
export function createPostgresAdapter(opts) {
    return new PostgresStorageAdapter(opts);
}
export const postgresStorageAdapter = createPostgresAdapter({
    connectionString: process.env.DATABASE_URL || process.env.FLOOM_DATABASE_URL || process.env.POSTGRES_URL || '',
});
export default {
    kind: 'storage',
    name: 'postgres',
    protocolVersion: '^0.2',
    adapter: postgresStorageAdapter,
};
function assertColumns(table, columns, allowed) {
    for (const column of columns) {
        if (!allowed.has(column)) {
            throw new Error(`Unknown ${table} column: ${column}`);
        }
    }
}
function nonNegativeInt(value) {
    return Math.max(0, Math.floor(value));
}
function one(rows) {
    return rows[0];
}
function appValueToDb(key, value) {
    if (APP_BOOLEAN_COLUMNS.has(key))
        return value === true || value === 1;
    return value;
}
function booleanToTinyInt(value) {
    return value === true || value === 1 ? 1 : 0;
}
function toNullableJson(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string')
        return value;
    return JSON.stringify(value);
}
function jsonColumnToString(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string')
        return value;
    return JSON.stringify(value);
}
function timestampColumnToString(value) {
    if (value instanceof Date)
        return value.toISOString();
    return String(value);
}
function normalizeApp(row) {
    return {
        ...row,
        is_async: booleanToTinyInt(row.is_async),
        featured: booleanToTinyInt(row.featured),
        hero: booleanToTinyInt(row.hero),
        created_at: timestampColumnToString(row.created_at),
        updated_at: timestampColumnToString(row.updated_at),
    };
}
function normalizeRun(row) {
    const out = { ...row };
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
    return out;
}
function normalizeJob(row) {
    const out = { ...row };
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
    return out;
}
function normalizeWorkspace(row) {
    return {
        ...row,
        created_at: timestampColumnToString(row.created_at),
    };
}
function normalizeWorkspaceWithRole(row) {
    return normalizeWorkspace(row);
}
function normalizeUser(row) {
    return {
        ...row,
        created_at: timestampColumnToString(row.created_at),
    };
}
function normalizeSecret(row) {
    return {
        ...row,
        created_at: timestampColumnToString(row.created_at),
    };
}
function normalizeCreateJobInput(input) {
    const raw = input;
    if (raw.app && typeof raw.app === 'object') {
        const app = raw.app;
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
            timeout_ms: typeof timeoutOverride === 'number'
                ? timeoutOverride
                : app.timeout_ms && app.timeout_ms > 0
                    ? app.timeout_ms
                    : DEFAULT_JOB_TIMEOUT_MS,
            max_retries: typeof maxRetriesOverride === 'number'
                ? maxRetriesOverride
                : typeof app.retries === 'number' && app.retries >= 0
                    ? app.retries
                    : 0,
            attempts: 0,
            per_call_secrets_json: perCallSecrets && typeof perCallSecrets === 'object'
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
function stringOrNull(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function userInsertKeys(input) {
    return Object.keys(input).filter((key) => {
        if (!USER_WRITE_COLUMNS.has(key)) {
            throw new Error(`Unknown users column: ${String(key)}`);
        }
        return input[key] !== undefined;
    });
}
