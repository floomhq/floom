// POST /api/waitlist — deploy waitlist email capture for launch 2026-04-27.
//
// Shape: `{ email: string, source?: string, deploy_repo_url?: string, deploy_intent?: string }`.
// Behaviour:
//   - Validates email (RFC-lite check: non-empty, exactly one `@`, `.` in
//     the domain, no whitespace).
//   - Rate-limited per-IP (10/hour) using the project's existing sliding-
//     window implementation in lib/rate-limit.ts. Auth bearer bypass
//     honoured for ops testing.
//   - Idempotent: duplicate emails return 200 `{ok: true}` with the same
//     shape. Never leak whether the email was new.
//   - Stores SHA-256(ip || WAITLIST_IP_HASH_SECRET) hex, never the raw IP.
//   - Sends a plain-text + HTML Resend confirmation via lib/email.ts. Outside
//     the Resend-required production signal, if RESEND_API_KEY is unset
//     (self-host / dev / preview), logs a warning + still persists the signup
//     — per the spec, don't fail the signup just because email delivery isn't
//     configured.
//
// Also mounted at /api/deploy-waitlist as a backward-compat alias so any
// marketing form that already POSTs there keeps working. The legacy
// `deploy_waitlist` table remains untouched; new writes land in
// `waitlist_signups` (see db.ts).

import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { renderWaitlistConfirmationEmail, sendEmail } from '../lib/email.js';
import { extractIp, isRateLimitDisabled } from '../lib/rate-limit.js';
import { hasValidAdminBearer } from '../lib/auth.js';

export const waitlistRouter = new Hono();

// Per-IP hourly cap on waitlist signups. Tight enough to stop spam loops
// against the form; loose enough that a small office behind one NAT can
// still get through. Configurable via env for ops experiments.
const PER_IP_PER_HOUR_DEFAULT = 10;
function getPerIpPerHour(): number {
  const raw = process.env.FLOOM_WAITLIST_IP_PER_HOUR;
  if (!raw) return PER_IP_PER_HOUR_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : PER_IP_PER_HOUR_DEFAULT;
}

// Process-local sliding window for /api/waitlist specifically. Kept
// separate from the runRateLimit store (which keys on 'ip:<addr>' / 'user:'
// / 'app:') so we can use a dedicated per-hour budget without leaking
// capacity into the run surface. Same algorithm as lib/rate-limit.ts.
interface WindowEntry {
  currentStart: number;
  currentCount: number;
  previousCount: number;
  windowMs: number;
}
const waitlistStore = new Map<string, WindowEntry>();

/** Reset the per-IP store. Exported for tests. */
export function __resetWaitlistRateLimitForTests(): void {
  waitlistStore.clear();
}

function incrementAndCheck(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const halfMs = windowMs / 2;
  const entry = waitlistStore.get(key);
  if (!entry) {
    waitlistStore.set(key, {
      currentStart: now,
      currentCount: 1,
      previousCount: 0,
      windowMs,
    });
    return 1 <= limit;
  }
  const elapsed = now - entry.currentStart;
  if (elapsed >= halfMs) {
    const halves = Math.floor(elapsed / halfMs);
    entry.previousCount = halves >= 2 ? 0 : entry.currentCount;
    entry.currentCount = 0;
    entry.currentStart = entry.currentStart + halves * halfMs;
  }
  entry.currentCount += 1;
  const weight = Math.max(0, 1 - (now - entry.currentStart) / halfMs);
  const count = entry.currentCount + Math.floor(entry.previousCount * weight);
  return count <= limit;
}

// RFC-lite email regex. Intentionally permissive — we just need to reject
// obvious garbage ("", "no-at", "a b@c.d") before storing. A stricter
// parser (RFC 5322) is not worth the risk of bouncing valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  if (v.length === 0 || v.length > 320) return false; // RFC 5321 max
  return EMAIL_RE.test(v);
}

function hashIp(ip: string): string {
  const secret = process.env.WAITLIST_IP_HASH_SECRET || 'floom-waitlist-v1';
  return createHash('sha256').update(`${secret}:${ip}`).digest('hex');
}

function sanitizeSource(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().slice(0, 64);
  return v.length > 0 ? v : null;
}

function sanitizeUserAgent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().slice(0, 512);
  return v.length > 0 ? v : null;
}

const DEPLOY_REPO_URL_MAX = 512;
const DEPLOY_INTENT_MAX = 2000;

/**
 * Parse and normalize a user-supplied repo / deploy URL. Returns the
 * canonical href (http/https only) or `null` when the field is omitted /
 * all-whitespace. Throws a string error token for 400 responses.
 */
function parseDeployRepoUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error('invalid_deploy_repo_url');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > DEPLOY_REPO_URL_MAX) {
    throw new Error('invalid_deploy_repo_url');
  }
  let toParse = trimmed;
  if (!toParse.includes('://')) {
    toParse = `https://${toParse}`;
  }
  let u: URL;
  try {
    u = new URL(toParse);
  } catch {
    throw new Error('invalid_deploy_repo_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('invalid_deploy_repo_url');
  }
  if (!u.hostname || u.hostname.length === 0) {
    throw new Error('invalid_deploy_repo_url');
  }
  return u.href;
}

