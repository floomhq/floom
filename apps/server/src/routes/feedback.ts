// W4-minimal: product feedback route.
//
// POST /api/feedback  { text, email?, url? }
// Simple in-memory rate limit: 20 calls per rolling hour per IP hash.
// Writes a row to the `feedback` table including user_id / device_id so
// Federico can filter by session when triaging.
//
// When FEEDBACK_GITHUB_TOKEN is set, ALSO files a GitHub issue on
// floomhq/floom (or the repo named by FEEDBACK_GITHUB_REPO) with the
// `source/feedback` label. The route returns the filed issue number +
// URL so the client can show "Filed #123 — view on GitHub" in the
// success state. If the token is unset, issue filing is silently
// skipped — feedback still lands in the DB table.

import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { storage } from '../services/storage.js';
import { resolveUserContext } from '../services/session.js';
import { AUTH_DOCS_URL } from '../lib/auth.js';
import {
  fileFeedbackIssue,
  isFeedbackGitHubConfigured,
  FeedbackGitHubError,
} from '../lib/feedback-github.js';

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
  storage.createFeedback({
    id,
    workspace_id: ctx.workspace_id || null,
    user_id: ctx.is_authenticated ? ctx.user_id : null,
    device_id: ctx.device_id || null,
    email: email || null,
    url: url || null,
    text,
    ip_hash: ipHash,
  });

  // Also log to stdout so Federico sees new feedback in docker logs
  // without needing to run a SQL query.
  // eslint-disable-next-line no-console
  console.log(
    `[feedback] id=${id} user=${ctx.is_authenticated ? ctx.user_id : 'anon'} url=${url || '-'} text="${text.slice(0, 120).replace(/\n/g, ' ')}"`,
  );

  // Best-effort GitHub issue filing. If the token is unset we skip; if
  // GitHub 4xx/5xx's we log and still return success to the client with
  // the DB row id — the user's submission is not lost and rate limit was
  // already spent.
  let issue_number: number | undefined;
  let issue_url: string | undefined;
  let issue_error: string | undefined;
  if (isFeedbackGitHubConfigured()) {
    try {
      const filed = await fileFeedbackIssue({
        text,
        email: email || null,
        url: url || null,
        reporter: ctx.is_authenticated ? ctx.user_id : null,
      });
      issue_number = filed.number;
      issue_url = filed.url;
      // eslint-disable-next-line no-console
      console.log(
        `[feedback] filed GH issue #${filed.number} id=${id} url=${filed.url}`,
      );
    } catch (err) {
      const e = err as FeedbackGitHubError;
      issue_error = e.code || 'unknown';
      // eslint-disable-next-line no-console
      console.warn(
        `[feedback] GH issue filing failed id=${id} code=${issue_error} status=${e.status || 'n/a'} msg=${(e.message || '').slice(0, 200)}`,
      );
    }
  }

  return c.json({
    ok: true,
    id,
    ...(issue_number ? { issue_number, issue_url } : {}),
    ...(issue_error ? { issue_error } : {}),
  });
});

/**
 * GET /api/feedback — admin list. Returns 403 unless the caller matches
 * FLOOM_FEEDBACK_ADMIN_KEY. For now, exposed only for local debugging.
 *
 * Security (CSO P1-5, 2026-04-23): the admin key must be presented via
 * `Authorization: Bearer <key>` or `X-Admin-Key: <key>`. Query-string
 * delivery is rejected with 401 — putting secrets in URLs leaks them to
 * nginx access logs, browser history, the Referer header if the admin
 * clicks a link from the JSON response, and upstream CDN/APM logs
 * (Sentry breadcrumbs, Cloudflare). The old `?admin_key=` path is NOT
 * silently ignored — we explicitly 401 so the bad usage is discoverable.
 */
feedbackRouter.get('/', async (c) => {
  const adminKey = process.env.FLOOM_FEEDBACK_ADMIN_KEY;
  if (!adminKey) {
    return c.json(
      {
        error: 'Admin key not configured',
        code: 'admin_disabled',
        hint: 'The feedback admin endpoint is disabled on this server. Contact your Floom administrator to enable it.',
        docs_url: AUTH_DOCS_URL,
      },
      403,
    );
  }
  // Reject admin keys in the URL query string. Fail loud — we want the
  // client to fix the call, not to silently accept the worse credential
  // transport. Also reject on any non-empty query param even if the
  // value doesn't match, so rotating secrets over a leaked URL isn't
  // misinterpreted as "still works."
  if (c.req.query('admin_key')) {
    return c.json(
      {
        error: 'Admin key must be sent via Authorization: Bearer or X-Admin-Key header, never in the URL.',
        code: 'admin_key_in_query',
        hint: 'Resend the request with the admin key in the Authorization: Bearer header (or X-Admin-Key).',
        docs_url: AUTH_DOCS_URL,
      },
      401,
    );
  }
  const presented =
    c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ||
    c.req.header('x-admin-key') ||
    '';
  if (presented !== adminKey) {
    return c.json(
      {
        error: 'Unauthorized',
        code: 'unauthorized',
        hint: 'Present the feedback admin key via Authorization: Bearer <key> or X-Admin-Key. Contact your Floom administrator if you need access.',
        docs_url: AUTH_DOCS_URL,
      },
      401,
    );
  }
  const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') || 100)));
  const rows = storage.listFeedback(limit);
  return c.json({ feedback: rows });
});

/**
 * Reset the in-memory rate-limit bucket. Tests only.
 */
export function _resetFeedbackBucketsForTests(): void {
  buckets.clear();
}
