// Background worker for the v0.3.0 async job queue.
//
// Polls `jobs` every JOB_POLL_INTERVAL_MS, atomically claims the oldest
// queued row, dispatches it through the existing `dispatchRun` path so the
// runtime logic (proxied + docker + secrets + log streaming) stays in one
// place. Then waits for the underlying `runs` row to reach a terminal state
// (or the job's timeout_ms to elapse), updates the job, fires the webhook,
// and retries on failure if `max_retries` allows.
//
// One worker per server process. Multiple replicas are safe because the
// storage adapter claim path is atomic.
import { adapters } from '../adapters/index.js';
import { newRunId } from '../lib/ids.js';
import {
  completeJob,
  failJob,
  getJob,
  requeueJob,
} from './jobs.js';
import { dispatchRun } from './runner.js';
import { buildContext } from './session.js';
import { deliverWebhook, type WebhookPayload } from './webhook.js';
import { getJobTriggerContext } from './triggers-worker.js';
import type {
  JobRecord,
  NormalizedManifest,
  RunRecord,
} from '../types.js';

const POLL_INTERVAL_MS = Number(process.env.FLOOM_JOB_POLL_MS || 1000);
const RUN_POLL_INTERVAL_MS = 500;

let running = false;
let loopHandle: NodeJS.Timeout | null = null;

/**
 * Start the background worker. Idempotent — calling twice is a no-op.
 */
export function startJobWorker(): void {
  if (running) return;
  running = true;
  console.log(
    `[worker] starting job queue poller (every ${POLL_INTERVAL_MS}ms)`,
  );
  const tick = async () => {
    if (!running) return;
    try {
      await processOneJob();
    } catch (err) {
      console.error('[worker] processOneJob error:', err);
    } finally {
      if (running) {
        loopHandle = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  };
  loopHandle = setTimeout(tick, POLL_INTERVAL_MS);
}

/**
 * Stop the worker. Used by tests. The current in-flight job (if any) will
 * still finish — we only stop scheduling new polls.
 */
export function stopJobWorker(): void {
  running = false;
  if (loopHandle) clearTimeout(loopHandle);
  loopHandle = null;
}

/**
 * Run one poll cycle. Exported for tests so they can drive the worker
 * deterministically without waiting for the setTimeout loop.
 */
export async function processOneJob(): Promise<JobRecord | null> {
  const claimed = await adapters.storage.claimNextJob();
  if (!claimed) return null;

  const app = await adapters.storage.getAppById(claimed.app_id);
  if (!app) {
    await failJob(claimed.id, { message: `App ${claimed.app_id} not found` }, null);
    await deliverCompletion(claimed.id);
    return claimed;
  }

  let manifest: NormalizedManifest;
  try {
    manifest = JSON.parse(app.manifest) as NormalizedManifest;
  } catch (err) {
    await failJob(
      claimed.id,
      { message: `Manifest corrupted: ${(err as Error).message}` },
      null,
    );
    await deliverCompletion(claimed.id);
    return claimed;
  }

  const inputs =
    claimed.input_json === null
      ? {}
      : (JSON.parse(claimed.input_json) as Record<string, unknown>);
  const perCallSecrets = claimed.per_call_secrets_json
    ? (JSON.parse(claimed.per_call_secrets_json) as Record<string, string>)
    : undefined;
  const ctx = contextFromJob(claimed);

  const runId = newRunId();
  const runInput: Parameters<typeof adapters.storage.createRun>[0] = {
    id: runId,
    app_id: app.id,
    action: claimed.action,
    inputs,
  };
  if (ctx) {
    runInput.workspace_id = ctx.workspace_id;
    runInput.user_id = ctx.user_id;
    runInput.device_id = ctx.device_id;
  }
  await adapters.storage.createRun(runInput);

  await dispatchRun(app, manifest, runId, claimed.action, inputs, perCallSecrets, ctx);

  const run = await waitForRunOrTimeout(runId, claimed.timeout_ms);

  if (!run) {
    // Timed out. Mark the run as timeout if we can, mark the job failed.
    await adapters.storage.updateRun(runId, {
      status: 'timeout',
      error: 'Job timeout exceeded',
      error_type: 'timeout',
      finished: true,
    });
    await handleFailure(claimed.id, {
      message: `Job exceeded timeout_ms=${claimed.timeout_ms}`,
      type: 'timeout',
    }, runId);
    return (await getJob(claimed.id)) || claimed;
  }

  if (run.status === 'success') {
    await completeJob(claimed.id, run.outputs ? safeJsonParse(run.outputs) : null, runId);
    await deliverCompletion(claimed.id);
    return (await getJob(claimed.id)) || claimed;
  }

  // Error / timeout path
  await handleFailure(
    claimed.id,
    {
      message: run.error || `Run finished with status=${run.status}`,
      type: run.error_type || 'runtime_error',
    },
    runId,
  );
  return (await getJob(claimed.id)) || claimed;
}

function contextFromJob(job: JobRecord) {
  if (!job.workspace_id || !job.user_id) {
    console.warn(
      `[worker] job=${job.id} missing persisted session context; using legacy dispatch context`,
    );
    return undefined;
  }
  return buildContext(
    job.workspace_id,
    job.user_id,
    job.device_id || job.user_id,
    !(job.workspace_id === 'local' && job.user_id === 'local'),
  );
}

async function handleFailure(
  jobId: string,
  error: { message: string; type?: string; details?: unknown },
  runId: string | null,
): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  if (job.attempts <= job.max_retries) {
    // Retries remain — re-queue silently. No webhook yet.
    await requeueJob(jobId);
    return;
  }
  await failJob(jobId, error, runId);
  await deliverCompletion(jobId);
}

async function waitForRunOrTimeout(
  runId: string,
  timeoutMs: number,
): Promise<RunRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await adapters.storage.getRun(runId);
    if (row && ['success', 'error', 'timeout'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, RUN_POLL_INTERVAL_MS));
  }
  return null;
}

