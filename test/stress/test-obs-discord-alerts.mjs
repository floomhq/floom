#!/usr/bin/env node
// Contract tests for the Discord alerts helper.
//
// The helper is a launch-critical safety valve: it has to stay a hard
// no-op when the env var is missing (OSS default) and must never throw
// from a request path. We test:
//
//   1. No-op when DISCORD_ALERTS_WEBHOOK_URL is unset (discordAlertsEnabled
//      returns false and sendDiscordAlert doesn't call fetch).
//   2. No-op when the webhook URL doesn't start with the canonical
//      Discord prefix (guardrail against pasted Slack URLs).
//   3. Posts a JSON payload with the expected shape (title, body,
//      context, allowed_mentions) when configured.
//   4. Rate-limits to 1 post / minute / title (second call within the
//      window is silently dropped).
//
// Run: node test/stress/test-obs-discord-alerts.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const ALERTS_SRC = join(REPO_ROOT, 'apps/server/src/lib/alerts.ts');

let passed = 0;
let failed = 0;
const log = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
};

// We drive the module through a tsx child process so we can:
//   1. Install a fake `fetch` on the global.
//   2. Scope env changes to the child (no cross-test leakage).
//   3. Exercise the real TS source (no JS duplicate).
function runCase(envOverrides, scriptBody) {
  const tmp = mkdtempSync(join(tmpdir(), 'floom-alerts-'));
  const runner = join(tmp, 'runner.mjs');
  const absAlerts = ALERTS_SRC;
  writeFileSync(
    runner,
    `
import { sendDiscordAlert, discordAlertsEnabled, __testing } from ${JSON.stringify(absAlerts)};

const fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  return { ok: true, status: 204 };
};

__testing.resetDebounce();

${scriptBody}

// Let the detached fetch promise settle before we dump the result.
await new Promise((r) => setTimeout(r, 50));

process.stdout.write(JSON.stringify({ fetchCalls, enabled: discordAlertsEnabled() }));
`,
  );
  const env = { ...process.env, ...envOverrides };
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', runner],
    { env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `runner failed: status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------
// 1. No-op when unset.
// ---------------------------------------------------------------------------
const unset = runCase(
  { DISCORD_ALERTS_WEBHOOK_URL: '' },
  `
sendDiscordAlert('Test', 'body');
`,
);
log(
  'discordAlertsEnabled() = false when webhook URL is unset',
  unset.enabled === false,
);
log(
  'sendDiscordAlert() does not call fetch when unset',
  unset.fetchCalls.length === 0,
  `got ${unset.fetchCalls.length} calls`,
);

// ---------------------------------------------------------------------------
// 2. Guardrail: non-Discord URL silently no-ops.
// ---------------------------------------------------------------------------
const wrongHost = runCase(
  {
    DISCORD_ALERTS_WEBHOOK_URL: 'https://hooks.slack.com/services/TXX/BYY/zzz',
  },
  `
sendDiscordAlert('Test', 'body');
`,
);
log(
  'discordAlertsEnabled() = false for non-Discord URL (Slack-style)',
  wrongHost.enabled === false,
);
log(
  'sendDiscordAlert() does not call fetch for non-Discord URL',
  wrongHost.fetchCalls.length === 0,
  `got ${wrongHost.fetchCalls.length} calls`,
);

// ---------------------------------------------------------------------------
// 3. Happy path: payload shape.
// ---------------------------------------------------------------------------
const happy = runCase(
  { DISCORD_ALERTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc' },
  `
sendDiscordAlert('Test title', 'body goes here', { path: '/api/run', method: 'POST' });
`,
);
log(
  'discordAlertsEnabled() = true for valid Discord webhook URL',
  happy.enabled === true,
);
log(
  'sendDiscordAlert() posts exactly once',
  happy.fetchCalls.length === 1,
  `got ${happy.fetchCalls.length} calls`,
);
if (happy.fetchCalls.length === 1) {
  const call = happy.fetchCalls[0];
  log(
    'posts to the configured webhook URL',
    call.url === 'https://discord.com/api/webhooks/123/abc',
  );
  log('uses POST', call.init?.method === 'POST');
  log(
    'sends content-type: application/json',
    /application\/json/i.test(call.init?.headers?.['content-type'] || ''),
  );
  let body;
  try {
    body = JSON.parse(call.init?.body || '{}');
  } catch {
    body = {};
  }
  log(
    'payload has a `content` string',
    typeof body.content === 'string' && body.content.length > 0,
  );
  log(
    'payload content includes the title',
    typeof body.content === 'string' && body.content.includes('Test title'),
  );
  log(
    'payload content includes the body text',
    typeof body.content === 'string' && body.content.includes('body goes here'),
  );
  log(
    'payload content includes formatted context fields',
    typeof body.content === 'string' &&
      body.content.includes('path') &&
      body.content.includes('/api/run'),
  );
  log(
    'allowed_mentions suppresses @everyone / role pings',
    Array.isArray(body.allowed_mentions?.parse) &&
      body.allowed_mentions.parse.length === 0,
  );
}

// ---------------------------------------------------------------------------
// 4. Rate-limit: same title within 60s window fires once.
// ---------------------------------------------------------------------------
const burst = runCase(
  { DISCORD_ALERTS_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc' },
  `
sendDiscordAlert('Burst', 'first');
sendDiscordAlert('Burst', 'second (should be dropped)');
sendDiscordAlert('Burst', 'third (should be dropped)');
sendDiscordAlert('DifferentTitle', 'distinct title fires separately');
`,
);
log(
  'rate-limits duplicate titles within the window (4 calls -> 2 posts)',
  burst.fetchCalls.length === 2,
  `got ${burst.fetchCalls.length} calls`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
