// POST /hook/:webhook_url_path — public, signature-verified incoming webhook.
//
// Flow:
//   1. Resolve the trigger row by webhook_url_path. 404 if not found.
//   2. Verify X-Floom-Signature: sha256=<hex> against HMAC(body, secret).
//      401 on mismatch. Uses timing-safe compare.
//   3. Idempotency: if X-Request-ID (or X-GitHub-Delivery / Stripe-Signature-
//      timestamp) is present, dedupe within 24h. 200 on replay (no re-fire).
//   4. Validate the trigger is enabled + the app is active. 409 otherwise.
//   5. Enqueue a job via the existing job queue (v0.3.0). Tag with the
//      trigger id so the outgoing webhook payload can include
//      `triggered_by: 'webhook'`.
//   6. Return 204 No Content (the response body is irrelevant; the external
//      sender cares about the HTTP status).
//
// This router intentionally does NOT live under /api/* — the global auth
// middleware (FLOOM_AUTH_TOKEN) would require a bearer token and external
// senders can't provide one. The HMAC signature is the auth.
import { Hono } from 'hono';
import { adapters } from '../adapters/index.js';
import { AUTH_DOCS_URL, AUTH_HINT_SIGNATURE } from '../lib/auth.js';
import { newJobId } from '../lib/ids.js';
import { createJob } from '../services/jobs.js';
import {
  getTriggerByWebhookPath,
  markWebhookFired,
  recordWebhookDelivery,
  verifyWebhookSignature,
} from '../services/triggers.js';
import { attachWebhookTriggerContext } from '../services/triggers-worker.js';
import type { AppRecord, NormalizedManifest } from '../types.js';

export const webhookRouter = new Hono();

webhookRouter.post('/:path', async (c) => {
  const path = c.req.param('path');
  const trigger = await getTriggerByWebhookPath(path);
  if (!trigger) {
    // Return 404 to avoid leaking path-existence signals via timing.
    return c.json({ error: 'Webhook not found' }, 404);
  }
  if (trigger.trigger_type !== 'webhook' || !trigger.webhook_secret) {
    // Inconsistent state: schedule row somehow has webhook_url_path, or
    // webhook row is missing its secret. Treat as 404 so we don't leak.
    return c.json({ error: 'Webhook not found' }, 404);
  }

  // Raw body — MUST be the exact bytes the sender signed. Hono's .text()
  // reads the body without parsing.
  const body = await c.req.text();
  const sig = c.req.header('x-floom-signature') || c.req.header('X-Floom-Signature') || null;
  if (!verifyWebhookSignature(trigger.webhook_secret, body, sig)) {
    return c.json(
      {
        error: 'Invalid signature',
        code: 'bad_signature',
        hint: AUTH_HINT_SIGNATURE,
        docs_url: AUTH_DOCS_URL,
      },
      401,
    );
  }

  if (trigger.enabled !== 1) {
    // Silently accept (200) so the sender doesn't retry-storm. But DON'T fire.
    // Chose 200 over 409 because most webhook senders treat 4xx as "stop
    // retrying this forever" and 5xx as "retry", and we want neither —
    // disabled triggers should just ignore until re-enabled.
    return new Response(null, { status: 204 });
  }

  // Idempotency: dedupe on X-Request-ID (or common vendor headers).
  // Missing request-id → no dedupe (sender takes the risk of replay).
  const requestId =
    c.req.header('x-request-id') ||
    c.req.header('X-Request-Id') ||
    c.req.header('x-github-delivery') ||
    c.req.header('X-GitHub-Delivery') ||
    null;
  if (requestId) {
    const isFresh = await recordWebhookDelivery(trigger.id, requestId, Date.now());
    if (!isFresh) {
      // Replay. Respond 200 with a dedupe hint so the sender knows we saw it.
      return c.json({ ok: true, deduped: true, request_id: requestId }, 200);
    }
  }

  // Load the app; 409 if it's been deleted out from under us (the FK cascade
  // would normally delete the trigger too, but be defensive).
  const app = await adapters.storage.getAppById(trigger.app_id) as AppRecord | undefined;
  if (!app) {
    return c.json({ error: 'App no longer exists', code: 'app_missing' }, 409);
  }
  if (app.status !== 'active') {
    return c.json(
      { error: `App is ${app.status}, cannot run`, code: 'app_inactive' },
      409,
    );
  }

  let manifest: NormalizedManifest;
  try {
    manifest = JSON.parse(app.manifest);
  } catch {
    return c.json(
      { error: 'App manifest is corrupted', code: 'manifest_invalid' },
      500,
    );
  }

  // Merge stored inputs with any JSON body. Body wins — this lets callers
  // pass dynamic values at fire time without hard-coding them in the trigger.
  let storedInputs: Record<string, unknown> = {};
  try {
    storedInputs = trigger.inputs ? JSON.parse(trigger.inputs) : {};
  } catch {
    storedInputs = {};
  }
  let bodyInputs: Record<string, unknown> = {};
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Reserve top-level `inputs` so senders can distinguish the "hey,
        // here are replacement inputs" case from the "here's my whole
        // opaque payload" case. If the body has a top-level `inputs` key,
        // merge from there; otherwise treat the whole body as extra context
        // that doesn't override the stored inputs.
        if (
          'inputs' in (parsed as Record<string, unknown>) &&
          typeof (parsed as Record<string, unknown>).inputs === 'object' &&
          (parsed as Record<string, unknown>).inputs !== null
        ) {
          bodyInputs = (parsed as Record<string, Record<string, unknown>>).inputs;
        }
      }
    } catch {
      // non-JSON body is fine; stored inputs are used as-is.
    }
  }
  const mergedInputs = { ...storedInputs, ...bodyInputs };

  if (!manifest.actions[trigger.action]) {
    return c.json(
      {
        error: `Action "${trigger.action}" is not declared on this app`,
        code: 'invalid_action',
      },
      409,
    );
  }

  const jobId = newJobId();
  try {
    await createJob(jobId, {
      app,
      action: trigger.action,
      inputs: mergedInputs,
      webhookUrlOverride: undefined,
      timeoutMsOverride: null,
      maxRetriesOverride: null,
      perCallSecrets: null,
    });
    attachWebhookTriggerContext(jobId, trigger.id);
    await markWebhookFired(trigger.id, Date.now());
  } catch (err) {
    console.error(
      `[webhook] enqueue failed trigger=${trigger.id}:`,
      err,
    );
    return c.json(
      { error: 'Enqueue failed', code: 'enqueue_failed' },
      500,
    );
  }

  // 204 No Content: sender only cares about the 2xx. Return a Location
  // header pointing at the job so callers that want to poll can.
  return new Response(null, {
    status: 204,
    headers: {
      location: `/api/${app.slug}/jobs/${jobId}`,
      'x-floom-job-id': jobId,
      'x-floom-trigger-id': trigger.id,
    },
  });
});
