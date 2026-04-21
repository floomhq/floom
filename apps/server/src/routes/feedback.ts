// W4-minimal + smart-feedback: product feedback routes.
//
// Three endpoints share this router:
//
//   POST /api/feedback          Legacy one-shot: text -> DB row. Kept so pre-
//                               smart-feedback deploys and older clients keep
//                               working. Rate-limited at 20/hr per IP hash.
//
//   POST /api/feedback/parse    Smart-feedback step 1: text -> Gemini ->
//                               { title, description, bucket }. Does NOT
//                               store anything; the parse stays cheap and
//                               idempotent so the UI can re-run it.
//
//   POST /api/feedback/submit   Smart-feedback step 2: files a GitHub issue
//                               on floomhq/floom with `source/feedback` +
//                               `type/<bucket>` labels, stores a row in
//                               `feedback` for the admin inbox, optionally
//                               stores an email-on-resolve subscription in
//                               `feedback_notifications`, returns the issue
//                               URL + number. Rate-limited at 3/day per IP
//                               hash (tighter than /parse — submitting
//                               spawns real GitHub issues).
//
// The simple in-memory rate limiter is shared with POST / so we don't open
// a second abuse surface on /submit. /parse inherits the existing bucket
// (Gemini is cheap — the abuse vector is GitHub issues).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { resolveUserContext } from '../services/session.js';
import {
  parseFeedbackWithGemini,
  FEEDBACK_BUCKETS,
  type FeedbackBucket,
} from '../lib/gemini.js';
import { fileGitHubIssue, GitHubIssueError } from '../lib/github.js';

export const feedbackRouter = new Hono();

const CreateFeedbackBody = z.object({
  text: z.string().min(1).max(4000),
  email: z.string().email().max(320).optional(),
  url: z.string().max(2000).optional(),
});

const ParseFeedbackBody = z.object({
  text: z.string().min(1).max(4000),
});

const SubmitFeedbackBody = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(8000),
  bucket: z.enum(FEEDBACK_BUCKETS as unknown as [FeedbackBucket, ...FeedbackBucket[]]),
  email: z.string().email().max(320).optional().nullable(),
  notify: z.boolean().optional().default(false),
  url: z.string().max(2000).optional(),
});

// ---------- Rate limiter ----------
// `default` bucket: 20 calls / hour / IP — POST / (legacy) shares with /parse.
// `submit` bucket: 3 calls / day / IP — the expensive path that creates
// real GitHub issues. A tighter budget here stops a single spammer from
// flooding our triage inbox even if they have a fast connection.
const DEFAULT_RATE_LIMIT = 20;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
const SUBMIT_RATE_LIMIT = 3;
const SUBMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const defaultBuckets = new Map<string, number[]>();
const submitBuckets = new Map<string, number[]>();

