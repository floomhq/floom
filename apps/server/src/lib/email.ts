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

// ─────────────────────────────────────────────────────────────────────────
// Branded email chrome
//
// Email clients are a mess. Gmail strips <style> tags, Outlook on Windows
// ignores half the CSS spec, dark-mode clients invert colors unpredictably.
// So every template is a <table>-based layout with inline styles and no
// external assets — the chrome below matches the floom.dev look-and-feel
// without depending on images (Gmail's image-block-by-default would hide
// any logo we shipped as an <img>).
//
// Palette matches `apps/web/src/styles/globals.css` tokens:
//   --bg:     #f8f5ef   (cream page background)
//   --card:   #ffffff   (email card)
//   --line:   #eceae3   (borders / rules)
//   --ink:    #1c1a14   (primary text)
//   --muted:  #6b6659   (secondary text)
//   --accent: #0a9d63   (green dot, link hovers in body)
//
// Typography mirrors the site pairing: Georgia as a web-safe stand-in for
// Fraunces on display copy, system sans for running text.
// ─────────────────────────────────────────────────────────────────────────

const EMAIL_BG = '#f8f5ef';
const EMAIL_CARD = '#ffffff';
const EMAIL_LINE = '#eceae3';
const EMAIL_INK = '#1c1a14';
const EMAIL_MUTED = '#6b6659';
const EMAIL_ACCENT = '#0a9d63';
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

interface BaseLayoutOpts {
  /** Serif display heading that leads the email. */
  heading: string;
  /** Main body HTML, already escaped where needed. */
  body: string;
  /** Optional preheader — the inbox-preview snippet shown next to the
   *  subject line. Hidden in the rendered email. */
  preheader?: string;
}

/**
 * Wrap a template body in the shared Floom email chrome.
 *
 * Structure:
 *   1. Hidden preheader (inbox preview text)
 *   2. Brand bar — green dot + "floom" wordmark, no images
 *   3. Serif H1 heading that the caller provides
 *   4. Body HTML from the template
 *   5. Sign-off + muted footer (address, support email, reply-hint)
 */
function baseLayout({ heading, body, preheader }: BaseLayoutOpts): string {
  const preheaderBlock = preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Floom</title>
</head>
<body style="margin:0;padding:0;background:${EMAIL_BG};font-family:${SANS};color:${EMAIL_INK};-webkit-font-smoothing:antialiased;">
${preheaderBlock}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_BG};padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

<tr><td style="padding:4px 4px 20px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
<tr>
<td style="vertical-align:middle;padding-right:8px;">
<div style="width:10px;height:10px;border-radius:50%;background:${EMAIL_ACCENT};"></div>
</td>
<td style="vertical-align:middle;font-family:${SANS};font-size:15px;font-weight:600;color:${EMAIL_INK};letter-spacing:-0.01em;">
floom
</td>
</tr>
</table>
</td></tr>

<tr><td style="background:${EMAIL_CARD};border:1px solid ${EMAIL_LINE};border-radius:12px;padding:40px 36px;">
<h1 style="margin:0 0 20px;font-family:${SERIF};font-size:26px;line-height:1.25;font-weight:600;letter-spacing:-0.01em;color:${EMAIL_INK};">${heading}</h1>
${body}
</td></tr>

