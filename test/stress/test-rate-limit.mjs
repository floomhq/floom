#!/usr/bin/env node
// Rate-limit library: per-IP + per-user + per-app run limits, MCP ingest
// limit, window reset, and the FLOOM_RATE_LIMIT_DISABLED escape hatch.
//
// Run: node test/stress/test-rate-limit.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-ratelimit-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
for (const k of [
  'FLOOM_RATE_LIMIT_DISABLED',
  'FLOOM_RATE_LIMIT_IP_PER_HOUR',
  'FLOOM_RATE_LIMIT_USER_PER_HOUR',
  'FLOOM_RATE_LIMIT_APP_PER_HOUR',
  'FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY',
  'FLOOM_TRUSTED_PROXY_CIDRS',
  'FLOOM_TRUSTED_PROXY_HOP_COUNT',
]) delete process.env[k];

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

// Fake Hono Context: header+param+json+peer socket enough to drive the
// middleware.
// `header(name, value)` writes a response header too, matching Hono's own
// dual-purpose API so applyLimitHeaders (issue #128) can attach
// X-RateLimit-* on the success path.
function makeCtx({
  ip = '1.2.3.4',
  peerIp = '127.0.0.1',
  slug = null,
  headers = {},
} = {}) {
  const hdrs = new Headers(
    ip === null ? headers : { 'x-forwarded-for': ip, ...headers },
  );
  const responseHeaders = new Headers();
  return {
    env:
      peerIp === null
        ? {}
        : {
            incoming: {
              socket: {
                remoteAddress: peerIp,
                remoteFamily: peerIp.includes(':') ? 'IPv6' : 'IPv4',
              },
            },
          },
    _responseHeaders: responseHeaders,
    req: {
      header: (n) => hdrs.get(n.toLowerCase()) || hdrs.get(n) || null,
      param: (n) => (n === 'slug' ? slug : null),
      query: () => null,
      raw: { headers: hdrs },
    },
    header: (name, value) => {
      if (value === undefined) return responseHeaders.get(name);
      responseHeaders.set(name, String(value));
    },
    json: (body, status, extra) =>
      new Response(JSON.stringify(body), {
        status: status || 200,
        headers: { 'content-type': 'application/json', ...(extra || {}) },
      }),
  };
}

const rl = await import('../../apps/server/dist/lib/rate-limit.js');
const anonCtx = {
  workspace_id: 'local',
  user_id: 'local',
  device_id: 'd',
  is_authenticated: false,
};
const anonResolve = async () => anonCtx;

console.log('Rate limit library');

// 1. defaults (bumped 2026-04-21 pre-launch: anon 60 → 150 for shared-NAT
// and launch traffic; user/per-app unchanged from 2026-04-19 bump).
log('anon default is 150/hr', rl.defaultAnonPerHour() === 150);
log('user default is 300/hr', rl.defaultUserPerHour() === 300);
log('per-app default is 500/hr', rl.defaultPerAppPerHour() === 500);
log('mcp ingest default is 10/day', rl.defaultMcpIngestPerDay() === 10);

// 2. env override
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '5';
log('FLOOM_RATE_LIMIT_IP_PER_HOUR override', rl.defaultAnonPerHour() === 5);

