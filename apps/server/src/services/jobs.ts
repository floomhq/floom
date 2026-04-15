// Job queue service (v0.3.0). Thin CRUD + claim helpers on top of the `jobs`
// table. The HTTP router creates jobs, the background worker claims + runs
// them, and both converge on the same storage.
//
// Claiming uses an atomic UPDATE...WHERE status='queued' pattern so multiple
// workers or concurrent replicas never double-dispatch a row.
import { db } from '../db.js';
import type { AppRecord, JobRecord, JobStatus } from '../types.js';

export const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface CreateJobInput {
  app: AppRecord;
  action: string;
  inputs: Record<string, unknown>;
  webhookUrlOverride?: string | null;
  timeoutMsOverride?: number | null;
  maxRetriesOverride?: number | null;
  perCallSecrets?: Record<string, string> | null;
}

export function createJob(jobId: string, args: CreateJobInput): JobRecord {
  const timeout =
    args.timeoutMsOverride ??
    (args.app.timeout_ms && args.app.timeout_ms > 0 ? args.app.timeout_ms : DEFAULT_JOB_TIMEOUT_MS);
  const maxRetries =
    args.maxRetriesOverride ??
    (typeof args.app.retries === 'number' && args.app.retries >= 0 ? args.app.retries : 0);
  const webhook = args.webhookUrlOverride ?? args.app.webhook_url ?? null;
  const perCallSecretsJson =
    args.perCallSecrets && Object.keys(args.perCallSecrets).length > 0
      ? JSON.stringify(args.perCallSecrets)
      : null;

  db.prepare(
    `INSERT INTO jobs (
       id, slug, app_id, action, status, input_json, webhook_url,
       timeout_ms, max_retries, attempts, per_call_secrets_json
     ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?)`,
  ).run(
    jobId,
    args.app.slug,
    args.app.id,
    args.action,
    JSON.stringify(args.inputs),
    webhook,
    timeout,
    maxRetries,
    perCallSecretsJson,
  );
  const row = getJob(jobId);
  if (!row) throw new Error(`createJob: failed to re-read row ${jobId}`);
  return row;
}

export function getJob(jobId: string): JobRecord | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as
    | JobRecord
    | undefined;
}

export function getJobBySlug(slug: string, jobId: string): JobRecord | undefined {
  return db
    .prepare('SELECT * FROM jobs WHERE id = ? AND slug = ?')
    .get(jobId, slug) as JobRecord | undefined;
}

/**
 * Atomically mark a queued job as running. Returns the updated row if the
 * claim succeeded, undefined if another worker won the race (or the row
 * moved to a terminal state).
 */
export function claimJob(jobId: string): JobRecord | undefined {
  const res = db
    .prepare(
      `UPDATE jobs
         SET status='running',
             started_at=datetime('now'),
             attempts=attempts + 1
       WHERE id = ? AND status = 'queued'`,
    )
    .run(jobId);
  if (res.changes === 0) return undefined;
  return getJob(jobId);
}

/**
 * Find the next queued job. Returns the oldest-created queued row without
 * claiming it — the caller follows up with `claimJob` to atomically grab it.
 */
export function nextQueuedJob(): JobRecord | undefined {
  return db
    .prepare(
      `SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as JobRecord | undefined;
}

export function completeJob(
  jobId: string,
  outputs: unknown,
  runId: string | null,
): JobRecord | undefined {
  db.prepare(
    `UPDATE jobs
       SET status='succeeded',
           output_json=?,
           run_id=?,
           finished_at=datetime('now')
     WHERE id = ?`,
  ).run(JSON.stringify(outputs ?? null), runId, jobId);
  return getJob(jobId);
}

export function failJob(
  jobId: string,
  error: { message: string; type?: string; details?: unknown },
  runId: string | null,
): JobRecord | undefined {
  db.prepare(
    `UPDATE jobs
       SET status='failed',
           error_json=?,
           run_id=?,
           finished_at=datetime('now')
     WHERE id = ?`,
  ).run(JSON.stringify(error), runId, jobId);
  return getJob(jobId);
}

/**
 * Re-queue a failed job (used by the retry logic). Bumps status back to
 * `queued`, clears timing, keeps attempts count for max_retries checks.
 */
export function requeueJob(jobId: string): JobRecord | undefined {
  db.prepare(
    `UPDATE jobs
       SET status='queued',
           started_at=NULL,
           finished_at=NULL,
           error_json=NULL,
           run_id=NULL
     WHERE id = ?`,
  ).run(jobId);
  return getJob(jobId);
}

export function cancelJob(jobId: string): JobRecord | undefined {
  // Only queued/running jobs can be cancelled. Terminal states are immutable.
  const res = db
    .prepare(
      `UPDATE jobs
         SET status='cancelled',
             finished_at=datetime('now')
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(jobId);
  if (res.changes === 0) return getJob(jobId);
  return getJob(jobId);
}

/**
 * Format a job row for API responses. Parses JSON blobs, hides internal
 * columns (per_call_secrets_json), and exposes a stable shape to clients.
 */
export function formatJob(row: JobRecord): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    app_id: row.app_id,
    action: row.action,
    status: row.status,
    input: safeParseJson(row.input_json),
    output: safeParseJson(row.output_json),
    error: safeParseJson(row.error_json),
    run_id: row.run_id,
    webhook_url: row.webhook_url,
    timeout_ms: row.timeout_ms,
    max_retries: row.max_retries,
    attempts: row.attempts,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function safeParseJson(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function countJobsByStatus(status: JobStatus): number {
  const row = db
    .prepare('SELECT COUNT(*) as n FROM jobs WHERE status = ?')
    .get(status) as { n: number };
  return row.n;
}
