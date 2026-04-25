// Admin surface for Floom operators. Small set of endpoints guarded by the
// shared FLOOM_AUTH_TOKEN bearer (same token used by the global-auth gate
// for self-host deployments). Intentionally minimal — no UI queue, no audit
// log. If FLOOM_AUTH_TOKEN is unset on the server, every admin endpoint
// returns 404 so the surface is invisible in OSS public mode.
//
// Current endpoints:
//   POST /api/admin/apps/:slug/publish-status
//        body: { status: 'published' | 'rejected' | 'pending_review' | 'draft' }
//        Launch-minimum publish-review gate (#362). Flips apps.publish_status
//        for the target slug. See routes/hub.ts for the matching filter.
import { Hono } from 'hono';
import { z } from 'zod';
import { storage } from '../services/storage.js';
import { hasValidAdminBearer } from '../lib/auth.js';
import { invalidateHubCache } from '../lib/hub-cache.js';
import type { AppRecord } from '../types.js';

export const adminRouter = new Hono();

// Middleware: every /api/admin route requires a valid admin bearer. If the
// FLOOM_AUTH_TOKEN env var isn't set on the server, `hasValidAdminBearer`
// returns false and we 404 so the surface doesn't advertise its existence.
adminRouter.use('*', async (c, next) => {
  if (!hasValidAdminBearer(c)) {
    return c.json({ error: 'Not found' }, 404);
  }
  return next();
});

const PublishStatusBody = z.object({
  status: z.enum(['draft', 'pending_review', 'published', 'rejected']),
});

/**
 * POST /api/admin/apps/:slug/publish-status
 *
 * Flip an app's `publish_status`. Launch-minimum (#362): the only way to
 * move an app from 'pending_review' to 'published' on the public Store.
 * Accepts the full enum so operators can also walk an app back to
 * 'pending_review' or set 'rejected' without dropping into SQL.
 *
 * Returns 200 with `{ slug, publish_status }` on success, 404 on unknown
 * slug. Does not touch `visibility` — that's an independent axis.
 */
adminRouter.post('/apps/:slug/publish-status', async (c) => {
  const slug = c.req.param('slug');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = PublishStatusBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const app = storage.getApp(slug);
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  storage.updateApp(app.id, { publish_status: parsed.data.status });

  // The /api/hub list endpoint caches responses for 5s. Bust it so the
  // newly-published app shows up on the Store immediately.
  invalidateHubCache();

  // eslint-disable-next-line no-console
  console.log(
    `[admin] publish_status ${app.publish_status} → ${parsed.data.status} for slug=${slug}`,
  );

  return c.json({
    ok: true,
    slug,
    publish_status: parsed.data.status,
    previous_status: app.publish_status,
  });
});