<tr><td style="padding:24px 4px 4px;font-family:${SANS};font-size:12px;line-height:1.6;color:${EMAIL_MUTED};">
Floom, Inc. &middot; Wilmington, DE<br>
Questions or feedback? Just reply to this email, or write <a href="mailto:hello@floom.dev" style="color:${EMAIL_MUTED};text-decoration:underline;">hello@floom.dev</a>.
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Primary CTA button — same chrome across every template. */
function ctaButton(href: string, label: string): string {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td style="border-radius:8px;background:${EMAIL_INK};"><a href="${safeHref}" style="display:inline-block;background:${EMAIL_INK};color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:8px;font-family:${SANS};font-size:14px;font-weight:600;letter-spacing:-0.005em;">${safeLabel}</a></td></tr></table>`;
}

/** Muted "paste this link" fallback line that sits under every CTA. */
function fallbackLink(href: string): string {
  const safe = escapeHtml(href);
  return `<p style="font-family:${SANS};font-size:13px;line-height:1.55;margin:0 0 16px;color:${EMAIL_MUTED};">Or paste this link into your browser:<br><a href="${safe}" style="color:${EMAIL_MUTED};word-break:break-all;">${safe}</a></p>`;
}

function bodyParagraph(html: string): string {
  return `<p style="font-family:${SANS};font-size:15px;line-height:1.6;margin:0 0 16px;color:${EMAIL_INK};">${html}</p>`;
}

function mutedParagraph(html: string): string {
  return `<p style="font-family:${SANS};font-size:13px;line-height:1.55;margin:16px 0 0;color:${EMAIL_MUTED};">${html}</p>`;
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

  const body = [
    bodyParagraph(greeting),
    bodyParagraph(
      'We got a request to reset the password on your Floom account. Click the button below to choose a new one.',
    ),
    ctaButton(input.resetUrl, 'Reset password'),
    fallbackLink(input.resetUrl),
    mutedParagraph(
      "If you didn't request this, ignore this email. The link expires in 1 hour.",
    ),
  ].join('\n');

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

  return {
    subject,
    html: baseLayout({
      heading: 'Reset your password',
      body,
      preheader:
        'Set a new password on your Floom account. Link valid for one hour.',
    }),
    text,
  };
}

export interface VerificationTemplateInput {
  name?: string | null;
  verifyUrl: string;
}

export function renderVerificationEmail(input: VerificationTemplateInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Verify your Floom email';
  const greeting = input.name ? `Hi ${escapeHtml(input.name)},` : 'Hi,';

  const body = [
    bodyParagraph(greeting),
    bodyParagraph(
      'Click the button below to verify your email and finish setting up your Floom account.',
    ),
    ctaButton(input.verifyUrl, 'Verify email'),
    fallbackLink(input.verifyUrl),
    mutedParagraph(
      'If you did not create this account, you can ignore this email.',
    ),
  ].join('\n');

  const text = [
    input.name ? `Hi ${input.name},` : 'Hi,',
    '',
    'Verify your email to finish setting up your Floom account:',
    '',
    input.verifyUrl,
    '',
    'If you did not create this account, you can ignore this email.',
    '',
    'Floom, Inc. · Wilmington, DE',
    'hello@floom.dev',
  ].join('\n');

  return {
    subject,
    html: baseLayout({
      heading: 'Verify your email',
      body,
      preheader:
        'One click to confirm this is your address and finish setup.',
    }),
    text,
  };
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

  const body = [
    bodyParagraph(greeting),
    bodyParagraph(
      'Your account is live. Your first app is one URL paste away — point Floom at a GitHub repo or an OpenAPI spec and it does the rest.',
    ),
    ctaButton(buildUrl, 'Build your first app'),
    mutedParagraph(
      'Stuck? Just reply to this email. A human reads every one.',
    ),
  ].join('\n');

  const text = [
    input.name ? `Hi ${input.name},` : 'Hi,',
    '',
    'Your account is live. Your first app is one URL paste away:',
    buildUrl,
    '',
    'Stuck? Just reply to this email. A human reads every one.',
    '',
    'Floom, Inc. · Wilmington, DE',
    'hello@floom.dev',
  ].join('\n');

  return {
    subject,
    html: baseLayout({
      heading: 'Welcome to Floom',
      body,
      preheader:
        'Your account is live. Paste a repo, ship an app — your first one is on us.',
    }),
    text,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Waitlist confirmation
//
// Previously rendered inline inside `apps/server/src/routes/waitlist.ts`
// with a duplicated (and subtly drifted) copy of baseLayout. Moved here
// so every Floom email ships the same chrome and so the waitlist email
// can get a real CTA instead of being a wall of prose.
// ─────────────────────────────────────────────────────────────────────────

export interface WaitlistConfirmationTemplateInput {
  /** Public origin the "Browse the live apps" CTA should point at. */
  publicUrl: string;
}

export function renderWaitlistConfirmationEmail(
  input: WaitlistConfirmationTemplateInput,
): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = "You're on the Floom waitlist";
  const appsUrl = `${input.publicUrl.replace(/\/+$/, '')}/apps`;

  const body = [
    bodyParagraph('Thanks for signing up.'),
    bodyParagraph(
      "You're on the waitlist for publishing to floom.dev. We're rolling it out in small batches — we'll email you the moment your slot opens.",
    ),
    bodyParagraph(
      "In the meantime, the featured apps on floom.dev are free to run, no signup required. Lead Scorer, Resume Screener, and Competitor Analyzer are good first stops.",
    ),
    ctaButton(appsUrl, 'Browse the live apps'),
    mutedParagraph(
      "Got something specific you want to ship? Hit reply and tell us — we read every response and it genuinely shapes the waitlist order.",
    ),
  ].join('\n');

  const text = [
    'Thanks for signing up.',
    '',
    "You're on the waitlist for publishing to floom.dev. We're rolling it out in small batches — we'll email you the moment your slot opens.",
    '',
    'In the meantime, the featured apps on floom.dev are free to run, no signup required:',
    appsUrl,
    '',
    "Got something specific you want to ship? Hit reply and tell us — we read every response and it genuinely shapes the waitlist order.",
    '',
    'Floom, Inc. · Wilmington, DE',
    'hello@floom.dev',
  ].join('\n');

  return {
    subject,
    html: baseLayout({
      heading: "You're on the list",
      body,
      preheader:
        "We're rolling out Publish in small batches. While you wait, three apps are free to run right now.",
    }),
    text,
  };
}
