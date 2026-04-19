// Transactional email delivery for Floom.
//
// Backs Better Auth's `emailAndPassword.sendResetPassword` (and any future
// email hook we wire into the auth config). Resend is the only provider
// we currently support; the hard part (DKIM, SPF, DMARC on send.floom.dev)
// is already done at the DNS layer.
//
// Graceful degradation: when `RESEND_API_KEY` is unset, every call logs
// the intended payload to stdout and returns. This keeps local dev and
// self-host installs that don't want to touch email provider accounts
// working — the password-reset URL shows up in the server log so an
// operator can copy/paste it. Boot does NOT crash when the key is absent.
//
// Sender: `Floom <noreply@send.floom.dev>`. The `send.floom.dev` subdomain
// carries the Resend DKIM key (resend._domainkey.floom.dev). Root floom.dev
// SPF already includes amazonses.com, which is what Resend routes through.

import { Resend } from 'resend';

const DEFAULT_FROM = 'Floom <noreply@send.floom.dev>';

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailResult {
  ok: boolean;
  /** Provider-assigned message id when `ok`, or a short reason when not. */
  id?: string;
  reason?: string;
}

let cachedClient: Resend | null | undefined;

/**
 * Lazy Resend client. Returns null when `RESEND_API_KEY` is unset, which
 * toggles stdout-fallback mode. Cached so the first log about the fallback
 * only fires once per process.
 */
function getClient(): Resend | null {
  if (cachedClient !== undefined) return cachedClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // eslint-disable-next-line no-console
    console.warn(
      '[email] RESEND_API_KEY is not set — password-reset and verification ' +
        'emails will be logged to stdout instead of delivered. Set the env var ' +
        'to enable real email delivery via Resend (https://resend.com).',
    );
    cachedClient = null;
    return null;
  }
  cachedClient = new Resend(key);
  return cachedClient;
}

/**
 * Send a transactional email via Resend. Returns `{ ok: true, id }` on
 * success, `{ ok: true, reason: 'stdout_fallback' }` when no API key is
 * configured, and `{ ok: false, reason }` on provider error. Never throws —
 * email failures must not cascade into auth-flow failures (Better Auth
 * already logs the reset URL to its own logger anyway).
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
  const { to, subject, html, text } = payload;
  const client = getClient();
  const from = process.env.RESEND_FROM || DEFAULT_FROM;

  if (!client) {
    // Stdout fallback. We print a compact log line that operators can parse
    // and a full dump of the rendered HTML so a human can eyeball the
    // reset link in dev.
    // eslint-disable-next-line no-console
    console.log(
      `[email:stdout] to=${to} subject="${subject}" (set RESEND_API_KEY to deliver)`,
    );
    // eslint-disable-next-line no-console
    console.log(`[email:stdout] text:\n${text}`);
    return { ok: true, reason: 'stdout_fallback' };
  }

  try {
    const res = await client.emails.send({
      from,
      to,
      subject,
      html,
      text,
    });
    // Resend returns `{ data: { id }, error }`. Surface the provider's id
    // when we have one so callers can correlate in logs.
    if (res && typeof res === 'object' && 'error' in res && res.error) {
      const err = res.error as { name?: string; message?: string };
      const reason = `resend_error: ${err.name || 'unknown'} ${err.message || ''}`.trim();
      // eslint-disable-next-line no-console
      console.error(`[email] send failed to=${to} subject="${subject}" ${reason}`);
      return { ok: false, reason };
    }
    const id =
      res && typeof res === 'object' && 'data' in res && res.data
        ? ((res.data as { id?: string }).id ?? undefined)
        : undefined;
    return { ok: true, id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[email] send threw to=${to} subject="${subject}" ${reason}`);
    return { ok: false, reason };
  }
}

/** Tests only. Drops the cached client so env-var changes take effect. */
export function _resetEmailForTests(): void {
  cachedClient = undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function baseLayout(body: string): string {
  // Minimal inline-CSS layout. No images, no trackers.
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Floom</title></head>
<body style="margin:0;padding:0;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fafaf7;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #eceae3;border-radius:10px;padding:32px;">
<tr><td>
<div style="font-size:18px;font-weight:700;letter-spacing:-0.2px;color:#111;margin-bottom:24px;">Floom</div>
${body}
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
}

export interface ResetPasswordTemplateInput {
  /** Optional display name. Falls back to a neutral greeting when absent. */
  name?: string | null;
  /** Full URL including token. Better Auth builds this for us. */
  resetUrl: string;
}

export function renderResetPasswordEmail(input: ResetPasswordTemplateInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Reset your Floom password';
  const greeting = input.name ? `Hi ${escapeHtml(input.name)},` : 'Hi,';
  const safeUrl = escapeHtml(input.resetUrl);

  const body = `
<p style="font-size:15px;line-height:1.55;margin:0 0 16px;">${greeting}</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 20px;">We got a request to reset the password on your Floom account. Click the button below to choose a new one.</p>
<p style="margin:24px 0;"><a href="${safeUrl}" style="display:inline-block;background:#111;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600;">Reset password</a></p>
<p style="font-size:13px;line-height:1.55;margin:0 0 16px;color:#44413a;">Or paste this link into your browser:<br><a href="${safeUrl}" style="color:#44413a;word-break:break-all;">${safeUrl}</a></p>
<p style="font-size:12px;line-height:1.55;margin:16px 0 0;color:#77736a;">If you didn't request this, ignore this email. The link expires in 1 hour.</p>
`;

  const text = [
    input.name ? `Hi ${input.name},` : 'Hi,',
    '',
    'We got a request to reset the password on your Floom account.',
    'Open this link to choose a new one:',
    '',
    input.resetUrl,
    '',
    "If you didn't request this, ignore this email. The link expires in 1 hour.",
    '',
    'Floom, Inc. · Wilmington, DE',
    'hello@floom.dev',
  ].join('\n');

  return { subject, html: baseLayout(body), text };
}

export interface WelcomeTemplateInput {
  name?: string | null;
  publicUrl: string;
}

export function renderWelcomeEmail(input: WelcomeTemplateInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Welcome to Floom';
  const greeting = input.name ? `Hi ${escapeHtml(input.name)},` : 'Hi,';
  const buildUrl = `${input.publicUrl.replace(/\/+$/, '')}/studio/build`;
  const safeBuild = escapeHtml(buildUrl);

  const body = `
<p style="font-size:15px;line-height:1.55;margin:0 0 16px;">${greeting}</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 20px;">Your account is live. Your first app is one URL paste away.</p>
<p style="margin:24px 0;"><a href="${safeBuild}" style="display:inline-block;background:#111;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600;">Build your first app</a></p>
<p style="font-size:13px;line-height:1.55;margin:0 0 8px;color:#44413a;">If you get stuck, just reply to this email.</p>
`;

  const text = [
    input.name ? `Hi ${input.name},` : 'Hi,',
    '',
    'Your account is live. Your first app is one URL paste away:',
    buildUrl,
    '',
    'If you get stuck, just reply to this email.',
    '',
    'Floom, Inc. · Wilmington, DE',
    'hello@floom.dev',
  ].join('\n');

  return { subject, html: baseLayout(body), text };
}
