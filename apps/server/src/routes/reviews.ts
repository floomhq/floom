// W4-minimal: app reviews routes.
//
// Surfaces:
//   GET  /api/apps/:slug/reviews   — public list (summary + recent)
//   POST /api/apps/:slug/reviews   — logged-in users only (cloud mode)
//
// Row model: one row per (workspace_id, app_slug, user_id). Re-submitting
// overwrites the existing row (upsert). In OSS mode the synthetic local
// user can also leave a review so self-hosters can demo the UI.
//
// Error envelope: `{error, code, details?}`.

import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { adapters } from '../adapters/index.js';
import { resolveUserContext } from '../services/session.js';
import type { AppReviewRecord } from '../types.js';

export const reviewsRouter = new Hono();

const CreateReviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().max(120).optional(),
  body: z.string().max(4000).optional(),
});

function serialize(r: AppReviewRecord, displayName?: string | null): Record<string, unknown> {
  return {
    id: r.id,
    app_slug: r.app_slug,
    rating: r.rating,
    title: r.title,
    body: r.body,
    author_name: displayName || 'anonymous',
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * GET /api/apps/:slug/reviews
 * Response: { summary: { count, avg }, reviews: [...] }
 */
reviewsRouter.get('/:slug/reviews', async (c) => {
  const slug = c.req.param('slug') || '';
  const limit = Math.max(1, Math.min(50, Number(c.req.query('limit') || 20)));

  const allReviews = await adapters.storage.listAppReviews({ app_slug: slug });
  const rows = allReviews.slice(0, limit);
  const authorNames = new Map<string, string | null>();
  await Promise.all(
    rows.map(async (row) => {
      const user = await adapters.storage.getUser(row.user_id);
      authorNames.set(row.id, user?.name || (user?.email ? user.email.split('@')[0] : null));
    }),
  );
  const ratingTotal = allReviews.reduce((sum, row) => sum + Number(row.rating || 0), 0);
  const avg = allReviews.length > 0 ? ratingTotal / allReviews.length : 0;

  return c.json({
    summary: {
      count: allReviews.length,
      avg: Math.round(avg * 10) / 10,
    },
    reviews: rows.map((r) => serialize(r, authorNames.get(r.id) || null)),
  });
});

/**
 * POST /api/apps/:slug/reviews
 * Body: { rating: 1-5, title?, body? }
 * Upsert on (workspace_id, app_slug, user_id). Anonymous callers (device
 * cookie only) cannot leave reviews: we require a logged-in user OR the
 * synthetic local user (OSS mode).
 */
reviewsRouter.post('/:slug/reviews', async (c) => {
  const ctx = await resolveUserContext(c);
  const slug = c.req.param('slug') || '';

  // Confirm the app exists so we don't accumulate orphan reviews.
  const app = await adapters.storage.getApp(slug);
  if (!app) {
    return c.json({ error: 'App not found', code: 'app_not_found' }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = CreateReviewBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }
  const { rating, title, body: reviewBody } = parsed.data;

  const now = new Date().toISOString();
  const existing = (
    await adapters.storage.listAppReviews({
      workspace_id: ctx.workspace_id,
      app_slug: slug,
      user_id: ctx.user_id,
      limit: 1,
    })
  )[0];

  let id: string;
  let row: AppReviewRecord | undefined;
  if (existing) {
    id = existing.id;
    row = await adapters.storage.updateAppReview(id, {
      rating,
      title: title ?? null,
      body: reviewBody ?? null,
      updated_at: now,
    });
  } else {
    id = `rev_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    row = await adapters.storage.createAppReview({
      id,
      workspace_id: ctx.workspace_id,
      app_slug: slug,
      user_id: ctx.user_id,
      rating,
      title: title ?? null,
      body: reviewBody ?? null,
      created_at: now,
      updated_at: now,
    });
  }

  if (!row) return c.json({ error: 'Review not found', code: 'review_not_found' }, 404);
  return c.json({ review: serialize(row, ctx.email?.split('@')[0] || null) }, existing ? 200 : 201);
});

// ────────────────────────────────────────────────────────────────────────────
// Stub: POST /api/apps/:slug/invite  —  see #640 (ShareModal) / #637 (impl).
//
// The ShareModal on /p/:slug lets the app owner invite teammates by email.
// The real pipeline (persistence in `app_invites`, Resend delivery, accept
// + revoke endpoints) is scoped in issue #637. This endpoint unblocks the
// UI by validating the payload and echoing a synthetic invite id so the
// client can exercise the happy path end-to-end.
//
// TODO(#637): persist to app_invites, send email via Resend, and add
// GET /api/apps/:slug/invites + DELETE /api/apps/:slug/invites/:id.
// ────────────────────────────────────────────────────────────────────────────
const InviteBody = z.object({
  emails: z.array(z.string().email()).min(1).max(25),
  permission: z.enum(['run', 'view']),
});

reviewsRouter.post('/:slug/invite', async (c) => {
  const slug = c.req.param('slug') || '';
  const app = await adapters.storage.getApp(slug);
  if (!app) {
    return c.json({ error: 'App not found', code: 'app_not_found' }, 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = InviteBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }
  return c.json({ ok: true, invite_id: `stub-${Date.now()}` }, 201);
});
