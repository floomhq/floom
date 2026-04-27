// /api/:slug/jobs — async job queue endpoints (v0.3.0).
//
// Only apps with `is_async = 1` accept calls here. The flow is:
//
//   POST /api/:slug/jobs            → enqueue, return job_id (fast, <50ms)
//   GET  /api/:slug/jobs/:job_id    → current state (poll until finished)
//   POST /api/:slug/jobs/:job_id/cancel  → cancel a queued/running job
//
// The background worker (services/worker.ts) drains the queue and fires the
// creator's webhook_url on completion.
import { Hono } from 'hono';
import { adapters } from '../adapters/index.js';
import { newJobId } from '../lib/ids.js';
import { createJob, formatJob, getJobBySlug, cancelJob } from '../services/jobs.js';
import { validateInputs, ManifestError } from '../services/manifest.js';
import { checkAppVisibility } from '../lib/auth.js';
import { resolveUserContext } from '../services/session.js';
import { parseJsonBody, bodyParseError } from '../lib/body.js';
import type { NormalizedManifest } from '../types.js';

export const jobsRouter = new Hono<{ Variables: { slug: string } }>();

function buildJobUrls(publicUrl: string, slug: string, jobId: string) {
  return {
    poll_url: `${publicUrl}/api/${slug}/jobs/${jobId}`,
    webhook_url_template: `${publicUrl}/api/${slug}/jobs/${jobId}`,
    cancel_url: `${publicUrl}/api/${slug}/jobs/${jobId}/cancel`,
  };
}

/**
 * POST /api/:slug/jobs — enqueue a job on an async app.
 */
jobsRouter.post('/', async (c) => {
  const slug = c.req.param('slug') || '';
  const row = await adapters.storage.getApp(slug);
  if (!row) return c.json({ error: `App not found: ${slug}` }, 404);
  if (row.status !== 'active') {
    return c.json({ error: `App is ${row.status}, cannot run` }, 409);
  }
  const ctx = await resolveUserContext(c);
  const blocked = await checkAppVisibility(c, row.visibility || 'public', {
    app_id: row.id,
    slug: row.slug,
    author: row.author,
    workspace_id: row.workspace_id,
    link_share_token: row.link_share_token,
    link_share_requires_auth: row.link_share_requires_auth,
    ctx,
  });
  if (blocked) return blocked;

  if (!row.is_async) {
    return c.json(
      {
        error: `App ${slug} is not async. Use POST /api/${slug}/run instead.`,
      },
      400,
    );
  }

  let manifest: NormalizedManifest;
  try {
    manifest = JSON.parse(row.manifest) as NormalizedManifest;
  } catch {
    return c.json({ error: 'App manifest is corrupted' }, 500);
  }

  // 2026-04-20 (P2 #146): reject malformed JSON before touching the queue.
  // Same rationale as POST /api/:slug/run — truncated bodies would previously
  // fall through to `{}` and enqueue a job on empty inputs.
  const parsed = await parseJsonBody(c);
  if (parsed.kind === 'error') return bodyParseError(c, parsed);
  const body = parsed.value as {
    action?: unknown;
    inputs?: unknown;
    webhook_url?: unknown;
    timeout_ms?: unknown;
    max_retries?: unknown;
    _auth?: unknown;
  };

  const actionNames = Object.keys(manifest.actions);
  const actionName =
    (typeof body.action === 'string' && body.action) ||
    (manifest.actions.run ? 'run' : actionNames[0]);
  const actionSpec = manifest.actions[actionName];
  if (!actionSpec) {
    return c.json({ error: `Action "${actionName}" not found` }, 400);
  }

  let validated: Record<string, unknown>;
  try {
    validated = validateInputs(
      actionSpec,
      (body.inputs as Record<string, unknown>) ?? {},
    );
  } catch (err) {
    const e = err as ManifestError;
    return c.json({ error: e.message, field: e.field }, 400);
  }

  const perCallSecrets =
    body._auth && typeof body._auth === 'object' && body._auth !== null
      ? Object.fromEntries(
          Object.entries(body._auth as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string' && v.length > 0,
          ),
        ) as Record<string, string>
      : undefined;

  const jobId = newJobId();
  createJob(jobId, {
    app: row,
    action: actionName,
    inputs: validated,
    webhookUrlOverride:
      typeof body.webhook_url === 'string' ? body.webhook_url : null,
    timeoutMsOverride:
      typeof body.timeout_ms === 'number' && body.timeout_ms > 0
        ? body.timeout_ms
        : null,
    maxRetriesOverride:
      typeof body.max_retries === 'number' && body.max_retries >= 0
        ? body.max_retries
        : null,
    perCallSecrets,
  });

  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3051}`;
  const urls = buildJobUrls(publicUrl, slug, jobId);
  return c.json(
    {
      job_id: jobId,
      status: 'queued',
      ...urls,
    },
    202,
  );
});

/**
 * GET /api/:slug/jobs/:job_id — latest snapshot.
 */
jobsRouter.get('/:job_id', async (c) => {
  const slug = c.req.param('slug') || '';
  const jobId = c.req.param('job_id') || '';
  const app = await adapters.storage.getApp(slug);
  if (!app) return c.json({ error: `App not found: ${slug}` }, 404);
  const ctx = await resolveUserContext(c);
  const blocked = await checkAppVisibility(c, app.visibility || 'public', {
    app_id: app.id,
    slug: app.slug,
    author: app.author,
    workspace_id: app.workspace_id,
    link_share_token: app.link_share_token,
    link_share_requires_auth: app.link_share_requires_auth,
    ctx,
  });
  if (blocked) return blocked;
  const job = getJobBySlug(slug, jobId);
  if (!job) return c.json({ error: `Job not found: ${jobId}` }, 404);
  return c.json(formatJob(job));
});

/**
 * POST /api/:slug/jobs/:job_id/cancel — cancel a queued or running job.
 */
jobsRouter.post('/:job_id/cancel', async (c) => {
  const slug = c.req.param('slug') || '';
  const jobId = c.req.param('job_id') || '';
  const app = await adapters.storage.getApp(slug);
  if (!app) return c.json({ error: `App not found: ${slug}` }, 404);
  const ctx = await resolveUserContext(c);
  const blocked = await checkAppVisibility(c, app.visibility || 'public', {
    app_id: app.id,
    slug: app.slug,
    author: app.author,
    workspace_id: app.workspace_id,
    link_share_token: app.link_share_token,
    link_share_requires_auth: app.link_share_requires_auth,
    ctx,
  });
  if (blocked) return blocked;
  const job = getJobBySlug(slug, jobId);
  if (!job) return c.json({ error: `Job not found: ${jobId}` }, 404);
  const updated = cancelJob(jobId);
  return c.json(formatJob(updated || job));
});
