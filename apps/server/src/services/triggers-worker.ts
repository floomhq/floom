// Scheduler worker for schedule-type triggers.
//
// Runs in the same process as the HTTP server (no separate container).
// Every TRIGGERS_POLL_INTERVAL_MS it:
//   1. Finds schedule triggers where enabled=1 AND next_run_at <= now.
//   2. For each one, in a BEGIN IMMEDIATE transaction: re-reads the row,
//      checks next_run_at is still <= now, advances next_run_at to the
//      NEXT valid cron time, commits. If the claim race is lost, skips.
//   3. Enqueues a job on the existing job queue (v0.3.0). The job carries
//      the trigger_id + trigger_type so the outgoing webhook on
//      completion can set `triggered_by`.
//
// Clock-drift / catch-up: if next_run_at has slipped > 1 hour into the
// past (server was down, DB was restored), we skip the missed fire and
// reset next_run_at to the next valid cron time AFTER now. No catch-up
// storm. If drifted < 1 hour, we fire once and advance.
//
// One worker per process is enough (cron accuracy is 30s). Multiple
// replicas are safe because the claim uses BEGIN IMMEDIATE.
import { db } from '../db.js';
import { newJobId } from '../lib/ids.js';
import { createJob } from './jobs.js';
import {
  nextCronFireMs,
  readyScheduleTriggers,
} from './triggers.js';
import type { AppRecord, TriggerRecord } from '../types.js';
import type { StorageAdapter } from '../adapters/types.js';

async function storage(): Promise<StorageAdapter> {
  return (await import('../adapters/index.js')).adapters.storage;
}

const POLL_INTERVAL_MS = Number(process.env.FLOOM_TRIGGERS_POLL_MS || 30_000);
const CATCH_UP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

let running = false;
let loopHandle: NodeJS.Timeout | null = null;