async function deliverCompletion(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  if (!job.webhook_url) return;

  const status = job.status === 'succeeded' ? 'succeeded' : job.status === 'cancelled' ? 'cancelled' : 'failed';
  let output: unknown = null;
  let error: unknown = null;
  try {
    if (job.output_json) output = JSON.parse(job.output_json);
  } catch {
    // leave null
  }
  try {
    if (job.error_json) error = JSON.parse(job.error_json);
  } catch {
    // leave null
  }
  const duration =
    job.started_at && job.finished_at
      ? new Date(job.finished_at + 'Z').getTime() - new Date(job.started_at + 'Z').getTime()
      : null;

  // Trigger context (unified triggers). When a job was enqueued by a
  // schedule or webhook trigger, include `triggered_by` + `trigger_id`
  // in the outgoing webhook payload so receivers can branch on origin.
  // When no context is found, we default to 'manual' (direct API call).
  const trigCtx = getJobTriggerContext(job.id);
  const triggered_by: 'schedule' | 'webhook' | 'manual' = trigCtx
    ? trigCtx.trigger_type
    : 'manual';

  const payload: WebhookPayload = {
    job_id: job.id,
    slug: job.slug,
    status,
    output,
    error,
    duration_ms: Number.isFinite(duration) ? duration : null,
    attempts: job.attempts,
    triggered_by,
    ...(trigCtx ? { trigger_id: trigCtx.trigger_id } : {}),
  };
  try {
    const result = await deliverWebhook(job.webhook_url, payload);
    if (!result.ok) {
      console.warn(
        `[worker] webhook failed job=${job.id} url=${job.webhook_url} error=${result.error}`,
      );
    }
  } catch (err) {
    console.warn(
      `[worker] webhook threw job=${job.id} url=${job.webhook_url} error=${(err as Error).message}`,
    );
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
