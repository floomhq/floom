import type { Context } from 'hono';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { db } from '../db.js';
import { newAuditLogId } from '../lib/ids.js';
import type { SessionContext } from '../types.js';

export interface AuditActor {
  userId?: string | null;
  tokenId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditTarget {
  type?: string | null;
  id?: string | null;
}

export interface AuditLogInput {
  actor?: AuditActor | null;
  action: string;
  target?: AuditTarget | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  actor_token_id: string | null;
  actor_ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_state: unknown;
  after_state: unknown;
  metadata: unknown;
  created_at: string;
}

export interface AuditLogQuery {
  actor_user_id?: string;
  target_type?: string;
  target_id?: string;
  action?: string;
  since?: string;
  limit?: number;
}

const insertAuditLog = db.prepare(
  `INSERT INTO audit_log
     (id, actor_user_id, actor_token_id, actor_ip, action, target_type, target_id,
      before_state, after_state, metadata, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function metadataWithRequestContext(
  metadata: Record<string, unknown> | null | undefined,
  actor: AuditActor | null | undefined,
): Record<string, unknown> | null {
  const merged = { ...(metadata || {}) };
  if (actor?.ip && merged.actor_ip === undefined) merged.actor_ip = actor.ip;
  if (actor?.userAgent && merged.user_agent === undefined) {
    merged.user_agent = actor.userAgent;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function auditLog(input: AuditLogInput): AuditLogRow {
  const id = newAuditLogId();
  const createdAt = new Date().toISOString();
  insertAuditLog.run(
    id,
    input.actor?.userId || null,
    input.actor?.tokenId || null,
    input.actor?.ip || null,
    input.action,
    input.target?.type || null,
    input.target?.id || null,
    jsonOrNull(input.before),
    jsonOrNull(input.after),
    jsonOrNull(metadataWithRequestContext(input.metadata, input.actor)),
    createdAt,
  );
  return getAuditLogEntry(id) as AuditLogRow;
}

export function getAuditActor(c: Context, ctx: SessionContext): AuditActor {
  const forwardedFor = c.req.header('x-forwarded-for') || c.req.header('X-Forwarded-For');
  const ip =
    forwardedFor?.split(',')[0]?.trim() ||
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    null;
  return {
    userId: ctx.user_id || null,
    tokenId: ctx.agent_token_id || null,
    ip,
    userAgent: c.req.header('user-agent') || c.req.header('User-Agent') || null,
  };
}

function rowFromDb(row: Record<string, unknown>): AuditLogRow {
  return {
    id: String(row.id),
    actor_user_id: (row.actor_user_id as string | null) ?? null,
    actor_token_id: (row.actor_token_id as string | null) ?? null,
    actor_ip: (row.actor_ip as string | null) ?? null,
    action: String(row.action),
    target_type: (row.target_type as string | null) ?? null,
    target_id: (row.target_id as string | null) ?? null,
    before_state: parseJson((row.before_state as string | null) ?? null),
    after_state: parseJson((row.after_state as string | null) ?? null),
    metadata: parseJson((row.metadata as string | null) ?? null),
    created_at: String(row.created_at),
  };
}

export function queryAuditLog(query: AuditLogQuery): AuditLogRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.actor_user_id) {
    where.push('actor_user_id = ?');
    params.push(query.actor_user_id);
  }
  if (query.target_type) {
    where.push('target_type = ?');
    params.push(query.target_type);
  }
  if (query.target_id) {
    where.push('target_id = ?');
    params.push(query.target_id);
  }
  if (query.action) {
    where.push('action = ?');
    params.push(query.action);
  }
  if (query.since) {
    where.push('datetime(created_at) >= datetime(?)');
    params.push(query.since);
  }
  params.push(query.limit ?? 100);
  const rows = db
    .prepare(
      `SELECT * FROM audit_log
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

export function getAuditLogEntry(id: string): AuditLogRow | null {
  const row = db.prepare(`SELECT * FROM audit_log WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowFromDb(row) : null;
}

export function sweepAuditLogRetention(logPath = '/var/log/floom-audit-sweep.log'): number {
  const result = db
    .prepare(
      `DELETE FROM audit_log
        WHERE action NOT LIKE 'admin.%'
          AND datetime(created_at) < datetime('now', '-1 year')`,
    )
    .run();
  const count = result.changes || 0;
  const line = `${new Date().toISOString()} deleted=${count}\n`;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line, 'utf8');
  return count;
}

function msUntilNextUtcHour(hour: number, now = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

let auditSweepTimer: NodeJS.Timeout | null = null;

export function startAuditLogRetentionSweeper(): void {
  if (auditSweepTimer) return;
  const schedule = () => {
    auditSweepTimer = setTimeout(() => {
      try {
        sweepAuditLogRetention();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[audit-log] retention sweep failed: ${(err as Error).message}`);
      }
      schedule();
    }, msUntilNextUtcHour(4));
    auditSweepTimer.unref?.();
  };
  schedule();
}
