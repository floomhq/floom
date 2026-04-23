// POST /api/waitlist — deploy waitlist email capture for launch 2026-04-27.
//
// Shape: `{ email: string, source?: string }`.
// Behaviour:
//   - Validates email (RFC-lite check: non-empty, exactly one `@`, `.` in
//     the domain, no whitespace).
//   - Rate-limited per-IP (10/hour) using the project's existing sliding-
//     window implementation in lib/rate-limit.ts. Auth bearer bypass
//     honoured for ops testing.
//   - Idempotent: duplicate emails return 200 `{ok: true}` with the same
//     shape. Never leak whether the email was new.
//   - Stores SHA-256(ip || WAITLIST_IP_HASH_SECRET) hex, never the raw IP.
//   - Sends a plain-text + HTML Resend confirmation via lib/email.ts. If
//     RESEND_API_KEY is unset (self-host / dev), logs a warning + still
//     persists the signup — per the spec, don't fail the signup just
//     because email delivery isn't configured.
//
// Also mounted at /api/deploy-waitlist as a backward-compat alias so any
// marketing form that already POSTs there keeps working. The legacy
// `deploy_waitlist` table remains untouched; new writes land in
// `waitlist_signups` (see db.ts).

import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { sendEmail } from '../lib/email.js';
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
}): WaitlistInsertResult {
  const id = `wl_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  try {
    db.prepare(
      `INSERT INTO waitlist_signups (id, email, source, user_agent, ip_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, opts.email, opts.source, opts.user_agent, opts.ip_hash);
    return { inserted: true, id };
  } catch (err) {
    // UNIQUE constraint on LOWER(email) → duplicate. Return the existing
    // row's id so callers can still correlate without leaking that the
    // email was pre-existing to the HTTP caller.
    const msg = (err as Error).message || '';
    if (msg.includes('UNIQUE') || msg.includes('constraint')) {
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

function renderConfirmationEmail(): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = "You're on the Floom waitlist";
  const text = [
    'Thanks for signing up.',
    '',
    "You're on the Floom waitlist. We'll email you when your slot opens.",
    '',
    'In the meantime you can still run the featured apps on floom.dev',
    "(lead scoring, competitor analysis, resume screening) — they're",
    'free, no signup required.',
    '',
    '— Floom team',
    '',
    'Floom, Inc. · Wilmington, DE',
    'hello@floom.dev',
  ].join('\n');
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Floom waitlist</title></head>
<body style="margin:0;padding:0;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafaf7;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #eceae3;border-radius:10px;padding:32px;">
<tr><td>
<div style="font-size:18px;font-weight:700;letter-spacing:-0.2px;color:#111;margin-bottom:24px;">Floom</div>
<p style="font-size:15px;line-height:1.55;margin:0 0 16px;">Thanks for signing up.</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 20px;">You&rsquo;re on the Floom waitlist. We&rsquo;ll email you when your slot opens.</p>
<p style="font-size:14px;line-height:1.55;margin:0 0 8px;color:#44413a;">In the meantime, the featured apps on <a href="https://floom.dev" style="color:#111;">floom.dev</a> are free to run &mdash; no signup required.</p>
<p style="font-size:14px;line-height:1.55;margin:24px 0 0;color:#44413a;">&mdash; Floom team</p>
<hr style="border:none;border-top:1px solid #eceae3;margin:32px 0 16px;">
<div style="font-size:12px;color:#77736a;line-height:1.5;">
Floom, Inc. &middot; Wilmington, DE<br>
Questions? <a href="mailto:hello@floom.dev" style="color:#77736a;text-decoration:underline;">hello@floom.dev</a>
</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject, html, text };
}

waitlistRouter.post('/', async (c) => {
  let body: { email?: unknown; source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!isValidEmail(email)) {
    return c.json({ error: 'invalid_email' }, 400);
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
  });

  // Fire-and-forget the confirmation email. We DON'T block the response
  // on it: Resend can be slow (>1s) and the signup must feel instant.
  // The spec explicitly allows persist-without-send when RESEND_API_KEY
  // is missing; lib/email.ts already logs a warning + stdout-fallbacks.
  const { subject, html, text } = renderConfirmationEmail();
  void sendEmail({ to: email, subject, html, text }).catch((err) => {
    // Never let email delivery cascade into a signup failure.
    // eslint-disable-next-line no-console
    console.error('[waitlist] confirmation email threw:', err);
  });

  return c.json({ ok: true });
});
