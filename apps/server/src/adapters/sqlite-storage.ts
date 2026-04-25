import { db } from '../db.js';
import type { AppRecord, AppReviewRecord, ConnectionRecord, RunRecord, RunThreadRecord, RunTurnRecord } from '../types.js';
import type { AppListFilter, RunListFilter, StorageAdapter } from './types.js';

/**
 * SQLite implementation of the StorageAdapter.
 * This class focuses on decoupling the core App and Run queries.
 * Peripheral queries (workspaces, users, jobs) will throw NotImplementedError
 * until their respective refactors.
 */
export class SQLiteStorageAdapter implements StorageAdapter {
  // ---------- apps ----------
  getApp(slug: string): AppRecord | undefined {
    return db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRecord | undefined;
  }

  getAppById(id: string): AppRecord | undefined {
    return db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as AppRecord | undefined;
  }

  getAppWithAuthor(slug: string): (AppRecord & { author_name: string | null; author_email: string | null }) | undefined {
    return db
      .prepare(
        `SELECT apps.*, users.name AS author_name, users.email AS author_email
           FROM apps
           LEFT JOIN users ON apps.author = users.id
          WHERE apps.slug = ?`,
      )
      .get(slug) as any;
  }

  listApps(filter?: AppListFilter): AppRecord[] {
    let sql = 'SELECT * FROM apps WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.workspace_id) {
      sql += ' AND workspace_id = ?';
      params.push(filter.workspace_id);
    }
    if (filter?.visibility) {
      sql += ' AND visibility = ?';
      params.push(filter.visibility);
    }
    if (filter?.category) {
      sql += ' AND category = ?';
      params.push(filter.category);
    }
    if (filter?.featured !== undefined) {
      sql += ' AND featured = ?';
      params.push(filter.featured ? 1 : 0);
    }
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter?.offset) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }
    return db.prepare(sql).all(...params) as AppRecord[];
  }

  createApp(_input: Omit<AppRecord, 'created_at' | 'updated_at'>): AppRecord {
    // This assumes all fields are passed correctly. In practice, we might need
    // to map the object properties explicitly to the columns.
    throw new Error('NotImplemented: createApp');
  }

  updateApp(id: string, patch: Partial<AppRecord>): AppRecord | undefined {
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      values.push(v);
    }
    if (cols.length === 0) return this.getAppById(id);
    cols.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE apps SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    return this.getAppById(id);
  }

  deleteApp(id: string): boolean {
    const res = db.prepare('DELETE FROM apps WHERE id = ?').run(id);
    return res.changes > 0;
  }

  setFeaturedApps(slugs: string[]): number {
    const markFeatured = db.prepare(
      `UPDATE apps SET featured = 1, updated_at = datetime('now') WHERE slug = ?`,
    );
    const featuredTxn = db.transaction((slugs: string[]) => {
      let touched = 0;
      for (const slug of slugs) {
        const r = markFeatured.run(slug);
        if (r.changes > 0) touched++;
      }
      return touched;
    });
    return featuredTxn(slugs);
  }

  listAppsForUser(workspace_id: string, user_id: string): Array<AppRecord & { run_count: number; last_run_at: string | null }> {
    return db.prepare(
      `SELECT apps.*, (
         SELECT COUNT(*) FROM runs WHERE runs.app_id = apps.id
       ) AS run_count,
       (
         SELECT MAX(runs.started_at) FROM runs WHERE runs.app_id = apps.id
       ) AS last_run_at
         FROM apps
        WHERE (apps.workspace_id = ? AND apps.author = ?)
           OR apps.author = ?
        ORDER BY apps.updated_at DESC`,
    ).all(workspace_id, user_id, user_id) as any;
  }

  getAppRunsByDay(app_id: string, days: number): Array<{ day: string; count: number }> {
    const windowStart = `date('now', '-${days - 1} days')`;
    return db.prepare(
      `SELECT date(started_at) AS day, COUNT(*) AS count
         FROM runs
        WHERE app_id = ?
          AND date(started_at) >= ${windowStart}
        GROUP BY day
        ORDER BY day ASC`,
    ).all(app_id) as any;
  }

  refreshAppAvgRunMs(id: string): void {
    const avgRow = db
      .prepare(
        `SELECT AVG(duration_ms) AS avg_ms FROM (
           SELECT duration_ms FROM runs
           WHERE app_id = ? AND status = 'success' AND duration_ms IS NOT NULL
           ORDER BY started_at DESC
           LIMIT 20
         )`,
      )
      .get(id) as { avg_ms: number | null } | undefined;
    const avg = avgRow?.avg_ms;
    if (typeof avg === 'number' && Number.isFinite(avg)) {
      db.prepare('UPDATE apps SET avg_run_ms = ? WHERE id = ?').run(
        Math.round(avg),
        id,
      );
    }
  }

  // ---------- runs ----------
  createRun(input: {
    id: string;
    app_id: string;
    thread_id?: string | null;
    action: string;
    inputs: Record<string, unknown> | null;
    workspace_id: string;
    user_id?: string | null;
    device_id?: string | null;
  }): RunRecord {
    db.prepare(
      `INSERT INTO runs (id, app_id, thread_id, action, inputs, status, workspace_id, user_id, device_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      input.id,
      input.app_id,
      input.thread_id ?? null,
      input.action,
      input.inputs ? JSON.stringify(input.inputs) : null,
      input.workspace_id,
      input.user_id ?? null,
      input.device_id ?? null,
    );
    return this.getRun(input.id)!;
  }

  getRun(id: string): RunRecord | undefined {
    return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRecord | undefined;
  }

  listRuns(filter?: RunListFilter): RunRecord[] {
    let sql = 'SELECT * FROM runs WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.app_id) {
      sql += ' AND app_id = ?';
      params.push(filter.app_id);
    }
    if (filter?.workspace_id) {
      sql += ' AND workspace_id = ?';
      params.push(filter.workspace_id);
    }
    if (filter?.user_id) {
      sql += ' AND user_id = ?';
      params.push(filter.user_id);
    }
    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    if (filter?.before_started_at) {
      sql += ' AND started_at < ?';
      params.push(filter.before_started_at);
    }
    sql += ' ORDER BY started_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
      if (filter?.offset) {
        sql += ' OFFSET ?';
        params.push(filter.offset);
      }
    }
    return db.prepare(sql).all(...params) as RunRecord[];
  }

  updateRun(
    id: string,
    patch: {
      status?: any;
      outputs?: unknown;
      error?: string | null;
      error_type?: any;
      upstream_status?: number | null;
      logs?: string;
      duration_ms?: number | null;
      finished?: boolean;
    },
  ): void {
    const cols: string[] = [];
    const values: unknown[] = [];
    if (patch.status) {
      cols.push('status = ?');
      values.push(patch.status);
    }
    if (patch.outputs !== undefined) {
      cols.push('outputs = ?');
      values.push(patch.outputs === null ? null : JSON.stringify(patch.outputs));
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
    if (patch.finished) {
      cols.push("finished_at = datetime('now')");
    }
    if (cols.length === 0) return;

    values.push(id);
    db.prepare(`UPDATE runs SET ${cols.join(', ')} WHERE id = ?`).run(...values);
  }

  // ---------- stubs ----------
  // ---------- jobs (async queue) ----------
  createJob(input: Omit<any, 'created_at' | 'started_at' | 'finished_at' | 'attempts' | 'status'> & { status?: any }): any {
    db.prepare(
      `INSERT INTO jobs (
         id, slug, app_id, action, status, input_json, webhook_url,
         timeout_ms, max_retries, attempts, per_call_secrets_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).run(
      input.id,
      input.slug,
      input.app_id,
      input.action,
      input.status || 'queued',
      input.input_json,
      input.webhook_url,
      input.timeout_ms,
      input.max_retries,
      input.per_call_secrets_json,
    );
    return this.getJob(input.id);
  }

  getJob(id: string): any {
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  }

  getJobBySlug(slug: string, id: string): any {
    return db.prepare('SELECT * FROM jobs WHERE id = ? AND slug = ?').get(id, slug);
  }

  claimNextJob(): any {
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      const candidate = db
        .prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1")
        .get() as any;
      if (!candidate) {
        db.prepare('COMMIT').run();
        return undefined;
      }
      const res = db
        .prepare(
          `UPDATE jobs
             SET status='running',
                 started_at=datetime('now'),
                 attempts=attempts + 1
           WHERE id = ? AND status = 'queued'`
        )
        .run(candidate.id);
      db.prepare('COMMIT').run();
      if (res.changes === 0) return undefined;
      return this.getJob(candidate.id);
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  }

  updateJob(id: string, patch: any): any {
    const cols: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      cols.push('status = ?');
      values.push(patch.status);
    }
    if (patch.output_json !== undefined) {
      cols.push('output_json = ?');
      values.push(patch.output_json);
    }
    if (patch.error_json !== undefined) {
      cols.push('error_json = ?');
      values.push(patch.error_json);
    }
    if (patch.run_id !== undefined) {
      cols.push('run_id = ?');
      values.push(patch.run_id);
    }
    if (patch.started_at !== undefined) {
      if (patch.started_at === null) cols.push('started_at = NULL');
      else {
        cols.push('started_at = ?');
        values.push(patch.started_at);
      }
    }
    if (patch.finished_at !== undefined) {
      if (patch.finished_at === null) cols.push('finished_at = NULL');
      else {
        cols.push('finished_at = ?');
        values.push(patch.finished_at);
      }
    }
    if (cols.length === 0) return this.getJob(id);

    values.push(id);
    db.prepare(`UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  countJobsByStatus(status: any): number {
    const row = db.prepare('SELECT COUNT(*) as n FROM jobs WHERE status = ?').get(status) as { n: number };
    return row.n;
  }
  getWorkspace(id: string): any {
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  }

  getWorkspaceBySlug(slug: string): any {
    return db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug);
  }

  listWorkspacesForUser(user_id: string): any[] {
    return db
      .prepare(
        `SELECT w.*, m.role
           FROM workspace_members m
           JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = ?
          ORDER BY w.created_at ASC`,
      )
      .all(user_id);
  }

  createWorkspace(input: { id: string; slug: string; name: string; plan: string }): any {
    db.prepare(
      `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, ?)`,
    ).run(input.id, input.slug, input.name, input.plan);
    return this.getWorkspace(input.id);
  }

  updateWorkspace(id: string, patch: { name?: string; slug?: string; wrapped_dek?: string | null }): any {
    const cols: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      cols.push('name = ?');
      values.push(patch.name);
    }
    if (patch.slug !== undefined) {
      cols.push('slug = ?');
      values.push(patch.slug);
    }
    if (patch.wrapped_dek !== undefined) {
      cols.push('wrapped_dek = ?');
      values.push(patch.wrapped_dek);
    }
    if (cols.length === 0) return this.getWorkspace(id);
    values.push(id);
    db.prepare(`UPDATE workspaces SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): void {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  getUser(id: string): any {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  getUserByEmail(email: string): any {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  createUser(input: any): any {
    db.prepare(
      `INSERT INTO users (id, workspace_id, email, name, auth_provider, auth_subject)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.workspace_id,
      input.email,
      input.name,
      input.auth_provider,
      input.auth_subject,
    );
    return this.getUser(input.id);
  }

  updateUser(id: string, patch: { name?: string | null; email?: string | null; image?: string | null; composio_user_id?: string | null }): any {
    const cols: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      cols.push('name = ?');
      values.push(patch.name);
    }
    if (patch.email !== undefined) {
      cols.push('email = ?');
      values.push(patch.email);
    }
    if (patch.image !== undefined) {
      cols.push('image = ?');
      values.push(patch.image);
    }
    if (patch.composio_user_id !== undefined) {
      cols.push('composio_user_id = ?');
      values.push(patch.composio_user_id);
    }
    if (cols.length === 0) return this.getUser(id);
    values.push(id);
    db.prepare(`UPDATE users SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    return this.getUser(id);
  }

  upsertUser(input: any): any {
    db.prepare(
      `INSERT INTO users (id, workspace_id, email, name, auth_provider, auth_subject)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name`,
    ).run(
      input.id,
      input.workspace_id || null,
      input.email || null,
      input.name || null,
      input.auth_provider,
      input.auth_subject || null,
    );
    return this.getUser(input.id);
  }

  purgeUnverifiedAuthSessions(): number {
    const result = db
      .prepare(
        `DELETE FROM "session"
          WHERE "userId" IN (
            SELECT "id" FROM "user" WHERE COALESCE("emailVerified", 0) = 0
          )`,
      )
      .run();
    return Number(result.changes || 0);
  }

  getBetterAuthUser(id: string): any {
    try {
      return db.prepare('SELECT name, image, email FROM user WHERE id = ?').get(id);
    } catch {
      return undefined;
    }
  }

  // ---------- members ----------
  getMemberRole(workspace_id: string, user_id: string): any {
    const row = db
      .prepare(
        `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspace_id, user_id) as { role: string } | undefined;
    return row?.role || null;
  }

  listWorkspaceMembers(workspace_id: string): any[] {
    return db
      .prepare(
        `SELECT m.*, u.email, u.name
           FROM workspace_members m
           LEFT JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ?
          ORDER BY m.joined_at ASC`,
      )
      .all(workspace_id);
  }

  upsertWorkspaceMember(workspace_id: string, user_id: string, role: string): void {
    db.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         role = excluded.role`,
    ).run(workspace_id, user_id, role);
  }

  removeWorkspaceMember(workspace_id: string, user_id: string): void {
    db.prepare(
      `DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).run(workspace_id, user_id);
  }

  countWorkspaceAdmins(workspace_id: string): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM workspace_members WHERE workspace_id = ? AND role = 'admin'`,
      )
      .get(workspace_id) as { c: number };
    return row.c;
  }

  // ---------- invites ----------
  getWorkspaceInvite(id: string): any {
    return db.prepare('SELECT * FROM workspace_invites WHERE id = ?').get(id);
  }

  getWorkspaceInviteByToken(token: string): any {
    return db.prepare('SELECT * FROM workspace_invites WHERE token = ?').get(token);
  }

  listWorkspaceInvites(workspace_id: string): any[] {
    return db
      .prepare(
        `SELECT * FROM workspace_invites
         WHERE workspace_id = ?
         ORDER BY created_at DESC`,
      )
      .all(workspace_id);
  }

  createWorkspaceInvite(input: any): any {
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
    return this.getWorkspaceInvite(input.id);
  }

  updateWorkspaceInvite(id: string, patch: any): void {
    const cols: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      cols.push('status = ?');
      values.push(patch.status);
    }
    if (patch.accepted_at !== undefined) {
      cols.push('accepted_at = ?');
      values.push(patch.accepted_at);
    }
    if (cols.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE workspace_invites SET ${cols.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteWorkspaceInvite(id: string): void {
    db.prepare('DELETE FROM workspace_invites WHERE id = ?').run(id);
  }

  // ---------- active workspace ----------
  getActiveWorkspaceId(user_id: string): string | null {
    const row = db
      .prepare('SELECT workspace_id FROM user_active_workspace WHERE user_id = ?')
      .get(user_id) as { workspace_id: string } | undefined;
    return row?.workspace_id || null;
  }

  setActiveWorkspaceId(user_id: string, workspace_id: string): void {
    db.prepare(
      `INSERT INTO user_active_workspace (user_id, workspace_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         updated_at = excluded.updated_at`,
    ).run(user_id, workspace_id);
  }

  deleteActiveWorkspaceForWorkspace(workspace_id: string): void {
    db.prepare('DELETE FROM user_active_workspace WHERE workspace_id = ?').run(workspace_id);
  }

  deleteActiveWorkspaceForUserAndWorkspace(user_id: string, workspace_id: string): void {
    db.prepare(
      `DELETE FROM user_active_workspace WHERE user_id = ? AND workspace_id = ?`,
    ).run(user_id, workspace_id);
  }

  // ---------- combined / atomic operations ----------
  createWorkspaceWithMember(input: {
    workspace: { id: string; slug: string; name: string; plan: string };
    user_id: string;
    role: any;
  }): any {
    const tx = db.transaction(() => {
      this.createWorkspace(input.workspace);
      this.upsertWorkspaceMember(input.workspace.id, input.user_id, input.role);
      this.setActiveWorkspaceId(input.user_id, input.workspace.id);
    });
    tx();
    return this.getWorkspace(input.workspace.id);
  }

  acceptInviteWithMember(input: {
    invite_id: string;
    workspace_id: string;
    user_id: string;
    role: any;
  }): void {
    const tx = db.transaction(() => {
      this.upsertWorkspaceMember(input.workspace_id, input.user_id, input.role);
      this.updateWorkspaceInvite(input.invite_id, {
        status: 'accepted',
        accepted_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
      this.setActiveWorkspaceId(input.user_id, input.workspace_id);
    });
    tx();
  }

  // ---------- user secrets ----------
  listUserSecrets(workspace_id: string, user_id: string): any[] {
    return db
      .prepare(
        `SELECT * FROM user_secrets WHERE workspace_id = ? AND user_id = ? ORDER BY created_at DESC`,
      )
      .all(workspace_id, user_id);
  }

  upsertUserSecret(input: any): void {
    db.prepare(
      `INSERT INTO user_secrets
       (workspace_id, user_id, key, ciphertext, nonce, auth_tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT (workspace_id, user_id, key) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         nonce = excluded.nonce,
         auth_tag = excluded.auth_tag,
         updated_at = excluded.updated_at`,
    ).run(
      input.workspace_id,
      input.user_id,
      input.key,
      input.ciphertext,
      input.nonce,
      input.auth_tag,
    );
  }

  deleteUserSecret(workspace_id: string, user_id: string, key: string): void {
    db.prepare(
      `DELETE FROM user_secrets WHERE workspace_id = ? AND user_id = ? AND key = ?`,
    ).run(workspace_id, user_id, key);
  }

  // ---------- app creator secrets ----------
  listAppCreatorSecrets(workspace_id: string, app_id: string): any[] {
    return db
      .prepare(
        `SELECT * FROM app_creator_secrets WHERE workspace_id = ? AND app_id = ? ORDER BY created_at DESC`,
      )
      .all(workspace_id, app_id);
  }

  upsertAppCreatorSecret(input: any): void {
    db.prepare(
      `INSERT INTO app_creator_secrets
       (workspace_id, app_id, key, ciphertext, nonce, auth_tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT (workspace_id, app_id, key) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         nonce = excluded.nonce,
         auth_tag = excluded.auth_tag,
         updated_at = excluded.updated_at`,
    ).run(
      input.workspace_id,
      input.app_id,
      input.key,
      input.ciphertext,
      input.nonce,
      input.auth_tag,
    );
  }

  deleteAppCreatorSecret(workspace_id: string, app_id: string, key: string): void {
    db.prepare(
      `DELETE FROM app_creator_secrets WHERE workspace_id = ? AND app_id = ? AND key = ?`,
    ).run(workspace_id, app_id, key);
  }

  // ---------- app secret policies ----------
  listAppSecretPolicies(app_id: string): any[] {
    return db
      .prepare(`SELECT * FROM app_secret_policies WHERE app_id = ? ORDER BY updated_at DESC`)
      .all(app_id);
  }

  getAppSecretPolicy(app_id: string, key: string): any {
    return db
      .prepare(`SELECT * FROM app_secret_policies WHERE app_id = ? AND key = ?`)
      .get(app_id, key);
  }

  upsertAppSecretPolicy(input: any): void {
    db.prepare(
      `INSERT INTO app_secret_policies (app_id, key, policy, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (app_id, key) DO UPDATE SET
         policy = excluded.policy,
         updated_at = excluded.updated_at`,
    ).run(input.app_id, input.key, input.policy);
  }

  deleteAppSecretPolicy(app_id: string, key: string): void {
    db.prepare(`DELETE FROM app_secret_policies WHERE app_id = ? AND key = ?`).run(
      app_id,
      key,
    );
  }

  // ---------- triggers ----------
  getTrigger(id: string): any {
    return db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
  }

  getTriggerByWebhookPath(path: string): any {
    return db
      .prepare('SELECT * FROM triggers WHERE webhook_url_path = ?')
      .get(path);
  }

  listTriggersForUser(user_id: string): any[] {
    return db
      .prepare('SELECT * FROM triggers WHERE user_id = ? ORDER BY created_at DESC')
      .all(user_id);
  }

  listTriggersForApp(app_id: string): any[] {
    return db
      .prepare('SELECT * FROM triggers WHERE app_id = ? ORDER BY created_at DESC')
      .all(app_id);
  }

  createTrigger(input: any): any {
    const cols = Object.keys(input);
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(input);
    db.prepare(
      `INSERT INTO triggers (${cols.join(', ')}) VALUES (${placeholders})`,
    ).run(...values);
    return this.getTrigger(input.id);
  }

  updateTrigger(id: string, patch: any): any {
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      values.push(v);
    }
    if (cols.length === 0) return this.getTrigger(id);
    values.push(id);
    db.prepare(`UPDATE triggers SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    return this.getTrigger(id);
  }

  deleteTrigger(id: string): boolean {
    const res = db.prepare('DELETE FROM triggers WHERE id = ?').run(id);
    return res.changes > 0;
  }

  readyScheduleTriggers(nowMs: number): any[] {
    return db
      .prepare(
        `SELECT * FROM triggers
          WHERE trigger_type = 'schedule'
            AND enabled = 1
            AND next_run_at IS NOT NULL
            AND next_run_at <= ?
          ORDER BY next_run_at ASC`,
      )
      .all(nowMs);
  }

  claimScheduleTrigger(
    id: string,
    readNextRun: number,
    nextMs: number,
    nowMs: number,
    lastFired: boolean,
  ): boolean {
    const updates = lastFired
      ? `next_run_at = ?, last_fired_at = ?, updated_at = ?`
      : `next_run_at = ?, updated_at = ?`;
    const values = lastFired ? [nextMs, nowMs, nowMs] : [nextMs, nowMs];
    const res = db
      .prepare(`UPDATE triggers SET ${updates} WHERE id = ? AND next_run_at = ?`)
      .run(...values, id, readNextRun);
    return res.changes > 0;
  }

  markWebhookFired(id: string, nowMs: number): void {
    db.prepare(
      `UPDATE triggers SET last_fired_at = ?, updated_at = ? WHERE id = ?`,
    ).run(nowMs, nowMs, id);
  }

  recordWebhookDelivery(
    triggerId: string,
    requestId: string,
    nowMs: number,
    ttlMs: number,
  ): boolean {
    db.prepare('DELETE FROM trigger_webhook_deliveries WHERE received_at < ?').run(
      nowMs - ttlMs,
    );
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO trigger_webhook_deliveries
           (trigger_id, request_id, received_at)
         VALUES (?, ?, ?)`,
      )
      .run(triggerId, requestId, nowMs);
    return res.changes > 0;
  }

  getJobTriggerContext(jobId: string): any {
    try {
      return db
        .prepare(
          'SELECT trigger_id, trigger_type FROM job_trigger_context WHERE job_id = ?',
        )
        .get(jobId);
    } catch {
      return undefined;
    }
  }

  setJobTriggerContext(jobId: string, triggerId: string, triggerType: string): void {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS job_trigger_context (
          job_id TEXT PRIMARY KEY,
          trigger_id TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare(
        `INSERT OR REPLACE INTO job_trigger_context (job_id, trigger_id, trigger_type, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(jobId, triggerId, triggerType, Date.now());
    } catch (err) {
      console.warn('[sqlite-storage] could not persist job trigger context:', err);
    }
  }

  // ---------- stripe connect ----------
  getStripeAccount(workspace_id: string, user_id: string): any {
    return db
      .prepare('SELECT * FROM stripe_accounts WHERE workspace_id = ? AND user_id = ?')
      .get(workspace_id, user_id);
  }

  getStripeAccountByStripeId(stripe_account_id: string): any {
    return db
      .prepare('SELECT * FROM stripe_accounts WHERE stripe_account_id = ?')
      .get(stripe_account_id);
  }

  createStripeAccount(input: any): any {
    const cols = Object.keys(input);
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(input);
    db.prepare(
      `INSERT INTO stripe_accounts (${cols.join(', ')}) VALUES (${placeholders})`,
    ).run(...values);
    return this.getStripeAccountByStripeId(input.stripe_account_id);
  }

  updateStripeAccount(stripe_account_id: string, patch: any): any {
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      values.push(v);
    }
    if (cols.length === 0) return this.getStripeAccountByStripeId(stripe_account_id);
    values.push(stripe_account_id);
    db.prepare(`UPDATE stripe_accounts SET ${cols.join(', ')} WHERE stripe_account_id = ?`).run(...values);
    return this.getStripeAccountByStripeId(stripe_account_id);
  }

  recordStripeWebhookEvent(input: any): void {
    const cols = Object.keys(input);
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(input);
    db.prepare(
      `INSERT INTO stripe_webhook_events (${cols.join(', ')}) VALUES (${placeholders})`,
    ).run(...values);
  }

  isStripeWebhookEventProcessed(event_id: string): boolean {
    const row = db
      .prepare('SELECT 1 FROM stripe_webhook_events WHERE event_id = ?')
      .get(event_id);
    return !!row;
  }

  listStripeWebhookEvents(limit: number): any[] {
    return db
      .prepare('SELECT * FROM stripe_webhook_events ORDER BY received_at DESC LIMIT ?')
      .all(limit);
  }

  getStripeWebhookEvent(event_id: string): any {
    return db
      .prepare('SELECT * FROM stripe_webhook_events WHERE event_id = ?')
      .get(event_id);
  }

  // ---------- sessions & rekey ----------
  rekeyDevice(device_id: string, user_id: string, workspace_id: string, default_user_id: string): any {
    const result = {
      app_memory: 0,
      runs: 0,
      run_threads: 0,
      connections: 0,
    };

    db.transaction(() => {
      const memRes = db
        .prepare(
          `UPDATE app_memory
             SET user_id = ?,
                 workspace_id = ?,
                 updated_at = datetime('now')
           WHERE device_id = ?
             AND user_id = ?`,
        )
        .run(user_id, workspace_id, device_id, default_user_id);
      result.app_memory = memRes.changes;

      const runRes = db
        .prepare(
          `UPDATE runs
             SET user_id = ?,
                 workspace_id = ?
           WHERE device_id = ?
             AND (user_id IS NULL OR user_id = ?)`,
        )
        .run(user_id, workspace_id, device_id, default_user_id);
      result.runs = runRes.changes;

      const threadRes = db
        .prepare(
          `UPDATE run_threads
             SET user_id = ?,
                 workspace_id = ?,
                 updated_at = datetime('now')
           WHERE device_id = ?
             AND (user_id IS NULL OR user_id = ?)`,
        )
        .run(user_id, workspace_id, device_id, default_user_id);
      result.run_threads = threadRes.changes;

      const conRes = db
        .prepare(
          `UPDATE connections
             SET owner_kind = 'user',
                 owner_id = ?,
                 workspace_id = ?,
                 updated_at = datetime('now')
           WHERE owner_kind = 'device'
             AND owner_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM connections c2
                WHERE c2.workspace_id = ?
                  AND c2.owner_kind = 'user'
                  AND c2.owner_id = ?
                  AND c2.provider = connections.provider
             )`,
        )
        .run(user_id, workspace_id, device_id, workspace_id, user_id);
      result.connections = conRes.changes;
    })();

    return result;
  }

  updateUser(id: string, patch: any): any {
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      values.push(v);
    }
    if (cols.length === 0) return this.getUser(id);
    values.push(id);
    db.prepare(`UPDATE users SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    return this.getUser(id);
  }

  upsertUser(input: any): any {
    const cols = Object.keys(input);
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(input);
    
    // Better Auth uses 'id' but we also have provider/subject.
    // For simplicity, we use INSERT OR REPLACE if possible, but the original used ON CONFLICT (id).
    // I'll stick to ON CONFLICT (id) to match behavior.
    const updates = cols.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ');
    
    db.prepare(`
      INSERT INTO users (${cols.join(', ')}) 
      VALUES (${placeholders})
      ON CONFLICT (id) DO UPDATE SET ${updates}
    `).run(...values);
    
    return this.getUser(input.id);
  }

  cleanupUserOrphans(userId: string, defaultWorkspaceId: string): void {
    db.transaction(() => {
      // 1. Find workspaces where user is a member
      const memberships = db
        .prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?')
        .all(userId) as { workspace_id: string }[];

      // 2. Clear global user state
      db.prepare(`
        DELETE FROM secrets
        WHERE app_id IN (
          SELECT id FROM apps
          WHERE author = ?
            AND (visibility != 'public' OR visibility IS NULL)
        )
      `).run(userId);

      db.prepare(`
        DELETE FROM apps
        WHERE author = ?
          AND (visibility != 'public' OR visibility IS NULL)
      `).run(userId);

      db.prepare(`
        UPDATE apps
        SET author = NULL,
            workspace_id = ?,
            visibility = 'public'
        WHERE author = ?
          AND visibility = 'public'
      `).run(defaultWorkspaceId, userId);

      db.prepare('DELETE FROM user_active_workspace WHERE user_id = ?').run(userId);
      db.prepare("DELETE FROM connections WHERE owner_id = ? AND owner_kind = 'user'").run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);

      // 3. Process workspaces where user was a member
      for (const { workspace_id } of memberships) {
        if (workspace_id === defaultWorkspaceId) continue;

        const memberCount = db
          .prepare('SELECT COUNT(*) as c FROM workspace_members WHERE workspace_id = ?')
          .get(workspace_id) as { c: number };

        if (memberCount.c === 0) {
          db.prepare(`
            DELETE FROM secrets 
            WHERE app_id IN (
              SELECT id FROM apps 
              WHERE workspace_id = ? 
                AND visibility != 'public'
            )
          `).run(workspace_id);

          db.prepare(`
            DELETE FROM apps 
            WHERE workspace_id = ? 
              AND visibility != 'public'
          `).run(workspace_id);

          db.prepare(`
            UPDATE apps 
               SET workspace_id = ?,
                   author = NULL,
                   updated_at = datetime('now')
             WHERE workspace_id = ? 
               AND (visibility = 'public' OR visibility IS NULL)
          `).run(defaultWorkspaceId, workspace_id);

          db.prepare('DELETE FROM run_threads WHERE workspace_id = ?').run(workspace_id);
          db.prepare('DELETE FROM app_reviews WHERE workspace_id = ?').run(workspace_id);
          db.prepare('DELETE FROM feedback WHERE workspace_id = ?').run(workspace_id);
          db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace_id);
        }
      }
    })();
  }

  // ---------- app memory ----------
  getAppMemory(workspace_id: string, app_slug: string, user_id: string, key: string): string | undefined {
    const row = db
      .prepare('SELECT value FROM app_memory WHERE workspace_id = ? AND app_slug = ? AND user_id = ? AND key = ?')
      .get(workspace_id, app_slug, user_id, key) as { value: string } | undefined;
    return row?.value;
  }

  setAppMemory(input: any): void {
    const cols = Object.keys(input);
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(input);
    const updates = cols.filter(c => c !== 'workspace_id' && c !== 'app_slug' && c !== 'user_id' && c !== 'key').map(c => `${c} = excluded.${c}`).join(', ');
    
    db.prepare(`
      INSERT INTO app_memory (${cols.join(', ')}, updated_at)
      VALUES (${placeholders}, datetime('now'))
      ON CONFLICT (workspace_id, app_slug, user_id, key)
      DO UPDATE SET ${updates}, updated_at = datetime('now')
    `).run(...values);
  }

  deleteAppMemory(workspace_id: string, app_slug: string, user_id: string, key: string): boolean {
    const res = db
      .prepare('DELETE FROM app_memory WHERE workspace_id = ? AND app_slug = ? AND user_id = ? AND key = ?')
      .run(workspace_id, app_slug, user_id, key);
    return res.changes > 0;
  }

  listAppMemory(workspace_id: string, app_slug: string, user_id: string): any[] {
    return db
      .prepare('SELECT key, value FROM app_memory WHERE workspace_id = ? AND app_slug = ? AND user_id = ? ORDER BY key')
      .all(workspace_id, app_slug, user_id);
  }

  listAppMemoryKeys(workspace_id: string, app_slug: string, user_id: string, keys: string[]): any[] {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(', ');
    return db
      .prepare(`SELECT key, value FROM app_memory WHERE workspace_id = ? AND app_slug = ? AND user_id = ? AND key IN (${placeholders})`)
      .all(workspace_id, app_slug, user_id, ...keys);
  }

  // ---------- embeddings ----------
  upsertEmbedding(appId: string, text: string, vector: Buffer): void {
    db.prepare(
      `INSERT INTO embeddings (app_id, text, vector) VALUES (?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET text = excluded.text, vector = excluded.vector, updated_at = datetime('now')`,
    ).run(appId, text, vector);
  }

  listMissingEmbeddings(): any[] {
    return db
      .prepare(
        `SELECT a.id, a.name, a.description, a.category
         FROM apps a
         LEFT JOIN embeddings e ON e.app_id = a.id
         WHERE e.app_id IS NULL`,
      )
      .all();
  }

  listAllEmbeddings(): any[] {
    return db.prepare('SELECT app_id, vector FROM embeddings').all();
  }

  // ---------- connections ----------
  upsertConnection(input: any): ConnectionRecord {
    const cols = Object.keys(input);
    const placeholders = cols.map(() => '?').join(', ');
    const values = Object.values(input);
    const updates = cols.filter(c => c !== 'workspace_id' && c !== 'owner_kind' && c !== 'owner_id' && c !== 'provider').map(c => `${c} = excluded.${c}`).join(', ');
    
    db.prepare(`
      INSERT INTO connections (${cols.join(', ')}, updated_at)
      VALUES (${placeholders}, datetime('now'))
      ON CONFLICT (workspace_id, owner_kind, owner_id, provider)
      DO UPDATE SET ${updates}, updated_at = datetime('now')
    `).run(...values);
    
    return this.getConnection(input.workspace_id, input.owner_kind, input.owner_id, input.provider);
  }

  getConnection(workspace_id: string, owner_kind: string, owner_id: string, provider: string): any {
    return db
      .prepare('SELECT * FROM connections WHERE workspace_id = ? AND owner_kind = ? AND owner_id = ? AND provider = ?')
      .get(workspace_id, owner_kind, owner_id, provider);
  }

  getConnectionByComposioId(workspace_id: string, owner_kind: string, owner_id: string, composio_connection_id: string): any {
    return db
      .prepare('SELECT * FROM connections WHERE workspace_id = ? AND owner_kind = ? AND owner_id = ? AND composio_connection_id = ?')
      .get(workspace_id, owner_kind, owner_id, composio_connection_id);
  }

  listConnections(filter: any): any[] {
    let sql = 'SELECT * FROM connections WHERE workspace_id = ? AND owner_kind = ? AND owner_id = ?';
    const params = [filter.workspace_id, filter.owner_kind, filter.owner_id];
    if (filter.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY provider';
    return db.prepare(sql).all(...params);
  }

  updateConnection(id: string, patch: any): any {
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      values.push(v);
    }
    if (cols.length === 0) return this._getConnectionById(id);
    cols.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE connections SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    return this._getConnectionById(id);
  }

  upsertSecret(input: { id: string; name: string; value: string; app_id: string }): void {
    db.prepare('INSERT OR IGNORE INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, ?)')
      .run(input.id, input.name, input.value, input.app_id);
  }

  private _getConnectionById(id: string): any {
    return db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
  }

  listAdminSecrets(app_id?: string | null): any[] {
    if (app_id === null) {
      return db.prepare('SELECT * FROM secrets WHERE app_id IS NULL').all();
    } else if (app_id) {
      return db.prepare('SELECT * FROM secrets WHERE app_id = ?').all(app_id);
    }
    return db.prepare('SELECT * FROM secrets').all();
  }
  upsertAdminSecret(): void { throw new Error('NotImplemented'); }
  deleteAdminSecret(): boolean { throw new Error('NotImplemented'); }

  listHubApps(filter: HubListFilter): Array<
    AppRecord & {
      author_name: string | null;
      author_email: string | null;
      runs_7d: number;
    }
  > {
    const { category, sort = 'default' } = filter;
    let orderBy =
      'apps.featured DESC, (apps.avg_run_ms IS NULL) ASC, apps.avg_run_ms ASC, apps.created_at DESC, apps.name ASC';
    if (sort === 'name') orderBy = 'apps.name ASC';
    if (sort === 'newest') orderBy = 'apps.created_at DESC';
    if (sort === 'category') orderBy = 'apps.category, apps.name';

    const sql = `SELECT apps.*,
                        users.name AS author_name,
                        users.email AS author_email,
                        (
                          SELECT COUNT(*) FROM runs
                           WHERE runs.app_id = apps.id
                             AND date(runs.started_at) >= date('now','-6 days')
                        ) AS runs_7d
                   FROM apps
                   LEFT JOIN users ON apps.author = users.id
                   WHERE apps.status = 'active'
                     AND (apps.visibility = 'public' OR apps.visibility IS NULL)
                     AND apps.publish_status = 'published'
                     ${category ? 'AND apps.category = ?' : ''}
                   ORDER BY ${orderBy}`;

    return (category ? db.prepare(sql).all(category) : db.prepare(sql).all()) as any;
  }

  getAppReviewSummary(slug: string): { count: number; avg: number } {
    return db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS avg
         FROM app_reviews
        WHERE app_slug = ?`,
    ).get(slug) as any;
  }

  listAppReviews(slug: string, limit: number): Array<AppReviewRecord & { author_name: string | null; author_email: string | null }> {
    return db.prepare(
      `SELECT app_reviews.*, users.name AS author_name, users.email AS author_email
         FROM app_reviews
         LEFT JOIN users ON users.id = app_reviews.user_id
        WHERE app_reviews.app_slug = ?
        ORDER BY app_reviews.created_at DESC
        LIMIT ?`,
    ).all(slug, limit) as any;
  }

  getAppReview(workspace_id: string, slug: string, user_id: string): AppReviewRecord | undefined {
    return db.prepare(
      `SELECT * FROM app_reviews
        WHERE workspace_id = ? AND app_slug = ? AND user_id = ?`,
    ).get(workspace_id, slug, user_id) as any;
  }

  getAppReviewById(id: string): AppReviewRecord | undefined {
    return db.prepare('SELECT * FROM app_reviews WHERE id = ?').get(id) as any;
  }

  createAppReview(input: Omit<AppReviewRecord, 'created_at' | 'updated_at'>): AppReviewRecord {
    const now = new Date().toISOString();
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
      now,
      now,
    );
    return this.getAppReviewById(input.id)!;
  }

  updateAppReview(id: string, patch: Partial<AppReviewRecord>): AppReviewRecord | undefined {
    const cols: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = ?`);
      values.push(v);
    }
    if (cols.length === 0) return this.getAppReviewById(id);
    cols.push("updated_at = datetime('now')");
    values.push(id);
    db.prepare(`UPDATE app_reviews SET ${cols.join(', ')} WHERE id = ?`).run(...values);
    return this.getAppReviewById(id);
  }

  upsertWaitlistSignup(input: {
    email: string;
    source: string | null;
    user_agent: string | null;
    ip_hash: string | null;
    deploy_repo_url: string | null;
    deploy_intent: string | null;
  }): { inserted: boolean; id: string } {
    const id = `wl_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    try {
      db.prepare(
        `INSERT INTO waitlist_signups (id, email, source, user_agent, ip_hash, deploy_repo_url, deploy_intent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.email,
        input.source,
        input.user_agent,
        input.ip_hash,
        input.deploy_repo_url,
        input.deploy_intent,
      );
      return { inserted: true, id };
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('UNIQUE') || msg.includes('constraint')) {
        const existing = db
          .prepare(
            `SELECT id FROM waitlist_signups WHERE LOWER(email) = LOWER(?) LIMIT 1`,
          )
          .get(input.email) as { id: string } | undefined;
        return { inserted: false, id: existing?.id || id };
      }
      throw err;
    }
  }

  createThread(id: string, title?: string | null): RunThreadRecord {
    db.prepare('INSERT INTO run_threads (id, title) VALUES (?, ?)').run(id, title ?? null);
    return this.getThread(id)!;
  }

  getThread(id: string): RunThreadRecord | undefined {
    return db.prepare('SELECT * FROM run_threads WHERE id = ?').get(id) as any;
  }

  updateThread(id: string, patch: { title?: string | null; updated_at?: string }): void {
    const cols: string[] = [];
    const values: unknown[] = [];
    if (patch.title !== undefined) {
      cols.push('title = ?');
      values.push(patch.title);
    }
    if (patch.updated_at) {
      cols.push('updated_at = ?');
      values.push(patch.updated_at);
    } else {
      cols.push("updated_at = datetime('now')");
    }
    values.push(id);
    db.prepare(`UPDATE run_threads SET ${cols.join(', ')} WHERE id = ?`).run(...values);
  }

  listTurns(thread_id: string): RunTurnRecord[] {
    return db.prepare('SELECT * FROM run_turns WHERE thread_id = ? ORDER BY turn_index ASC').all(thread_id) as any;
  }

  createTurn(input: Omit<RunTurnRecord, 'created_at'>): RunTurnRecord {
    db.prepare(
      `INSERT INTO run_turns (id, thread_id, turn_index, kind, payload)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.id, input.thread_id, input.turn_index, input.kind, input.payload);
    return db.prepare('SELECT * FROM run_turns WHERE id = ?').get(input.id) as any;
  }

  getMaxTurnIndex(thread_id: string): number | null {
    const row = db.prepare('SELECT MAX(turn_index) as max_idx FROM run_turns WHERE thread_id = ?').get(thread_id) as any;
    return row?.max_idx;
  }

  countThreads(): number {
    const row = db.prepare('SELECT COUNT(*) as c FROM run_threads').get() as any;
    return row?.c || 0;
  }

  countApps(): number {
    const row = db.prepare('SELECT COUNT(*) as c FROM apps').get() as any;
    return row?.c || 0;
  }

  getRunStatusCounts(): Array<{ status: string; count: number }> {
    return db.prepare(`SELECT status, COUNT(*) as count FROM runs GROUP BY status`).all() as any;
  }

  getActiveUsersLast24h(): number {
    const row = db.prepare(
      `SELECT COUNT(DISTINCT COALESCE(user_id, '') || ':' || COALESCE(device_id, '')) as c
       FROM runs
       WHERE started_at >= datetime('now', '-1 day')`,
    ).get() as any;
    return row?.c || 0;
  }

  createFeedback(input: {
    id: string;
    workspace_id: string | null;
    user_id: string | null;
    device_id: string | null;
    email: string | null;
    url: string | null;
    text: string;
    ip_hash: string;
  }): void {
    db.prepare(
      `INSERT INTO feedback
         (id, workspace_id, user_id, device_id, email, url, text, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.workspace_id,
      input.user_id,
      input.device_id,
      input.email,
      input.url,
      input.text,
      input.ip_hash,
    );
  }

  listFeedback(limit: number): any[] {
    return db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  getRawDatabase(): any {
    return db;
  }
}