export function startTriggersWorker(): void {
  if (running) return;
  running = true;
  console.log(
    `[triggers-worker] starting scheduler poller (every ${POLL_INTERVAL_MS}ms)`,
  );
  const tick = async () => {
    if (!running) return;
    try {
      await tickOnce();
    } catch (err) {
      console.error('[triggers-worker] tick error:', err);
    } finally {
      if (running) {
        loopHandle = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  };
  loopHandle = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopTriggersWorker(): void {
  running = false;
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
}

/**
 * Single tick. Exported for tests so they can drive the worker
 * deterministically without waiting for setTimeout. Returns the number
 * of triggers fired this tick.
 */
export async function tickOnce(): Promise<number> {
  const now = Date.now();
  const ready = await readyScheduleTriggers(now);
  let fired = 0;
  for (const trigger of ready) {
    try {
      fired += (await processTrigger(trigger, now)) ? 1 : 0;
    } catch (err) {
      console.error(
        `[triggers-worker] failed trigger=${trigger.id} app=${trigger.app_id}:`,
        err,
      );
    }
  }
  return fired;
}

/**
 * Atomically claim + fire one trigger. Returns true if a job was enqueued.
 *
 * Claim race: we use a narrow UPDATE ... WHERE next_run_at = <the value
 * we read> so if another worker already advanced next_run_at, our UPDATE
 * is a no-op and we skip. This is cheaper than BEGIN IMMEDIATE and gives
 * the same at-most-once guarantee for the fire step (job enqueue itself
 * is idempotent against the same trigger because the job id is fresh
 * every call, but double-enqueue would double-fire the app).
 */
async function processTrigger(trigger: TriggerRecord, now: number): Promise<boolean> {
  if (!trigger.cron_expression) return false;
  const readNextRun = trigger.next_run_at;
  if (readNextRun === null) return false;

  // Catch-up policy: if we're > 1h late, reset without firing.
  const drift = now - readNextRun;
  if (drift > CATCH_UP_WINDOW_MS) {
    console.warn(
      `[triggers-worker] trigger=${trigger.id} drifted ${Math.round(drift / 1000)}s (> 1h), skipping catch-up`,
    );
    const nextMs = nextCronFireMs(trigger.cron_expression, now, trigger.tz);
    // Claim: only update if no one else already advanced it.
    await (await storage()).advanceTriggerSchedule(
      trigger.id,
      nextMs,
      now,
      readNextRun,
      false,
    );
    return false;
  }

  // Load the app; if it's been deleted under us (CASCADE would normally
  // remove the trigger, but belt-and-suspenders), skip.
  const app = (await (await storage()).getAppById(trigger.app_id)) as AppRecord | undefined;
  if (!app || app.status !== 'active') {
    console.warn(
      `[triggers-worker] trigger=${trigger.id} app missing or inactive, skipping`,
    );
    // Still advance so we don't hot-loop.
    const nextMs = nextCronFireMs(trigger.cron_expression, now, trigger.tz);
    await (await storage()).advanceTriggerSchedule(
      trigger.id,
      nextMs,
      now,
      readNextRun,
      false,
    );
    return false;
  }

  // Validate action still exists on the manifest.
  let manifestActions: Record<string, unknown> = {};
  try {
    const m = JSON.parse(app.manifest || '{}');
    manifestActions = m.actions || {};
  } catch {
    // fall through
  }
  if (!manifestActions[trigger.action]) {
    console.warn(
      `[triggers-worker] trigger=${trigger.id} action="${trigger.action}" not in manifest, skipping`,
    );
    const nextMs = nextCronFireMs(trigger.cron_expression, now, trigger.tz);
    await (await storage()).advanceTriggerSchedule(
      trigger.id,
      nextMs,
      now,
      readNextRun,
      false,
    );
    return false;
  }

  let inputs: Record<string, unknown> = {};
  try {
    inputs = trigger.inputs ? JSON.parse(trigger.inputs) : {};
  } catch {
    inputs = {};
  }

  // Claim step: advance next_run_at atomically. If another worker won
  // the race, our UPDATE changes 0 rows and we skip the fire.
  const nextMs = nextCronFireMs(trigger.cron_expression, now, trigger.tz);
  const claimed = await (await storage()).advanceTriggerSchedule(
    trigger.id,
    nextMs,
    now,
    readNextRun,
    true,
  );
  if (!claimed) {
    return false; // another worker won
  }

  // Enqueue a job. For async apps this goes through the job queue worker
  // (existing v0.3.0 path). For non-async apps we still enqueue — the
  // job worker handles both by invoking dispatchRun identically.
  const jobId = newJobId();
  try {
    await createJob(jobId, {
      app,
      action: trigger.action,
      inputs,
      // Tag the job so the outgoing webhook (v0.3.0 delivery path) can
      // include `triggered_by` context. Uses webhookUrlOverride=null to
      // keep the app's default webhook target (creators don't lose their
      // existing delivery).
      webhookUrlOverride: undefined,
      timeoutMsOverride: null,
      maxRetriesOverride: null,
      perCallSecrets: null,
    });
    // Attach trigger context to the job for the webhook payload. We
    // store it in per_call_secrets_json is wrong; use a dedicated path.
    // Simpler: stash in the jobs table via a side-channel column? We
    // don't have one yet. Instead, we record the trigger id in a
    // separate (job_id, trigger_id) ledger so the completion hook can
    // look it up without a schema change.
    markJobTriggerContext(jobId, trigger.id, trigger.trigger_type);
    console.log(
      `[triggers-worker] fired trigger=${trigger.id} app=${app.slug} action=${trigger.action} job=${jobId}`,
    );
    return true;
  } catch (err) {
    console.error(
      `[triggers-worker] enqueue failed trigger=${trigger.id}:`,
      err,
    );
    return false;
  }
}

// ---------- Job <-> trigger context ledger ----------
//
// A lightweight in-memory + DB-backed map from job_id → (trigger_id,
// trigger_type). Used by the completion webhook to include the
// `triggered_by` field. Kept in-memory as the primary path (fast, no
// extra query) with a DB row as durable fallback across restarts.

const jobTriggerContext = new Map<string, { trigger_id: string; trigger_type: 'schedule' | 'webhook' }>();

function markJobTriggerContext(
  jobId: string,
  triggerId: string,
  triggerType: 'schedule' | 'webhook',
): void {
  jobTriggerContext.set(jobId, { trigger_id: triggerId, trigger_type: triggerType });
  // Durable fallback: stash in a side table so a restart doesn't lose
  // context for in-flight jobs. Created lazily on first use to avoid
  // boot-time schema ordering issues.
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
    console.warn('[triggers-worker] could not persist job trigger context:', err);
  }
}

export function getJobTriggerContext(
  jobId: string,
): { trigger_id: string; trigger_type: 'schedule' | 'webhook' } | null {
  const mem = jobTriggerContext.get(jobId);
  if (mem) return mem;
  try {
    const row = db
      .prepare(
        'SELECT trigger_id, trigger_type FROM job_trigger_context WHERE job_id = ?',
      )
      .get(jobId) as { trigger_id: string; trigger_type: string } | undefined;
    if (row) {
      return {
        trigger_id: row.trigger_id,
        trigger_type: row.trigger_type as 'schedule' | 'webhook',
      };
    }
  } catch {
    // table doesn't exist yet; no context
  }
  return null;
}

/**
 * Mark a job as triggered by a webhook. Called by the POST /hook/:path
 * handler after successful signature verification + enqueue.
 */
export function attachWebhookTriggerContext(
  jobId: string,
  triggerId: string,
): void {
  markJobTriggerContext(jobId, triggerId, 'webhook');
}