// 3. extractIp trust rules
log(
  'extractIp trusts cf-connecting-ip from loopback proxy',
  rl.extractIp(
    makeCtx({ ip: '9.9.9.9', headers: { 'cf-connecting-ip': '10.0.0.1' } }),
  ) === '10.0.0.1',
);
log(
  'extractIp takes last trusted XFF entry from loopback proxy',
  rl.extractIp(makeCtx({ ip: '1.1.1.1, 2.2.2.2' })) === '2.2.2.2',
);
log(
  'extractIp prefers x-real-ip from trusted proxy',
  rl.extractIp(
    makeCtx({ ip: '1.1.1.1, 2.2.2.2', headers: { 'x-real-ip': '203.0.113.9' } }),
  ) === '203.0.113.9',
);
log(
  'extractIp ignores spoofed XFF from untrusted peer',
  rl.extractIp(makeCtx({ peerIp: '203.0.113.10', ip: '1.1.1.1' })) ===
    '203.0.113.10',
);
process.env.FLOOM_TRUSTED_PROXY_CIDRS = '203.0.113.0/24';
log(
  'extractIp trusts configured proxy CIDR',
  rl.extractIp(makeCtx({ peerIp: '203.0.113.10', ip: '4.4.4.4' })) ===
    '4.4.4.4',
);
process.env.FLOOM_TRUSTED_PROXY_HOP_COUNT = '2';
log(
  'trusted proxy hop count strips the trailing proxy hop',
  rl.extractIp(makeCtx({ peerIp: '203.0.113.10', ip: 'ATTACKER, 203.0.113.9, 10.0.0.1' })) ===
    '203.0.113.9',
);
log(
  'trusted proxy hop count with too-short chain falls back to peer IP',
  rl.extractIp(makeCtx({ peerIp: '203.0.113.10', ip: '10.0.0.1' })) ===
    '203.0.113.10',
);
delete process.env.FLOOM_TRUSTED_PROXY_HOP_COUNT;
delete process.env.FLOOM_TRUSTED_PROXY_CIDRS;
log(
  'extractIp falls back to direct peer IP without proxy headers',
  rl.extractIp(makeCtx({ ip: null, peerIp: '198.51.100.7' })) ===
    '198.51.100.7',
);
log(
  'extractIp falls back to unknown without peer or proxy IP',
  rl.extractIp(makeCtx({ ip: null, peerIp: null })) === 'unknown',
);

// 3b. proxy spoofing guard on anon buckets
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '1';
const mwSpoof = rl.runRateLimitMiddleware(anonResolve);
const spoofA = await mwSpoof(
  makeCtx({ peerIp: '203.0.113.10', ip: '1.1.1.1' }),
  async () => undefined,
);
const spoofB = await mwSpoof(
  makeCtx({ peerIp: '203.0.113.10', ip: '2.2.2.2' }),
  async () => undefined,
);
log(
  'untrusted peer cannot rotate XFF to evade anon IP cap',
  spoofA?.status !== 429 && spoofB?.status === 429,
);

// 3c. configured proxy preserves per-client separation
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '1';
process.env.FLOOM_TRUSTED_PROXY_CIDRS = '203.0.113.0/24';
const mwTrustedProxy = rl.runRateLimitMiddleware(anonResolve);
const trustedA = await mwTrustedProxy(
  makeCtx({ peerIp: '203.0.113.10', ip: '1.1.1.1' }),
  async () => undefined,
);
const trustedB = await mwTrustedProxy(
  makeCtx({ peerIp: '203.0.113.10', ip: '2.2.2.2' }),
  async () => undefined,
);
const trustedASecond = await mwTrustedProxy(
  makeCtx({ peerIp: '203.0.113.10', ip: '1.1.1.1' }),
  async () => undefined,
);
log(
  'trusted proxy uses forwarded client IPs for anon buckets',
  trustedA?.status !== 429 &&
    trustedB?.status !== 429 &&
    trustedASecond?.status === 429,
);
delete process.env.FLOOM_TRUSTED_PROXY_CIDRS;

// 4. anon IP cap
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '5';
const mw = rl.runRateLimitMiddleware(anonResolve);
let blocked = 0;
let ok = 0;
for (let i = 0; i < 7; i++) {
  const res = await mw(makeCtx({ ip: '5.5.5.5' }), async () => undefined);
  if (res && res.status === 429) blocked++;
  else ok++;
}
log('anon IP: 5 allowed, 2 blocked under cap=5', ok === 5 && blocked === 2);

// 5. 429 envelope + Retry-After
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '1';
const mw5 = rl.runRateLimitMiddleware(anonResolve);
await mw5(makeCtx({ ip: '6.6.6.6' }), async () => undefined);
const second = await mw5(makeCtx({ ip: '6.6.6.6' }), async () => undefined);
log('second call returns 429', second.status === 429);
log(
  'Retry-After header present',
  Number(second.headers.get('retry-after')) > 0,
);
const body5 = await second.json();
log('error body has rate_limit_exceeded', body5.error === 'rate_limit_exceeded');
log('scope is ip for anon', body5.scope === 'ip');
log('retry_after_seconds > 0', body5.retry_after_seconds > 0);
// Clamp: the internal sliding window is 3600s, so retry-after on a cold
// bucket with limit=1 can be up to ~3600. We cap the public-facing value at
// 300 so the UX reads "come back in 5 min" not "46 min".
log(
  'retry_after_seconds clamped at 300',
  body5.retry_after_seconds <= 300,
);
log(
  'Retry-After header clamped at 300',
  Number(second.headers.get('retry-after')) <= 300,
);

