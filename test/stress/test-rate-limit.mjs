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

// Fake Hono Context: header+param+json enough to drive the middleware.
function makeCtx({ ip = '1.2.3.4', slug = null, headers = {} } = {}) {
  const hdrs = new Headers(
    ip === null ? headers : { 'x-forwarded-for': ip, ...headers },
  );
  return {
    req: {
      header: (n) => hdrs.get(n.toLowerCase()) || hdrs.get(n) || null,
      param: (n) => (n === 'slug' ? slug : null),
      query: () => null,
      raw: { headers: hdrs },
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

// 1. defaults
log('anon default is 20/hr', rl.defaultAnonPerHour() === 20);
log('user default is 200/hr', rl.defaultUserPerHour() === 200);
log('per-app default is 50/hr', rl.defaultPerAppPerHour() === 50);
log('mcp ingest default is 10/day', rl.defaultMcpIngestPerDay() === 10);

// 2. env override
process.env.FLOOM_RATE_LIMIT_IP_PER_HOUR = '5';
log('FLOOM_RATE_LIMIT_IP_PER_HOUR override', rl.defaultAnonPerHour() === 5);

// 3. extractIp precedence
log(
  'extractIp prefers cf-connecting-ip',
  rl.extractIp(
    makeCtx({ ip: '9.9.9.9', headers: { 'cf-connecting-ip': '10.0.0.1' } }),
  ) === '10.0.0.1',
);
log(
  'extractIp takes first XFF entry',
  rl.extractIp(makeCtx({ ip: '1.1.1.1, 2.2.2.2' })) === '1.1.1.1',
);
log(
  'extractIp falls back to unknown',
  rl.extractIp(makeCtx({ ip: null })) === 'unknown',
);

// 4. anon IP cap
rl.__resetStoreForTests();
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

// 11. Store reset drains bucket
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
