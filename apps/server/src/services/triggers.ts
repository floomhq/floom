// Triggers service: CRUD + cron-next computation + HMAC signing.
//
// A trigger fires an app run from either a cron schedule or an incoming
// webhook. Both shapes share one table; the dispatcher differs:
//
//   schedule: triggers-worker.ts wakes every 30s, finds
//             trigger_type='schedule' AND enabled=1 AND next_run_at <= NOW,
//             enqueues a job, advances next_run_at to the NEXT valid cron
//             time after now.
//   webhook:  POST /hook/:webhook_url_path verifies
//             X-Floom-Signature: sha256=<hex> against webhook_secret,
//             dedupes on X-Request-ID, enqueues a job.
//
// Kept intentionally thin: the HTTP router owns ownership + validation;
// the worker owns the scheduler loop; this module owns pure helpers and
// storage.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import parser from 'cron-parser';
import { newTriggerId } from '../lib/ids.js';
import type { TriggerRecord, TriggerType } from '../types.js';
import type { StorageAdapter } from '../adapters/types.js';

async function storage(): Promise<StorageAdapter> {
  return (await import('../adapters/index.js')).adapters.storage;
}

/**
 * Generate a 32-char hex webhook secret. 128 bits of entropy is plenty
 * for an HMAC key we don't rotate on every call.
 */