// 6. authed user bucket
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '1';
process.env.FLOOM_RATE_LIMIT_USER_PER_HOUR = '3';
const mw6 = rl.runRateLimitMiddleware(async () => ({
  workspace_id: 'ws',
  user_id: 'u_42',
  device_id: 'd',
  is_authenticated: true,
}));
let authedOk = 0;
for (let i = 0; i < 3; i++) {
  const r = await mw6(makeCtx({ ip: '7.7.7.7' }), async () => undefined);
  if (!r || r.status !== 429) authedOk++;
}
log('authed user respects user cap not IP cap', authedOk === 3);
const fourth = await mw6(makeCtx({ ip: '7.7.7.7' }), async () => undefined);
log('fourth authed call 429s with scope=user', fourth?.status === 429);
const body6 = fourth?.status === 429 ? await fourth.json() : null;
log('authed-over scope field is user', body6?.scope === 'user');

// 7. per-(IP, app) bucket
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '100';
process.env.FLOOM_RATE_LIMIT_USER_PER_HOUR = '100';
process.env.FLOOM_RATE_LIMIT_APP_PER_HOUR = '2';
const mw7 = rl.runRateLimitMiddleware(anonResolve);
const call7 = (slug) =>
  mw7(makeCtx({ ip: '8.8.8.8', slug }), async () => undefined);
const a1 = await call7('bouncer');
const a2 = await call7('bouncer');
const a3 = await call7('bouncer');
log('first two per-(IP,app) calls pass', a1?.status !== 429 && a2?.status !== 429);
log('third per-(IP,app) call blocks', a3?.status === 429);
const bodyA3 = a3?.status === 429 ? await a3.json() : null;
log('scope=app on per-app block', bodyA3?.scope === 'app');
const diff = await call7('opendraft');
log('different app on same IP is independent', diff?.status !== 429);

// 8. disabled flag
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '1';
process.env.FLOOM_RATE_LIMIT_DISABLED = 'true';
const mw8 = rl.runRateLimitMiddleware(anonResolve);
let unblocked = 0;
for (let i = 0; i < 10; i++) {
  const r = await mw8(makeCtx({ ip: '9.9.9.9' }), async () => undefined);
  if (!r || r.status !== 429) unblocked++;
}
log('disabled flag lets 10 calls through cap=1', unblocked === 10);
delete process.env.FLOOM_RATE_LIMIT_DISABLED;

// 8b. admin-bearer bypass (2026-04-21): when FLOOM_AUTH_TOKEN is set AND
// the caller presents matching bearer, skip rate-limit entirely. Used for
// ops sweeps and monitoring.
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '1';
process.env.FLOOM_AUTH_TOKEN = 'admin-secret-token';
const mw8b = rl.runRateLimitMiddleware(anonResolve);
let adminOk = 0;
for (let i = 0; i < 10; i++) {
  const r = await mw8b(
    makeCtx({
      ip: '9.9.9.10',
      headers: { authorization: 'Bearer admin-secret-token' },
    }),
    async () => undefined,
  );
  if (!r || r.status !== 429) adminOk++;
}
log('admin bearer bypasses rate-limit (10/10 pass cap=1)', adminOk === 10);

// Wrong token: still rate-limited. cap=1 → first call OK, second 429s.
rl.__resetStoreForTests();
const wrongA = await mw8b(
  makeCtx({
    ip: '9.9.9.11',
    headers: { authorization: 'Bearer wrong-token' },
  }),
  async () => undefined,
);
const wrongB = await mw8b(
  makeCtx({
    ip: '9.9.9.11',
    headers: { authorization: 'Bearer wrong-token' },
  }),
  async () => undefined,
);
log(
  'wrong bearer still rate-limited',
  (!wrongA || wrongA.status !== 429) && wrongB?.status === 429,
);

