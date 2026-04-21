// Discord webhook alerting for prod incidents.
//
// The existing Hetzner heartbeat cron gives us binary up/down. This helper
// gives us app-level alerts — 5xx unhandled errors, repeated 429s from one
// IP (abuse signal), container boot failures — delivered to the same
// Discord channel so Federico gets WhatsApp notifications in under a
// minute.
//
// Design:
//   - No-op when `DISCORD_ALERTS_WEBHOOK_URL` is unset (OSS default).
//   - Never throws. An alert helper that can break a request is worse than
//     no alert helper.
//   - Rate-limited to avoid firehose on error storms: each distinct `title`
//     fires at most once per 60 seconds. Overflow is silently dropped so
//     Discord's own rate limit (30 msgs/min per webhook) doesn't punish us.
//   - Fire-and-forget: posts on a background promise so the request path
//     never awaits a Discord round-trip.

const WEBHOOK_ENV = 'DISCORD_ALERTS_WEBHOOK_URL';
const PER_TITLE_WINDOW_MS = 60_000;

const lastSentByTitle = new Map<string, number>();
let loggedEnabled = false;

function currentWebhook(): string | null {
  const url = process.env[WEBHOOK_ENV];
  if (!url) return null;
  if (!url.startsWith('https://discord.com/api/webhooks/')) {
    // Guardrail: if someone pastes a Slack URL or a stray placeholder, skip.
    return null;
  }
  return url;
}

/**
 * True if the Discord alerts channel is configured. Useful in tests and
 * for the one-time boot log.
 */
export function discordAlertsEnabled(): boolean {
  return currentWebhook() !== null;
}

/**
 * One-line boot log. Call from the server bootstrap so operators can tell
 * at a glance whether alerts are wired without grepping env vars.
 */
export function logAlertsBootState(): void {
  if (loggedEnabled) return;
  loggedEnabled = true;
  if (discordAlertsEnabled()) {
    console.log('[discord-alerts] enabled');
  } else {
    console.log('[discord-alerts] disabled (DISCORD_ALERTS_WEBHOOK_URL unset)');
  }
}

function shouldSend(title: string, now: number): boolean {
  const last = lastSentByTitle.get(title) ?? 0;
  if (now - last < PER_TITLE_WINDOW_MS) return false;
  lastSentByTitle.set(title, now);
  return true;
}

/**
 * Truncate a payload to Discord's 2000-char limit on `content`. Anything
 * longer gets collapsed with a "(...truncated)" suffix so the alert still
 * lands and operators know to grep server logs for the full stack.
 */
function truncateForDiscord(raw: string): string {
  const MAX = 1900; // leave room for code fences + suffix
  if (raw.length <= MAX) return raw;
  return raw.slice(0, MAX) + '\n...(truncated; grep server logs for full detail)';
}

function formatPayload(
  title: string,
  body: string,
  context?: Record<string, unknown>,
): string {
  const ctxLines = context
    ? Object.entries(context)
        .map(([k, v]) => `- **${k}**: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')
    : '';
  const parts = [`**${title}**`, body];
  if (ctxLines) parts.push(ctxLines);
  return truncateForDiscord(parts.join('\n'));
}

/**
 * Fire-and-forget alert to the configured Discord webhook. Returns
 * synchronously; the HTTP post runs on a detached promise. Safe to call
 * from any request handler without awaiting.
 */
export function sendDiscordAlert(
  title: string,
  body: string,
  context?: Record<string, unknown>,
): void {
  try {
    const url = currentWebhook();
    if (!url) return;
    const now = Date.now();
    if (!shouldSend(title, now)) return;
    const payload = {
      content: formatPayload(title, body, context),
      // Suppress @everyone pings + role pings even if a message body contains
      // one accidentally (e.g. a log line that mentions a role id).
      allowed_mentions: { parse: [] as string[] },
    };
    // Detached fetch — never await. Errors are swallowed; if Discord is
    // down, we don't care inside a request path.
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Silent. The whole point of this helper is that it cannot break
      // the caller. A real operator signal on Discord downtime would come
      // from Sentry or the heartbeat cron on Hetzner, not from us.
    });
  } catch {
    // Guard against pathological inputs (circular JSON, undefined env, etc).
  }
}

// Exposed for tests.
export const __testing = {
  resetDebounce: () => {
    lastSentByTitle.clear();
    loggedEnabled = false;
  },
  formatPayload,
};
