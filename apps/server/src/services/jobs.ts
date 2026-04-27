// Job queue service (v0.3.0). Thin CRUD + claim helpers on top of the `jobs`
// table. The HTTP router creates jobs, the background worker claims + runs
// them, and both converge on the same storage.
//
// Claiming is delegated to the selected storage adapter so FLOOM_STORAGE is
// authoritative for every job lifecycle transition.
import { adapters } from '../adapters/index.js';
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
  workspace_id?: string | null;
  user_id?: string | null;
  device_id?: string | null;
}

export async function createJob(jobId: string, args: CreateJobInput): Promise<JobRecord> {
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

  return adapters.storage.createJob({
    id: jobId,
    slug: args.app.slug,
    app_id: args.app.id,
    action: args.action,
    status: 'queued',
    input_json: JSON.stringify(args.inputs),
    output_json: null,
    error_json: null,
    run_id: null,
    webhook_url: webhook,
    timeout_ms: timeout,
    max_retries: maxRetries,
    per_call_secrets_json: perCallSecretsJson,
    workspace_id: args.workspace_id ?? null,
    user_id: args.user_id ?? null,
    device_id: args.device_id ?? null,
  });
}

export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  return adapters.storage.getJob(jobId);
}

export async function getJobBySlug(slug: string, jobId: string): Promise<JobRecord | undefined> {
  const row = await getJob(jobId);
  return row?.slug === slug ? row : undefined;
}

/**
 * Atomically mark a queued job as running. Returns the updated row if the
 * claim succeeded, undefined if another worker won the race (or the row
 * moved to a terminal state).
 */
export async function claimJob(jobId: string): Promise<JobRecord | undefined> {
  return adapters.storage.claimJob(jobId);
}

/**
 * Find the next queued job. Returns the oldest-created queued row without
 * claiming it — the caller follows up with `claimJob` to atomically grab it.
 */
export async function nextQueuedJob(): Promise<JobRecord | undefined> {
  return (await adapters.storage.listJobs({ status: 'queued', limit: 1 }))[0];
}

export async function completeJob(
  jobId: string,
  outputs: unknown,
  runId: string | null,
): Promise<JobRecord | undefined> {
  return adapters.storage.markJobComplete(jobId, outputs ?? null, runId);
}

export async function failJob(
  jobId: string,
  error: { message: string; type?: string; details?: unknown },
  runId: string | null,
): Promise<JobRecord | undefined> {
  return adapters.storage.markJobFailed(jobId, error, runId);
}

/**
 * Re-queue a failed job (used by the retry logic). Bumps status back to
 * `queued`, clears timing, keeps attempts count for max_retries checks.
 */
export async function requeueJob(jobId: string): Promise<JobRecord | undefined> {
  await adapters.storage.updateJob(jobId, {
    status: 'queued',
    started_at: null,
    finished_at: null,
    error_json: null,
    run_id: null,
  });
  return getJob(jobId);
}

export async function cancelJob(jobId: string): Promise<JobRecord | undefined> {
  return adapters.storage.cancelJob(jobId);
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

export async function countJobsByStatus(status: JobStatus): Promise<number> {
  return (await adapters.storage.listJobs({ status })).length;
}