export function generateWebhookSecret(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Generate a URL-safe webhook path suffix. Base32-ish alphabet, 16 chars
 * so collisions are vanishingly unlikely (~10^-24 at 1M triggers).
 */
export function generateWebhookUrlPath(): string {
  // 10 bytes → 20 hex chars; truncate to 16 for shorter URLs while keeping
  // >2^64 entropy. Collisions are caught by the unique index anyway.
  return randomBytes(10).toString('hex').slice(0, 16);
}

/**
 * Compute the next epoch-ms a cron expression is valid AFTER the given
 * epoch-ms. Throws if the expression is invalid — callers should guard
 * with try/catch in route handlers for 400 responses.
 *
 * `tz` is an IANA zone string. Defaults to 'UTC' if null/undefined.
 */
export function nextCronFireMs(
  cronExpression: string,
  afterMs: number,
  tz: string | null | undefined,
): number {
  const interval = parser.parseExpression(cronExpression, {
    currentDate: new Date(afterMs),
    tz: tz || 'UTC',
  });
  return interval.next().getTime();
}

/**
 * Validate a cron expression. Returns `{ ok: true }` if parseable,
 * otherwise `{ ok: false, error }` with the underlying parser error.
 */
export function validateCronExpression(
  cronExpression: string,
  tz: string | null | undefined,
): { ok: true } | { ok: false; error: string } {
  try {
    parser.parseExpression(cronExpression, { tz: tz || 'UTC' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'invalid cron' };
  }
}

// ---------- HMAC signing + verification ----------

/**
 * Compute the X-Floom-Signature header value for a given body.
 * Format: `sha256=<hex>`. Callers (e.g. tests, docs) can use this to
 * produce the matching signature client-side.
 */
export function signWebhookBody(secret: string, body: string): string {
  const hex = createHmac('sha256', secret).update(body, 'utf-8').digest('hex');
  return `sha256=${hex}`;
}

/**
 * Constant-time compare of a received X-Floom-Signature header against
 * the expected signature derived from `secret + body`. Accepts either
 * `sha256=<hex>` or bare `<hex>` for forgiving clients; rejects mismatched
 * length to avoid early-return side channels.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  received: string | null | undefined,
): boolean {
  if (!received) return false;
  const expected = signWebhookBody(secret, body);
  const normalized = received.startsWith('sha256=') ? received : `sha256=${received}`;
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(normalized, 'utf-8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------- CRUD ----------

export interface CreateTriggerInput {
  app_id: string;
  user_id: string;
  workspace_id: string;
  action: string;
  inputs: Record<string, unknown>;
  trigger_type: TriggerType;
  // schedule-only
  cron_expression?: string | null;
  tz?: string | null;
  // webhook fields are generated server-side; callers don't pass them.
  retry_policy?: Record<string, unknown> | null;
}

export async function createTrigger(input: CreateTriggerInput): Promise<TriggerRecord> {
  const id = newTriggerId();
  const now = Date.now();
  const inputsJson = JSON.stringify(input.inputs ?? {});
  const retryJson = input.retry_policy ? JSON.stringify(input.retry_policy) : null;
  let row: TriggerRecord;

  if (input.trigger_type === 'schedule') {
    if (!input.cron_expression) {
      throw new Error('schedule triggers require cron_expression');
    }
    const check = validateCronExpression(input.cron_expression, input.tz);
    if (!check.ok) {
      throw new Error(`invalid cron_expression: ${check.error}`);
    }
    const next = nextCronFireMs(input.cron_expression, now, input.tz);
    row = {
      id,
      app_id: input.app_id,
      user_id: input.user_id,
      workspace_id: input.workspace_id,
      action: input.action,
      inputs: inputsJson,
      trigger_type: 'schedule',
      cron_expression: input.cron_expression,
      tz: input.tz || 'UTC',
      webhook_secret: null,
      webhook_url_path: null,
      next_run_at: next,
      last_fired_at: null,
      enabled: 1,
      retry_policy: retryJson,
      created_at: now,
      updated_at: now,
    };
  } else {
    // webhook: generate secret + url path server-side.
    const secret = generateWebhookSecret();
    const path = generateWebhookUrlPath();
    row = {
      id,
      app_id: input.app_id,
      user_id: input.user_id,
      workspace_id: input.workspace_id,
      action: input.action,
      inputs: inputsJson,
      trigger_type: 'webhook',
      cron_expression: null,
      tz: null,
      webhook_secret: secret,
      webhook_url_path: path,
      next_run_at: null,
      last_fired_at: null,
      enabled: 1,
      retry_policy: retryJson,
      created_at: now,
      updated_at: now,
    };
  }
  return (await storage()).createTrigger(row);
}

export function getTrigger(id: string): Promise<TriggerRecord | undefined> {
  return storage().then((s) => s.getTrigger(id));
}

export function getTriggerByWebhookPath(path: string): Promise<TriggerRecord | undefined> {
  return storage().then((s) => s.getTriggerByWebhookPath(path));
}

export function listTriggersForUser(userId: string): Promise<TriggerRecord[]> {
  return storage().then((s) => s.listTriggersForUser(userId));
}

export function listTriggersForApp(appId: string): Promise<TriggerRecord[]> {
  return storage().then((s) => s.listTriggersForApp(appId));
}

/**
 * Return schedule triggers ready to fire (enabled, next_run_at <= nowMs).
 * The caller claims each row in a BEGIN IMMEDIATE transaction to avoid
 * double-dispatch across multiple workers or replicas.
 */
export function readyScheduleTriggers(nowMs: number): Promise<TriggerRecord[]> {
  return storage().then((s) => s.listDueTriggers(nowMs));
}

/**
 * Atomically advance next_run_at and set last_fired_at. Used by the
 * scheduler worker after enqueueing a job. Returns the updated row.
 *
 * If the trigger has drifted > 1 hour into the past (server was down,
 * DB restored from backup), the worker skips catch-up and resets
 * next_run_at to the next valid cron time after NOW. The caller passes
 * `skipCatchUp=true` in that case and we don't set last_fired_at.
 */
export async function advanceSchedule(
  id: string,
  nowMs: number,
  skipCatchUp: boolean,
): Promise<TriggerRecord | undefined> {
  const row = await getTrigger(id);
  if (!row || row.trigger_type !== 'schedule' || !row.cron_expression) return row;
  const next = nextCronFireMs(row.cron_expression, nowMs, row.tz);
  await (await storage()).advanceTriggerSchedule(id, next, nowMs, undefined, !skipCatchUp);
  return getTrigger(id);
}

/**
 * Mark a webhook trigger as fired (last_fired_at = now). Used after a
 * successful signature verification + enqueue. Does NOT touch next_run_at.
 */
export function markWebhookFired(id: string, nowMs: number): Promise<void> {
  return storage().then((s) => s.markTriggerFired(id, nowMs));
}

export async function updateTrigger(
  id: string,
  patch: {
    enabled?: boolean;
    cron_expression?: string;
    tz?: string;
    inputs?: Record<string, unknown>;
    action?: string;
  },
): Promise<TriggerRecord | undefined> {
  const row = await getTrigger(id);
  if (!row) return undefined;
  const updates: string[] = [];
  const values: unknown[] = [];
  const now = Date.now();

  if (patch.enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.cron_expression !== undefined && row.trigger_type === 'schedule') {
    const check = validateCronExpression(patch.cron_expression, patch.tz ?? row.tz);
    if (!check.ok) throw new Error(`invalid cron_expression: ${check.error}`);
    updates.push('cron_expression = ?');
    values.push(patch.cron_expression);
    // recompute next_run_at
    const nextMs = nextCronFireMs(
      patch.cron_expression,
      now,
      patch.tz ?? row.tz,
    );
    updates.push('next_run_at = ?');
    values.push(nextMs);
  }
  if (patch.tz !== undefined && row.trigger_type === 'schedule') {
    updates.push('tz = ?');
    values.push(patch.tz);
  }
  if (patch.inputs !== undefined) {
    updates.push('inputs = ?');
    values.push(JSON.stringify(patch.inputs));
  }
  if (patch.action !== undefined) {
    updates.push('action = ?');
    values.push(patch.action);
  }

  if (updates.length === 0) return row;
  const storagePatch: Partial<TriggerRecord> = { updated_at: now };
  for (let i = 0; i < updates.length; i++) {
    const col = updates[i]!.split(' = ')[0] as keyof TriggerRecord;
    (storagePatch as Record<string, unknown>)[col] = values[i];
  }
  return (await storage()).updateTrigger(id, storagePatch);
}

export function deleteTrigger(id: string): Promise<boolean> {
  return storage().then((s) => s.deleteTrigger(id));
}

// ---------- Idempotency (incoming webhook dedupe) ----------

const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Record a webhook delivery for idempotency. Returns true if this is a
 * first-time delivery, false if we've seen this (trigger_id, request_id)
 * pair in the last 24h.
 *
 * Uses INSERT OR IGNORE on the primary-key constraint for an atomic
 * first-wins check. Also triggers a lazy GC of rows older than 24h.
 */
export function recordWebhookDelivery(
  triggerId: string,
  requestId: string,
  nowMs: number,
): Promise<boolean> {
  return storage().then((s) => s.recordTriggerWebhookDelivery(
    triggerId,
    requestId,
    nowMs,
    DEDUPE_TTL_MS,
  ));
}

// ---------- Serialization for API responses ----------

export interface PublicTriggerShape {
  id: string;
  app_id: string;
  app_slug?: string;
  action: string;
  inputs: Record<string, unknown>;
  trigger_type: TriggerType;
  cron_expression: string | null;
  tz: string | null;
  webhook_url_path: string | null;
  // webhook_secret is only returned on CREATE (so the creator can copy it).
  // Subsequent GETs mask it — leaking plaintext after create is a loss of
  // confidentiality (anyone with access to /api/me/triggers could replay).
  webhook_secret_set: boolean;
  next_run_at: number | null;
  last_fired_at: number | null;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export function serializeTrigger(
  row: TriggerRecord,
  opts: { app_slug?: string } = {},
): PublicTriggerShape {
  let inputs: Record<string, unknown> = {};
  try {
    inputs = row.inputs ? JSON.parse(row.inputs) : {};
  } catch {
    inputs = {};
  }
  return {
    id: row.id,
    app_id: row.app_id,
    app_slug: opts.app_slug,
    action: row.action,
    inputs,
    trigger_type: row.trigger_type,
    cron_expression: row.cron_expression,
    tz: row.tz,
    webhook_url_path: row.webhook_url_path,
    webhook_secret_set: !!row.webhook_secret,
    next_run_at: row.next_run_at,
    last_fired_at: row.last_fired_at,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
