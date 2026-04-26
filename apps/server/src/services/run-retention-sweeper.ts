import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { sendDiscordAlert } from '../lib/alerts.js';
import type { SessionContext } from '../types.js';

const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DISCORD_DELETE_THRESHOLD = 1000;
const MAX_RETENTION_DAYS = 3650;

export class RunDeleteNotFoundError extends Error {
  constructor(runId: string) {
    super(`run ${runId} not found`);
    this.name = 'RunDeleteNotFoundError';
  }
}

export class RunDeleteForbiddenError extends Error {
  constructor(runId: string) {
    super(`run ${runId} is not owned by the caller`);
    this.name = 'RunDeleteForbiddenError';
  }
}

export function normalizeMaxRunRetentionDays(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('max_run_retention_days must be a positive integer');
  }
  if (value < 1 || value > MAX_RETENTION_DAYS) {
    throw new Error(
      `max_run_retention_days must be between 1 and ${MAX_RETENTION_DAYS}`,
    );
  }
  return value;
}

function sqliteTimestampFromInput(raw: string): string | null {
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function auditRunDeletion(args: {
  actor_user_id: string | null;
  workspace_id: string | null;
  action: string;
  run_id?: string | null;
  app_id?: string | null;
  deleted_count: number;
  metadata?: Record<string, unknown>;
}): void {
  db.prepare(
    `INSERT INTO run_deletion_audit
       (id, actor_user_id, workspace_id, action, run_id, app_id, deleted_count, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `rda_${randomUUID().replace(/-/g, '')}`,
    args.actor_user_id,
    args.workspace_id,
    args.action,
    args.run_id ?? null,
    args.app_id ?? null,
    args.deleted_count,
    args.metadata ? JSON.stringify(args.metadata) : null,
  );
}

function ownerScope(ctx: SessionContext): { clause: string; param: string } {
  return ctx.is_authenticated
    ? { clause: 'workspace_id = ? AND user_id = ?', param: ctx.user_id }
    : { clause: 'workspace_id = ? AND device_id = ?', param: ctx.device_id };
}

export function deleteRunForOwner(
  ctx: SessionContext,
  runId: string,
): { deleted_count: number } {
  const row = db
    .prepare('SELECT id, app_id, workspace_id, user_id, device_id FROM runs WHERE id = ?')
    .get(runId) as
    | {
        id: string;
        app_id: string;
        workspace_id: string | null;
        user_id: string | null;
        device_id: string | null;
      }
    | undefined;

  if (!row) throw new RunDeleteNotFoundError(runId);

  const workspaceMatches = (row.workspace_id || 'local') === ctx.workspace_id;
  const ownerMatches = ctx.is_authenticated
    ? row.user_id === ctx.user_id
    : row.device_id === ctx.device_id;
  if (!workspaceMatches || !ownerMatches) {
    throw new RunDeleteForbiddenError(runId);
  }

  const tx = db.transaction(() => {
    const result = db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    auditRunDeletion({
      actor_user_id: ctx.user_id,
      workspace_id: ctx.workspace_id,
      action: 'user_delete_run',
      run_id: runId,
      app_id: row.app_id,
      deleted_count: result.changes,
    });
    return result.changes;
  });

  return { deleted_count: tx() };
}

export function bulkDeleteRunsForOwner(
  ctx: SessionContext,
  args: { app_id: string; before_ts: string },
): { deleted_count: number; before_ts: string } {
  const beforeTs = sqliteTimestampFromInput(args.before_ts);
  if (!beforeTs) {
    throw new Error('before_ts must be a parseable timestamp');
  }
  const scope = ownerScope(ctx);
  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `DELETE FROM runs
          WHERE app_id = ?
            AND started_at < ?
            AND ${scope.clause}`,
      )
      .run(args.app_id, beforeTs, ctx.workspace_id, scope.param);
    auditRunDeletion({
      actor_user_id: ctx.user_id,
      workspace_id: ctx.workspace_id,
      action: 'user_bulk_delete_runs',
      app_id: args.app_id,
      deleted_count: result.changes,
      metadata: { before_ts: beforeTs },
    });
    return result.changes;
  });
  return { deleted_count: tx(), before_ts: beforeTs };
}

export function deleteWorkspaceRuns(
  ctx: SessionContext,
  workspaceId: string,
): { deleted_count: number } {
  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `DELETE FROM runs
          WHERE app_id IN (
            SELECT id FROM apps WHERE workspace_id = ?
          )`,
      )
      .run(workspaceId);
    auditRunDeletion({
      actor_user_id: ctx.user_id,
      workspace_id: workspaceId,
      action: 'workspace_bulk_delete_runs',
      deleted_count: result.changes,
    });
    return result.changes;
  });
  return { deleted_count: tx() };
}

export function deleteRunsForUserAccount(userId: string): number {
  const tx = db.transaction(() => {
    const result = db.prepare('DELETE FROM runs WHERE user_id = ?').run(userId);
    auditRunDeletion({
      actor_user_id: userId,
      workspace_id: null,
      action: 'account_delete_runs',
      deleted_count: result.changes,
    });
    return result.changes;
  });
  return tx();
}

export interface RetentionSweepResult {
  apps_checked: number;
  deleted_count: number;
  per_app: Array<{ app_id: string; slug: string; deleted_count: number }>;
}

export function sweepRunRetention(): RetentionSweepResult {
  const apps = db
    .prepare(
      `SELECT id, slug, max_run_retention_days
         FROM apps
        WHERE max_run_retention_days IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    slug: string;
    max_run_retention_days: number | null;
  }>;

  const perApp: Array<{ app_id: string; slug: string; deleted_count: number }> = [];
  let total = 0;

  const tx = db.transaction(() => {
    for (const app of apps) {
      const days = normalizeMaxRunRetentionDays(app.max_run_retention_days);
      if (days === null) continue;
      const result = db
        .prepare(
          `DELETE FROM runs
            WHERE app_id = ?
              AND finished_at IS NOT NULL
              AND finished_at < datetime('now', ?)`,
        )
        .run(app.id, `-${days} days`);
      if (result.changes > 0) {
        perApp.push({
          app_id: app.id,
          slug: app.slug,
          deleted_count: result.changes,
        });
        total += result.changes;
        auditRunDeletion({
          actor_user_id: null,
          workspace_id: null,
          action: 'retention_sweep',
          app_id: app.id,
          deleted_count: result.changes,
          metadata: { slug: app.slug, max_run_retention_days: days },
        });
      }
    }
  });
  tx();

  if (total > 0) {
    console.log(
      `[run-retention] swept ${total} run${total === 1 ? '' : 's'} across ${perApp.length} app${perApp.length === 1 ? '' : 's'}`,
    );
  }
  if (total > DISCORD_DELETE_THRESHOLD) {
    sendDiscordAlert(
      'Floom retention sweep deleted >1000 runs',
      `Deleted ${total} runs in one sweep.`,
      { per_app: perApp },
    );
  }

  return { apps_checked: apps.length, deleted_count: total, per_app: perApp };
}

export function retentionSweepIntervalMs(): number {
  const raw = Number(process.env.FLOOM_RETENTION_SWEEP_INTERVAL_MS || '');
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_SWEEP_INTERVAL_MS;
}

export function startRunRetentionSweeper(intervalMs = retentionSweepIntervalMs()): {
  stop: () => void;
} {
  const tick = () => {
    try {
      sweepRunRetention();
    } catch (err) {
      console.warn(`[run-retention] sweep failed: ${(err as Error).message}`);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
  };
}
