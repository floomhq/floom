// W4-minimal: product feedback route.
//
// POST /api/feedback  { text, email?, url? }
// Simple in-memory rate limit: 20 calls per rolling hour per IP hash.
// Writes a row to the `feedback` table including user_id / device_id so
// Federico can filter by session when triaging.

import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { resolveUserContext } from '../services/session.js';

export const feedbackRouter = new Hono();

const CreateFeedbackBody = z.object({
  text: z.string().min(1).max(4000),
  email: z.string().email().max(320).optional(),
  url: z.string().max(2000).optional(),
});

// Rolling-window rate limiter. Keyed by an IP hash so we don't log raw IPs.
// 20 calls per 3600 seconds per caller.
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const buckets = new Map<string, number[]>();

function rateLimitHit(ipHash: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const arr = (buckets.get(ipHash) || []).filter((t) => t > cutoff);
  if (arr.length >= RATE_LIMIT) {
    buckets.set(ipHash, arr);
    return true;
  }
  arr.push(now);
  buckets.set(ipHash, arr);
  return false;
}

function hashIp(raw: string | null): string {
  const salt = process.env.FLOOM_FEEDBACK_SALT || 'floom-feedback-v1';
  return createHash('sha256').update(`${salt}:${raw || 'unknown'}`).digest('hex').slice(0, 32);
}

/**
 * POST /api/feedback
 * Body: { text, email?, url? }
 * Returns { ok: true, id } on success, 429 on rate limit.
 */
feedbackRouter.post('/', async (c) => {
  const ctx = await resolveUserContext(c);

  const ipHeader =
    c.req.header('x-forwarded-for') ||
    c.req.header('x-real-ip') ||
    'unknown';
  const ipHash = hashIp(ipHeader.split(',')[0].trim());

  if (rateLimitHit(ipHash)) {
    return c.json(
      { error: 'Too many feedback submissions. Try again in an hour.', code: 'rate_limited' },
      429,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = CreateFeedbackBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }
  const { text, email, url } = parsed.data;

  const id = `fb_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  db.prepare(
    `INSERT INTO feedback
       (id, workspace_id, user_id, device_id, email, url, text, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ctx.workspace_id || null,
    ctx.is_authenticated ? ctx.user_id : null,
    ctx.device_id || null,
    email || null,
    url || null,
    text,
    ipHash,
  );

  // Also log to stdout so Federico sees new feedback in docker logs
  // without needing to run a SQL query.
  // eslint-disable-next-line no-console
  console.log(
    `[feedback] id=${id} user=${ctx.is_authenticated ? ctx.user_id : 'anon'} url=${url || '-'} text="${text.slice(0, 120).replace(/\n/g, ' ')}"`,
  );

  return c.json({ ok: true, id });
});

/**
 * GET /api/feedback — admin list. Returns 403 unless the caller matches
 * FLOOM_FEEDBACK_ADMIN_KEY. For now, exposed only for local debugging.
 */
feedbackRouter.get('/', async (c) => {
  const adminKey = process.env.FLOOM_FEEDBACK_ADMIN_KEY;
  if (!adminKey) {
    return c.json({ error: 'Admin key not configured', code: 'admin_disabled' }, 403);
  }
  const presented =
    c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ||
    c.req.query('admin_key') ||
    '';
  if (presented !== adminKey) {
    return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  }
  const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') || 100)));
  const rows = db
    .prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?')
    .all(limit);
  return c.json({ feedback: rows });
});

/**
 * Reset the in-memory rate-limit bucket. Tests only.
 */
export function _resetFeedbackBucketsForTests(): void {
  buckets.clear();
}
