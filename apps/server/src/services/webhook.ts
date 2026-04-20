// Webhook delivery for async job completion (v0.3.0).
//
// Floom POSTs `{ job_id, slug, status, output, error, duration_ms }` to the
// creator-declared `webhook_url` when a job reaches a terminal state. The
// delivery retries on 5xx / network errors with exponential backoff. 2xx is
// success, 4xx is a permanent failure (creator must fix their endpoint).
//
// This module is standalone so it can be unit-tested without the worker. The
// worker calls `deliverWebhook` after `completeJob`/`failJob`.

export interface WebhookPayload {
  job_id: string;
  slug: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  output: unknown;
  error: unknown;
  duration_ms: number | null;
  attempts: number;
  /**
   * How this run was initiated. Populated by the worker when the job was
   * enqueued by a trigger (schedule or webhook); 'manual' for direct API
   * calls. Clients should treat `undefined` as 'manual' for backwards
   * compat with v0.3.0 payloads.
   */
  triggered_by?: 'schedule' | 'webhook' | 'manual';
  /** Trigger id (tgr_...) when `triggered_by !== 'manual'`. */
  trigger_id?: string;
}

export interface DeliverOptions {
  /** Max retry attempts on 5xx / network errors. Default 3. */
  maxAttempts?: number;
  /** Initial backoff in ms. Default 500. Doubles each retry. */
  backoffMs?: number;
  /** Request timeout per attempt in ms. Default 10_000. */
  timeoutMs?: number;
  /** Custom fetch (test hook). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface DeliverResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  opts: DeliverOptions = {},
): Promise<DeliverResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Floom-Webhook/0.3.0',
          'x-floom-event': 'job.completed',
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      clearTimeout(timer);
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, attempts: attempt, status: res.status };
      }
      // 4xx: permanent error, no retry. Creator has to fix their endpoint.
      if (res.status >= 400 && res.status < 500) {
        return {
          ok: false,
          attempts: attempt,
          status: res.status,
          error: `Permanent webhook failure: HTTP ${res.status}`,
        };
      }
      // 5xx: fall through and retry
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message || 'fetch failed';
    }

    if (attempt < maxAttempts) {
      const wait = backoffMs * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  return {
    ok: false,
    attempts: maxAttempts,
    status: lastStatus,
    error: lastError || 'webhook delivery failed',
  };
}
