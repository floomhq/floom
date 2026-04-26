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
import { db } from '../db.js';
import { hasValidAdminBearer } from '../lib/auth.js';
import { invalidateHubCache } from '../lib/hub-cache.js';
import { resolveUserContext } from '../services/session.js';
import {
  canonicalVisibility,
  listAuditRows,
  transitionVisibility,
} from '../services/sharing.js';
import type { AppRecord } from '../types.js';

export const adminRouter = new Hono();

// Middleware: every /api/admin route requires either the legacy operator
// bearer or a signed-in Floom user flagged with users.is_admin=1.
adminRouter.use('*', async (c, next) => {
  if (hasValidAdminBearer(c)) return next();
  const ctx = await resolveUserContext(c);
  const user = db
    .prepare(`SELECT is_admin FROM users WHERE id = ?`)
    .get(ctx.user_id) as { is_admin: number } | undefined;
  if (!user || user.is_admin !== 1) {
    return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
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

  const app = db
    .prepare('SELECT id, slug, publish_status FROM apps WHERE slug = ?')
    .get(slug) as Pick<AppRecord, 'id' | 'slug' | 'publish_status'> | undefined;
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  db.prepare(
    `UPDATE apps SET publish_status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(parsed.data.status, app.id);

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

function loadApp(slug: string): AppRecord | undefined {
  return db.prepare(`SELECT * FROM apps WHERE slug = ?`).get(slug) as AppRecord | undefined;
}

function serializeReviewApp(app: AppRecord) {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    author: app.author,
    visibility: canonicalVisibility(app.visibility),
    review_submitted_at: app.review_submitted_at,
    review_decided_at: app.review_decided_at,
    review_decided_by: app.review_decided_by,
    review_comment: app.review_comment,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}

adminRouter.get('/review-queue', (c) => {
  const apps = db
    .prepare(
      `SELECT * FROM apps
        WHERE visibility = 'pending_review'
        ORDER BY COALESCE(review_submitted_at, updated_at) ASC`,
    )
    .all() as AppRecord[];
  return c.json({ apps: apps.map(serializeReviewApp) });
});

adminRouter.get('/review-queue/:slug', (c) => {
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  return c.json({
    app: serializeReviewApp(app),
    manifest: (() => {
      try {
        return JSON.parse(app.manifest);
      } catch {
        return null;
      }
    })(),
  });
});

adminRouter.post('/review-queue/:slug/approve', async (c) => {
  const ctx = await resolveUserContext(c);
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (canonicalVisibility(app.visibility) === 'public_live') {
    return c.json({ ok: true, app: serializeReviewApp(app), idempotent: true });
  }
  if (canonicalVisibility(app.visibility) !== 'pending_review') {
    return c.json({ error: 'App is not pending review', code: 'invalid_review_state' }, 409);
  }
  const next = transitionVisibility(app, 'public_live', {
    actorUserId: ctx.user_id,
    reason: 'admin_approve',
  });
  invalidateHubCache();
  return c.json({ ok: true, app: serializeReviewApp(next) });
});

const RejectBody = z.object({ comment: z.string().min(1).max(10000) });

adminRouter.post('/review-queue/:slug/reject', async (c) => {
  const ctx = await resolveUserContext(c);
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = RejectBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() }, 400);
  }
  if (canonicalVisibility(app.visibility) === 'changes_requested') {
    return c.json({ ok: true, app: serializeReviewApp(app), idempotent: true });
  }
  if (canonicalVisibility(app.visibility) !== 'pending_review') {
    return c.json({ error: 'App is not pending review', code: 'invalid_review_state' }, 409);
  }
  const next = transitionVisibility(app, 'changes_requested', {
    actorUserId: ctx.user_id,
    reason: 'admin_reject',
    comment: parsed.data.comment,
  });
  invalidateHubCache();
  return c.json({ ok: true, app: serializeReviewApp(next) });
});

const TakedownBody = z.object({ reason: z.string().min(1).max(10000).optional() }).optional();

adminRouter.post('/apps/:slug/takedown', async (c) => {
  const ctx = await resolveUserContext(c);
  const app = loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  let body: unknown = undefined;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const parsed = TakedownBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() }, 400);
  }
  const next = transitionVisibility(app, 'private', {
    actorUserId: ctx.user_id,
    reason: 'admin_takedown',
    metadata: { reason: parsed.data?.reason || 'emergency_takedown' },
  });
  invalidateHubCache();
  return c.json({ ok: true, app: serializeReviewApp(next) });
});

adminRouter.get('/audit-log', (c) => {
  const appId = c.req.query('app_id') || null;
  const rows = listAuditRows(appId).map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
  return c.json({ audit_log: rows });
});