function parseDeployIntent(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error('invalid_deploy_intent');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('invalid_deploy_intent');
  }
  if (trimmed.length > DEPLOY_INTENT_MAX) {
    throw new Error('invalid_deploy_intent');
  }
  return trimmed;
}

export interface WaitlistInsertResult {
  inserted: boolean;
  id: string | null;
}

/**
 * Insert a waitlist row idempotently. Returns `{inserted: true}` on a new
 * row, `{inserted: false}` when the email already exists (matched case-
 * insensitively via the unique index on LOWER(email)).
 *
 * Exported for tests so they can hit the DB layer without spinning up
 * the full Hono app.
 */
export function insertWaitlistSignup(opts: {
  email: string;
  source: string | null;
  user_agent: string | null;
  ip_hash: string | null;
  deploy_repo_url: string | null;
  deploy_intent: string | null;
}): WaitlistInsertResult {
  const id = `wl_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  try {
    // Product-specific: waitlist marketing capture is not part of protocol storage.
    db.prepare(
      `INSERT INTO waitlist_signups (id, email, source, user_agent, ip_hash, deploy_repo_url, deploy_intent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.email,
      opts.source,
      opts.user_agent,
      opts.ip_hash,
      opts.deploy_repo_url,
      opts.deploy_intent,
    );
    return { inserted: true, id };
  } catch (err) {
    // UNIQUE constraint on LOWER(email) → duplicate. Return the existing
    // row's id so callers can still correlate without leaking that the
    // email was pre-existing to the HTTP caller.
    const msg = (err as Error).message || '';
    if (msg.includes('UNIQUE') || msg.includes('constraint')) {
      // Product-specific: waitlist duplicate lookup is not part of protocol storage.
      const existing = db
        .prepare(
          `SELECT id FROM waitlist_signups WHERE LOWER(email) = LOWER(?) LIMIT 1`,
        )
        .get(opts.email) as { id: string } | undefined;
      return { inserted: false, id: existing?.id ?? null };
    }
    throw err;
  }
}

// The confirmation email renderer lives in `lib/email.ts` alongside every
// other transactional template so they all share the same branded chrome
// (green-dot logo bar, serif headings, muted footer with reply hint). We
// used to ship a hand-rolled duplicate layout here that had drifted away
// from the others — no CTA, no greeting, system sans-serif display text.
// Keeping the helper colocated with the other templates is the only way
// to stop that drift.

waitlistRouter.post('/', async (c) => {
  let body: {
    email?: unknown;
    source?: unknown;
    deploy_repo_url?: unknown;
    deploy_intent?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!isValidEmail(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }

  let deployRepoUrl: string | null;
  let deployIntent: string | null;
  try {
    deployRepoUrl = parseDeployRepoUrl(body.deploy_repo_url);
    deployIntent = parseDeployIntent(body.deploy_intent);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid_deploy_repo_url';
    const err =
      msg === 'invalid_deploy_intent' || msg === 'invalid_deploy_repo_url' ? msg : 'invalid_deploy_repo_url';
    return c.json({ error: err }, 400);
  }

  // Rate-limit per-IP. Admin bearer (ops tests) and the explicit
  // FLOOM_RATE_LIMIT_DISABLED escape hatch both bypass.
  const ip = extractIp(c);
  const bypass = isRateLimitDisabled() || hasValidAdminBearer(c);
  if (!bypass) {
    const allowed = incrementAndCheck(
      `waitlist:${ip}`,
      getPerIpPerHour(),
      3600 * 1000,
    );
    if (!allowed) {
      return c.json(
        { error: 'rate_limit_exceeded', retry_after_seconds: 3600 },
        429,
        { 'Retry-After': '3600' },
      );
    }
  }

  const source = sanitizeSource(body.source);
  const userAgent = sanitizeUserAgent(c.req.header('user-agent'));
  const ipHash = ip && ip !== 'unknown' ? hashIp(ip) : null;

  // Idempotent insert — duplicate emails return 200 with the same shape.
  insertWaitlistSignup({
    email,
    source,
    user_agent: userAgent,
    ip_hash: ipHash,
    deploy_repo_url: deployRepoUrl,
    deploy_intent: deployIntent,
  });

  // Fire-and-forget the confirmation email. We DON'T block the response
  // on it: Resend can be slow (>1s) and the signup must feel instant.
  // Outside the Resend-required production signal, the spec explicitly allows
  // persist-without-send when RESEND_API_KEY is missing; lib/email.ts already
  // logs a warning + stdout-fallbacks.
  const publicUrl =
    process.env.PUBLIC_URL ||
    process.env.BETTER_AUTH_URL ||
    'https://floom.dev';
  const { subject, html, text } = renderWaitlistConfirmationEmail({
    publicUrl,
  });
  void sendEmail({ to: email, subject, html, text }).catch((err) => {
    // Never let email delivery cascade into a signup failure.
    // eslint-disable-next-line no-console
    console.error('[waitlist] confirmation email threw:', err);
  });

  return c.json({ ok: true });
});
