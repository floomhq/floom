// Admin surface for Floom operators. Small set of endpoints guarded by the
// shared FLOOM_AUTH_TOKEN bearer (same token used by the global-auth gate
// for self-host deployments) or a signed-in admin user.
//
// Current endpoints:
//   POST /api/admin/apps/:slug/publish-status
//        body: { status: 'published' | 'rejected' | 'pending_review' | 'draft' }
//        Launch-minimum publish-review gate (#362). Flips apps.publish_status
//        for the target slug. See routes/hub.ts for the matching filter.
import { Hono } from 'hono';
import { z } from 'zod';
import { adapters } from '../adapters/index.js';
import { db } from '../db.js';
import { hasValidAdminBearer } from '../lib/auth.js';
import { isCloudMode } from '../lib/better-auth.js';
import { invalidateHubCache } from '../lib/hub-cache.js';
import { auditLog, getAuditActor, getAuditLogEntry, queryAuditLog } from '../services/audit-log.js';
import { resolveUserContext } from '../services/session.js';
import { listPendingAccountDeletes } from '../services/account-deletion.js';
import {
  canonicalVisibility,
  transitionVisibility,
} from '../services/sharing.js';
import type { AppRecord } from '../types.js';

export const adminRouter = new Hono();

// Middleware: every /api/admin route requires either the legacy operator
// bearer or a signed-in Floom user flagged with users.is_admin=1.
adminRouter.use('*', async (c, next) => {
  if (hasValidAdminBearer(c)) return next();
  const ctx = await resolveUserContext(c);
  if (isCloudMode() && !ctx.is_authenticated) {
    return c.json({ error: 'Unauthorized', code: 'auth_required' }, 401);
  }
  const user = await adapters.storage.getUser(ctx.user_id);
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

  const ctx = await resolveUserContext(c);
  const app = await adapters.storage.getApp(slug);
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);

  await adapters.storage.updateApp(slug, { publish_status: parsed.data.status });

  // The /api/hub list endpoint caches responses for 5s. Bust it so the
  // newly-published app shows up on the Store immediately.
  invalidateHubCache();
  auditLog({
    actor: getAuditActor(c, ctx),
    action:
      parsed.data.status === 'published'
        ? 'admin.app_approved'
        : parsed.data.status === 'rejected'
          ? 'admin.app_rejected'
          : 'admin.app_publish_status_changed',
    target: { type: 'app', id: app.id },
    before: { publish_status: app.publish_status },
    after: { publish_status: parsed.data.status },
    metadata: { slug },
  });

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

async function loadApp(slug: string): Promise<AppRecord | undefined> {
  return adapters.storage.getApp(slug);
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

adminRouter.get('/review-queue/:slug', async (c) => {
  const app = await loadApp(c.req.param('slug') || '');
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
  const app = await loadApp(c.req.param('slug') || '');
  if (!app) return c.json({ error: 'App not found', code: 'not_found' }, 404);
  if (canonicalVisibility(app.visibility) === 'public_live') {
    return c.json({ ok: true, app: serializeReviewApp(app), idempotent: true });
  }
  if (canonicalVisibility(app.visibility) !== 'pending_review') {
    return c.json({ error: 'App is not pending review', code: 'invalid_review_state' }, 409);
  }
  const next = await transitionVisibility(app, 'public_live', {
    actorUserId: ctx.user_id,
    actorTokenId: ctx.agent_token_id,
    actorIp: getAuditActor(c, ctx).ip,
    reason: 'admin_approve',
  });
  invalidateHubCache();
  return c.json({ ok: true, app: serializeReviewApp(next) });
});

const RejectBody = z.object({ comment: z.string().min(1).max(10000) });

adminRouter.post('/review-queue/:slug/reject', async (c) => {
  const ctx = await resolveUserContext(c);
  const app = await loadApp(c.req.param('slug') || '');
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
  const next = await transitionVisibility(app, 'changes_requested', {
    actorUserId: ctx.user_id,
    actorTokenId: ctx.agent_token_id,
    actorIp: getAuditActor(c, ctx).ip,
    reason: 'admin_reject',
    comment: parsed.data.comment,
  });
  invalidateHubCache();
  return c.json({ ok: true, app: serializeReviewApp(next) });
});

const TakedownBody = z.object({ reason: z.string().min(1).max(10000).optional() }).optional();

adminRouter.post('/apps/:slug/takedown', async (c) => {
  const ctx = await resolveUserContext(c);
  const app = await loadApp(c.req.param('slug') || '');
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
  const next = await transitionVisibility(app, 'private', {
    actorUserId: ctx.user_id,
    actorTokenId: ctx.agent_token_id,
    actorIp: getAuditActor(c, ctx).ip,
    reason: 'admin_takedown',
    metadata: { reason: parsed.data?.reason || 'emergency_takedown' },
  });
  invalidateHubCache();
  return c.json({ ok: true, app: serializeReviewApp(next) });
});

const AuditQuerySchema = z.object({
  actor_user_id: z.string().min(1).max(256).optional(),
  target: z
    .string()
    .min(3)
    .max(512)
    .regex(/^[a-z_][a-z0-9_]*:.+$/)
    .optional(),
  app_id: z.string().min(1).max(256).optional(),
  action: z.string().min(1).max(128).regex(/^[a-z0-9_.-]+$/).optional(),
  since: z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

adminRouter.get('/audit-log/:id', (c) => {
  const id = c.req.param('id') || '';
  if (!/^audit_[A-Za-z0-9_-]+/.test(id)) {
    return c.json({ error: 'Invalid audit log id', code: 'invalid_id' }, 400);
  }
  const entry = getAuditLogEntry(id);
  if (!entry) return c.json({ error: 'Audit log entry not found', code: 'not_found' }, 404);
  return c.json({ entry });
});

adminRouter.get('/audit-log', (c) => {
  const parsed = AuditQuerySchema.safeParse({
    actor_user_id: c.req.query('actor_user_id') || undefined,
    target: c.req.query('target') || undefined,
    app_id: c.req.query('app_id') || undefined,
    action: c.req.query('action') || undefined,
    since: c.req.query('since') || undefined,
    limit: c.req.query('limit') || undefined,
  });
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', code: 'invalid_query', details: parsed.error.flatten() }, 400);
  }
  let targetType: string | undefined;
  let targetId: string | undefined;
  if (parsed.data.target) {
    const separator = parsed.data.target.indexOf(':');
    targetType = parsed.data.target.slice(0, separator);
    targetId = parsed.data.target.slice(separator + 1);
  }
  if (parsed.data.app_id) {
    targetType = 'app';
    targetId = parsed.data.app_id;
  }
  const rows = queryAuditLog({
    actor_user_id: parsed.data.actor_user_id,
    target_type: targetType,
    target_id: targetId,
    action: parsed.data.action,
    since: parsed.data.since,
    limit: parsed.data.limit,
  });
  return c.json({ audit_log: rows });
});

adminRouter.get('/pending-deletes', (c) => {
  return c.json({ users: listPendingAccountDeletes() });
});
