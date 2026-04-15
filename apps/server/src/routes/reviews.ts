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
import { db } from '../db.js';
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

  // Summary: count + average rating across ALL workspaces. Reviews are
  // per-app, not per-workspace, so a single app's review list is global.
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(AVG(rating), 0) AS avg
         FROM app_reviews
        WHERE app_slug = ?`,
    )
    .get(slug) as { count: number; avg: number };

  // Recent reviews with a joined display name from users.
  const rows = db
    .prepare(
      `SELECT app_reviews.*, users.name AS author_name, users.email AS author_email
         FROM app_reviews
         LEFT JOIN users ON users.id = app_reviews.user_id
        WHERE app_reviews.app_slug = ?
        ORDER BY app_reviews.created_at DESC
        LIMIT ?`,
    )
    .all(slug, limit) as Array<AppReviewRecord & { author_name: string | null; author_email: string | null }>;

  return c.json({
    summary: {
      count: summary.count || 0,
      avg: Math.round(Number(summary.avg || 0) * 10) / 10,
    },
    reviews: rows.map((r) =>
      serialize(r, r.author_name || (r.author_email ? r.author_email.split('@')[0] : null)),
    ),
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
  const app = db
    .prepare('SELECT id FROM apps WHERE slug = ?')
    .get(slug) as { id: string } | undefined;
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
  const existing = db
    .prepare(
      `SELECT id FROM app_reviews
        WHERE workspace_id = ? AND app_slug = ? AND user_id = ?`,
    )
    .get(ctx.workspace_id, slug, ctx.user_id) as { id: string } | undefined;

  let id: string;
  if (existing) {
    id = existing.id;
    db.prepare(
      `UPDATE app_reviews
          SET rating = ?, title = ?, body = ?, updated_at = ?
        WHERE id = ?`,
    ).run(rating, title ?? null, reviewBody ?? null, now, id);
  } else {
    id = `rev_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    db.prepare(
      `INSERT INTO app_reviews
        (id, workspace_id, app_slug, user_id, rating, title, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      ctx.workspace_id,
      slug,
      ctx.user_id,
      rating,
      title ?? null,
      reviewBody ?? null,
      now,
      now,
    );
  }

  const row = db.prepare('SELECT * FROM app_reviews WHERE id = ?').get(id) as AppReviewRecord;
  return c.json({ review: serialize(row, ctx.email?.split('@')[0] || null) }, existing ? 200 : 201);
});