// No token configured on the server: bypass disabled even if caller sends
// any bearer. FLOOM_AUTH_TOKEN unset → admin bypass must not fire.
delete process.env.FLOOM_AUTH_TOKEN;
rl.__resetStoreForTests();
const noTokenMw = rl.runRateLimitMiddleware(anonResolve);
const noTokenA = await noTokenMw(
  makeCtx({
    ip: '9.9.9.12',
    headers: { authorization: 'Bearer anything' },
  }),
  async () => undefined,
);
const noTokenB = await noTokenMw(
  makeCtx({
    ip: '9.9.9.12',
    headers: { authorization: 'Bearer anything' },
  }),
  async () => undefined,
);
log(
  'bypass disabled when FLOOM_AUTH_TOKEN unset (OSS mode)',
  (!noTokenA || noTokenA.status !== 429) && noTokenB?.status === 429,
);

// 9. MCP ingest per-user
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY = '2';
const uctx = {
  workspace_id: 'ws',
  user_id: 'u_creator',
  device_id: 'd',
  is_authenticated: true,
};
const m1 = rl.checkMcpIngestLimit(uctx, '1.1.1.1');
const m2 = rl.checkMcpIngestLimit(uctx, '1.1.1.1');
const m3 = rl.checkMcpIngestLimit(uctx, '1.1.1.1');
log('mcp ingest: first two pass', m1.allowed && m2.allowed);
log('mcp ingest: third blocks', !m3.allowed);
log(
  'mcp ingest block has retryAfterSec',
  !m3.allowed && m3.retryAfterSec > 0,
);

// 10. MCP ingest per-IP for anon
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_MCP_INGEST_PER_DAY = '1';
const anonFirst = rl.checkMcpIngestLimit(anonCtx, '10.0.0.1');
const anonSecond = rl.checkMcpIngestLimit(anonCtx, '10.0.0.1');
const differentIp = rl.checkMcpIngestLimit(anonCtx, '10.0.0.2');
log(
  'mcp ingest anon: first passes, second 429s',
  anonFirst.allowed && !anonSecond.allowed,
);
log('mcp ingest anon: different IP not affected', differentIp.allowed);

// 11. X-RateLimit-* headers on success + 429 (issue #128)
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '3';
delete process.env.FLOOM_RATE_LIMIT_APP_PER_HOUR;
const mwHdr = rl.runRateLimitMiddleware(anonResolve);
const ctxHdr = makeCtx({ ip: '12.12.12.12' });
await mwHdr(ctxHdr, async () => undefined);
log(
  'X-RateLimit-Limit header set on success',
  ctxHdr._responseHeaders.get('X-RateLimit-Limit') === '3',
);
log(
  'X-RateLimit-Remaining decrements on success',
  ctxHdr._responseHeaders.get('X-RateLimit-Remaining') === '2',
);
log(
  'X-RateLimit-Scope is ip for anon',
  ctxHdr._responseHeaders.get('X-RateLimit-Scope') === 'ip',
);
log(
  'X-RateLimit-Reset is epoch-seconds',
  Number(ctxHdr._responseHeaders.get('X-RateLimit-Reset')) > 1_700_000_000,
);
// Burn to 429 and confirm header still set on block response.
await mwHdr(makeCtx({ ip: '12.12.12.12' }), async () => undefined);
await mwHdr(makeCtx({ ip: '12.12.12.12' }), async () => undefined);
const blockRes = await mwHdr(
  makeCtx({ ip: '12.12.12.12' }),
  async () => undefined,
);
log('429 has X-RateLimit-Limit=3', blockRes.headers.get('X-RateLimit-Limit') === '3');
log('429 has X-RateLimit-Remaining=0', blockRes.headers.get('X-RateLimit-Remaining') === '0');
log('429 has X-RateLimit-Scope=ip', blockRes.headers.get('X-RateLimit-Scope') === 'ip');

// 12. Store reset drains bucket
rl.__resetStoreForTests();
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '1';
const mw11 = rl.runRateLimitMiddleware(anonResolve);
const r11a = await mw11(makeCtx({ ip: '11.1.1.1' }), async () => undefined);
log('post-reset first call passes', !r11a || r11a.status !== 429);
const r11b = await mw11(makeCtx({ ip: '11.1.1.1' }), async () => undefined);
log('post-reset second call blocks', r11b?.status === 429);
rl.__resetStoreForTests();
const r11c = await mw11(makeCtx({ ip: '11.1.1.1' }), async () => undefined);
log('after explicit store reset, call passes', !r11c || r11c.status !== 429);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