function rateLimitHit(
  ipHash: string,
  buckets: Map<string, number[]>,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = (buckets.get(ipHash) || []).filter((t) => t > cutoff);
  if (arr.length >= limit) {
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

function ipHashFor(c: Context): string {
  const ipHeader =
    c.req.header('x-forwarded-for') ||
    c.req.header('x-real-ip') ||
    'unknown';
  return hashIp(ipHeader.split(',')[0].trim());
}

/**
 * POST /api/feedback
 * Body: { text, email?, url? }
 * Legacy one-shot feedback capture. Returns { ok: true, id } on success.
 */
feedbackRouter.post('/', async (c) => {
  const ctx = await resolveUserContext(c);
  const ipHash = ipHashFor(c);

  if (rateLimitHit(ipHash, defaultBuckets, DEFAULT_RATE_LIMIT, DEFAULT_WINDOW_MS)) {
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

  // eslint-disable-next-line no-console
  console.log(
    `[feedback] id=${id} user=${ctx.is_authenticated ? ctx.user_id : 'anon'} url=${url || '-'} text="${text.slice(0, 120).replace(/\n/g, ' ')}"`,
  );

  return c.json({ ok: true, id });
});

/**
 * POST /api/feedback/parse
 * Body: { text }
 * Returns { title, description, bucket } from Gemini (or a safe fallback).
 * Stateless — does not persist. Uses the default (hourly) rate limit since
 * it's cheap and users may re-run after tweaking the paste.
 */
feedbackRouter.post('/parse', async (c) => {
  const ipHash = ipHashFor(c);
  if (rateLimitHit(ipHash, defaultBuckets, DEFAULT_RATE_LIMIT, DEFAULT_WINDOW_MS)) {
    return c.json(
      { error: 'Too many parse requests. Try again in an hour.', code: 'rate_limited' },
      429,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = ParseFeedbackBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }

  const result = await parseFeedbackWithGemini(parsed.data.text);
  return c.json(result);
});

/**
 * POST /api/feedback/submit
 * Body: { title, description, bucket, email?, notify?, url? }
 *
 * Files a GitHub issue on floomhq/floom with source/feedback + type/<bucket>
 * labels. Stores a row in `feedback` for the legacy admin inbox so every
 * filed issue is also queryable via GET /api/feedback. Stores a row in
 * `feedback_notifications` when `notify=true` and an email is resolvable
 * (signed-in user.email OR explicit body.email). Returns the new issue URL
 * + number.
 *
 * Rate-limited at 3/day per IP hash (tighter than /parse — this path
 * creates real GitHub issues).
 */
feedbackRouter.post('/submit', async (c) => {
  const ctx = await resolveUserContext(c);
  const ipHash = ipHashFor(c);

  if (rateLimitHit(ipHash, submitBuckets, SUBMIT_RATE_LIMIT, SUBMIT_WINDOW_MS)) {
    return c.json(
      { error: 'Too many submissions today. Try again tomorrow.', code: 'rate_limited' },
      429,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = SubmitFeedbackBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid body shape', code: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }
  const { title, description, bucket, email, notify, url } = parsed.data;

  // Prefer the signed-in user's email over the posted one — the UI only
  // sends `email` when the user is signed out. This keeps the "signed in
  // = trusted email" invariant: we never trust a client-supplied email
  // when we already know who they are.
  const effectiveEmail: string | null = ctx.is_authenticated && ctx.email
    ? ctx.email
    : (email || null);

  // Build the issue body. Include light context (URL, user mode) so the
  // triage team can reproduce without chasing. Never include the IP hash
  // or device id — those stay on the `feedback` table for admin-only
  // access.
  const trailer: string[] = [];
  if (url) trailer.push(`Page: ${url}`);
  trailer.push(
    ctx.is_authenticated
      ? `Reporter: ${ctx.email || ctx.user_id} (signed in)`
      : 'Reporter: anonymous',
  );
  if (notify && effectiveEmail) trailer.push(`Notify on close: yes`);

  const issueBody = [description.trim(), '', '---', trailer.join(' · ')].join('\n');

  let issue: { url: string; number: number };
  try {
    issue = await fileGitHubIssue({ title: title.trim(), body: issueBody, bucket });
  } catch (err) {
    if (err instanceof GitHubIssueError) {
      // eslint-disable-next-line no-console
      console.error(
        `[feedback/submit] GitHub error code=${err.code} status=${err.status ?? '-'} msg=${err.message}`,
      );
      // 503 when the server is misconfigured (operator issue, not caller),
      // 502 when GitHub itself barfed. Either way the caller can retry.
      const status = err.code === 'github_config_missing' ? 503 : 502;
      return c.json({ error: err.message, code: err.code }, status);
    }
    // eslint-disable-next-line no-console
    console.error(`[feedback/submit] unexpected error`, err);
    return c.json(
      { error: 'Failed to file feedback issue', code: 'github_unknown' },
      500,
    );
  }

  // Persist the legacy feedback row so /api/feedback (admin inbox) still
  // surfaces everything in one place alongside the pre-smart-feedback
  // entries. Stored with the raw description text (post-parse), plus the
  // filed issue URL so the inbox can link out.
  const fbId = `fb_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  db.prepare(
    `INSERT INTO feedback
       (id, workspace_id, user_id, device_id, email, url, text, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fbId,
    ctx.workspace_id || null,
    ctx.is_authenticated ? ctx.user_id : null,
    ctx.device_id || null,
    effectiveEmail,
    url || issue.url,
    // Store the title + description in one blob so the inbox stays single-
    // column; the filed-issue URL in `url` makes the pairing traceable.
    `${title.trim()}\n\n${description.trim()}`,
    ipHash,
  );

  // Notification subscription (store-only for launch; a follow-up worker
  // will flip `resolved_at` when the issue closes). Skip silently when
  // the caller opted out or didn't give us an email — no point storing a
  // subscription without a delivery address.
  if (notify && effectiveEmail) {
    const notifId = `fn_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    db.prepare(
      `INSERT INTO feedback_notifications
         (id, github_issue_number, email, user_id, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(
      notifId,
      issue.number,
      effectiveEmail,
      ctx.is_authenticated ? ctx.user_id : null,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[feedback/submit] issue=#${issue.number} bucket=${bucket} user=${ctx.is_authenticated ? ctx.user_id : 'anon'} notify=${notify && effectiveEmail ? 'yes' : 'no'}`,
  );

  return c.json({ issue_url: issue.url, issue_number: issue.number });
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
  defaultBuckets.clear();
  submitBuckets.clear();
}
