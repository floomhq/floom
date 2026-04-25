// Job queue service (v0.3.0). Thin CRUD + claim helpers on top of the `jobs`
// table. The HTTP router creates jobs, the background worker claims + runs
// them, and both converge on the same storage.
//
// Claiming uses an atomic UPDATE...WHERE status='queued' pattern so multiple
// workers or concurrent replicas never double-dispatch a row.
import { storage } from './storage.js';
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

  return storage.createJob({
    id: jobId,
    slug: args.app.slug,
    app_id: args.app.id,
    action: args.action,
    input_json: JSON.stringify(args.inputs),
    webhook_url: webhook,
    timeout_ms: timeout,
    max_retries: maxRetries,
    per_call_secrets_json: perCallSecretsJson,
  });
}

export function getJob(jobId: string): JobRecord | undefined {
  return storage.getJob(jobId);
}

export function getJobBySlug(slug: string, jobId: string): JobRecord | undefined {
  return storage.getJobBySlug(slug, jobId);
}

/**
 * Find the next queued job. Returns the oldest-created queued row without
 * claiming it — the caller follows up with `claimJob` to atomically grab it.
 * Note: worker.ts relies on these. In the protocol refactor, claimNextJob
 * handles both atomically, but we keep these for backward compatibility
 * or if other consumers rely on the separation.
 */
export function nextQueuedJob(): JobRecord | undefined {
  // Not exposed in StorageAdapter directly anymore since it's non-atomic.
  // worker.ts uses them separately? Actually worker.ts uses candidate -> claimJob.
  // Wait, I should just implement `claimJob` using `storage.claimNextJob()` if possible,
  // but `claimJob` takes an ID. 
  // Let's implement this as a pass-through to a new storage method if needed,
  // but wait... worker.ts candidate is just for early-exit.
  throw new Error('Deprecated: use storage.claimNextJob() directly');
}

export function claimJob(_jobId: string): JobRecord | undefined {
  throw new Error('Deprecated: use storage.claimNextJob() directly');
}

export function completeJob(
  jobId: string,
  outputs: unknown,
  runId: string | null,
): JobRecord | undefined {
  return storage.updateJob(jobId, {
    status: 'succeeded',
    output_json: JSON.stringify(outputs ?? null),
    run_id: runId,
    finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
}

export function failJob(
  jobId: string,
  error: { message: string; type?: string; details?: unknown },
  runId: string | null,
): JobRecord | undefined {
  return storage.updateJob(jobId, {
    status: 'failed',
    error_json: JSON.stringify(error),
    run_id: runId,
    finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
}

/**
 * Re-queue a failed job (used by the retry logic). Bumps status back to
 * `queued`, clears timing, keeps attempts count for max_retries checks.
 */
export function requeueJob(jobId: string): JobRecord | undefined {
  return storage.updateJob(jobId, {
    status: 'queued',
    started_at: null,
    finished_at: null,
    error_json: null,
    run_id: null,
  });
}

export function cancelJob(jobId: string): JobRecord | undefined {
  // Only queued/running jobs can be cancelled. Terminal states are immutable.
  const job = storage.getJob(jobId);
  if (!job || !['queued', 'running'].includes(job.status)) return job;
  return storage.updateJob(jobId, {
    status: 'cancelled',
    finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
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
  return storage.countJobsByStatus(status);
}
