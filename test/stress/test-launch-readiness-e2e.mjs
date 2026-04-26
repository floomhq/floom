#!/usr/bin/env node
// Manual backend launch-readiness smoke.
//
// Runs live checks against preview.floom.dev plus an in-process retention
// sweeper check. This file is intentionally not wired into CI.
//
// Usage:
//   pnpm --filter @floom/server build
//   node test/stress/test-launch-readiness-e2e.mjs
//
// Optional env:
//   FLOOM_E2E_BASE_URL=https://preview.floom.dev
//   FLOOM_E2E_EMAIL=depontefede+floom-e2e-...@gmail.com
//   FLOOM_E2E_GMAIL_USER=...
//   FLOOM_E2E_GMAIL_APP_PASSWORD=...
//   FLOOM_PREVIEW_ADMIN_TOKEN=...

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const baseUrl = (process.env.FLOOM_E2E_BASE_URL || 'https://preview.floom.dev').replace(/\/+$/, '');
const runStamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const email = process.env.FLOOM_E2E_EMAIL || `depontefede+floom-e2e-${runStamp}@gmail.com`;
const password = process.env.FLOOM_E2E_PASSWORD || `Floom-e2e-${runStamp}-password-42`;

const results = [];

function record(flow, status, detail, evidence = {}) {
  results.push({ flow, status, detail, evidence });
  const label = status === 'pass' ? 'PASS' : status === 'blocked' ? 'BLOCKED' : 'FAIL';
  console.log(`${label} ${flow}: ${detail}`);
  if (status !== 'pass' && evidence && Object.keys(evidence).length > 0) {
    console.log(`  evidence: ${JSON.stringify(evidence).slice(0, 1200)}`);
  }
}

function pass(flow, detail, evidence) {
  record(flow, 'pass', detail, evidence);
}

function fail(flow, detail, evidence) {
  record(flow, 'fail', detail, evidence);
}

function blocked(flow, detail, evidence) {
  record(flow, 'blocked', detail, evidence);
}

function assertFlow(flow, condition, detail, evidence) {
  if (condition) pass(flow, detail, evidence);
  else fail(flow, detail, evidence);
  return Boolean(condition);
}

class HttpClient {
  constructor(base, defaultHeaders = {}) {
    this.base = base;
    this.cookies = new Map();
    this.defaultHeaders = defaultHeaders;
  }

  cookieHeader() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(headers) {
    const raw = headers.get('set-cookie');
    if (!raw) return;
    for (const chunk of raw.split(/,(?=[^;,]+=)/)) {
      const first = chunk.split(';')[0] || '';
      const idx = first.indexOf('=');
      if (idx > 0) this.cookies.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
    }
  }

  async request(path, init = {}) {
    const headers = new Headers(this.defaultHeaders);
    for (const [k, v] of Object.entries(init.headers || {})) headers.set(k, v);
    const cookie = this.cookieHeader();
    if (cookie && !headers.has('cookie')) headers.set('cookie', cookie);
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    this.storeCookies(res.headers);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // leave null
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  async json(path, body, init = {}) {
    return this.request(path, {
      ...init,
      method: init.method || 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      body: JSON.stringify(body),
    });
  }
}

function fileEnvelope(path, mimeType, name) {
  const bytes = readFileSync(path);
  return {
    __file: true,
    name,
    mime_type: mimeType,
    size: bytes.length,
    content_b64: bytes.toString('base64'),
  };
}

const demoRuns = {
  'lead-scorer': {
    action: 'score',
    inputs: {
      data: fileEnvelope(
        join(repoRoot, 'apps/web/public/examples/lead-scorer/sample-leads.csv'),
        'text/csv',
        'sample-leads.csv',
      ),
      icp:
        'B2B SaaS CFOs at 100-500 employee fintechs in EU. Looking for finance leaders ' +
        'at growth-stage companies with recent funding or hiring signals.',
    },
  },
  'competitor-analyzer': {
    action: 'analyze',
    inputs: {
      urls: 'https://linear.app\nhttps://notion.so\nhttps://asana.com',
      your_product:
        'We sell B2B sales automation software to EU mid-market teams. ' +
        'AI-native, usage-based pricing, integrates with Salesforce and HubSpot.',
    },
  },
  'resume-screener': {
    action: 'screen',
    inputs: {
      cvs_zip: fileEnvelope(
        join(repoRoot, 'apps/web/public/examples/resume-screener/sample-cvs.zip'),
        'application/zip',
        'sample-cvs.zip',
      ),
      job_description:
        'Senior Backend Engineer (Remote EU). 5+ years building production Python services.\n' +
        'Responsibilities: own the ingestion pipeline, design the scoring model, mentor two\n' +
        'engineers. Stack: Python 3.12, FastAPI, Postgres, Redis, AWS. Nice-to-have: past\n' +
        'experience with LLM products or high-throughput ETL.',
      must_haves:
        '5+ years Python\nProduction Postgres experience\nRemote-friendly timezone (UTC-3 to UTC+3)',
    },
  },
};

async function pollRun(client, runId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.request(`/api/run/${encodeURIComponent(runId)}`);
    const status = last.json?.status;
    if (['success', 'error', 'failed', 'timeout'].includes(status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return last || { status: 0, json: null, text: 'poll timeout' };
}

async function callMcp(client, token, name, args = {}) {
  const res = await client.json(
    '/mcp',
    {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    },
    {
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
    },
  );
  let payload = null;
  const raw = res.json?.result?.content?.[0]?.text;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    // leave null
  }
  return { ...res, payload };
}

function pollVerificationUrl(targetEmail) {
  const user = process.env.FLOOM_E2E_GMAIL_USER;
  const password = process.env.FLOOM_E2E_GMAIL_APP_PASSWORD;
  if (!user || !password) return null;
  const script = String.raw`
import email, imaplib, re, sys, time
from email.header import decode_header

target = sys.argv[1].lower()
user = sys.argv[2]
password = sys.argv[3]
deadline = time.time() + 90
pattern = re.compile(r'https://preview\.floom\.dev/auth/verify-email\?token=[^\\s<>"\\)]+')

while time.time() < deadline:
    mail = imaplib.IMAP4_SSL('imap.gmail.com', 993)
    mail.login(user, password)
    mail.select('INBOX')
    status, messages = mail.search(None, 'ALL')
    ids = messages[0].split()[-40:] if status == 'OK' else []
    for num in reversed(ids):
        status, data = mail.fetch(num, '(RFC822)')
        if status != 'OK':
            continue
        msg = email.message_from_bytes(data[0][1])
        recipients = ' '.join(str(msg.get(h, '')) for h in ['To', 'Delivered-To', 'X-Original-To']).lower()
        subject = str(msg.get('Subject', ''))
        parts = []
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_maintype() == 'text':
                    payload = part.get_payload(decode=True)
                    if payload:
                        parts.append(payload.decode(part.get_content_charset() or 'utf-8', 'replace'))
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                parts.append(payload.decode(msg.get_content_charset() or 'utf-8', 'replace'))
        body = '\\n'.join(parts)
        if target not in recipients and target not in body.lower():
            continue
        matches = pattern.findall(body)
        if matches:
            print(matches[-1].replace('&amp;', '&'))
            mail.logout()
            sys.exit(0)
    mail.logout()
    time.sleep(5)
sys.exit(2)
`;
  const out = spawnSync('python3', ['-c', script, targetEmail, user, password], {
    encoding: 'utf8',
    timeout: 100_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (out.status !== 0) return null;
  return out.stdout.trim() || null;
}

async function runRetentionSweeperInProcess() {
  const flow = 'retention sweeper';
  const tmp = mkdtempSync(join(tmpdir(), 'floom-launch-retention-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmp;
  process.env.FLOOM_DISABLE_RETENTION_SWEEPER = 'true';
  process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
  process.env.FLOOM_DISABLE_TRIGGERS_WORKER = 'true';
  try {
    const { db } = await import(`../../apps/server/dist/db.js?launch=${Date.now()}`);
    const { sweepRunRetention } = await import(
      `../../apps/server/dist/services/run-retention-sweeper.js?launch=${Date.now()}`
    );
    db.prepare(`INSERT INTO users (id, email, name) VALUES ('launch_retention_user', 'retention@example.com', 'Retention')`).run();
    db.prepare(`INSERT INTO workspaces (id, slug, name, plan) VALUES ('launch_retention_ws', 'launch-retention', 'Retention', 'cloud_free')`).run();
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('launch_retention_ws', 'launch_retention_user', 'admin')`).run();
    const manifest = {
      name: 'Launch Retention',
      description: 'retention smoke',
      runtime: 'python',
      manifest_version: '2.0',
      python_dependencies: [],
      node_dependencies: {},
      secrets_needed: [],
      max_run_retention_days: 1,
      actions: { run: { label: 'Run', inputs: [], outputs: [] } },
    };
    db.prepare(
      `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id, author, max_run_retention_days)
       VALUES ('launch_retention_app', 'launch-retention-app', 'Launch Retention', 'x', ?, 'proxied:test', 'launch_retention_ws', 'launch_retention_user', 1)`,
    ).run(JSON.stringify(manifest));
    db.prepare(
      `INSERT INTO runs (id, app_id, action, inputs, outputs, status, workspace_id, user_id, started_at, finished_at)
       VALUES ('launch_retention_run', 'launch_retention_app', 'run', '{}', '{}', 'success', 'launch_retention_ws', 'launch_retention_user', datetime('now', '-2 days'), datetime('now', '-2 days'))`,
    ).run();
    const before = db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE id = 'launch_retention_run'`).get()?.c;
    const swept = await sweepRunRetention({ now: new Date() });
    const after = db.prepare(`SELECT COUNT(*) AS c FROM runs WHERE id = 'launch_retention_run'`).get()?.c;
    assertFlow(
      flow,
      before === 1 && after === 0 && swept.deleted_count >= 1,
      'old completed run deleted by 1-day retention',
      { before, after, swept },
    );
  } catch (err) {
    fail(flow, (err && err.stack) || String(err));
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runLivePreviewFlows() {
  const anon = new HttpClient(baseUrl);
  const root = await anon.request('/');
  assertFlow('anon GET /', root.status === 200 && root.text.includes('<html'), 'root HTML returned 200', { status: root.status, bytes: root.text.length });

  const apps = await anon.request('/apps');
  assertFlow('anon GET /apps', apps.status === 200 && apps.text.length > 1000, '/apps returned HTML', { status: apps.status, bytes: apps.text.length });

  for (const slug of Object.keys(demoRuns)) {
    const page = await anon.request(`/p/${slug}`);
    assertFlow(`anon GET /p/${slug}`, page.status === 200 && page.text.length > 1000, `${slug} permalink returned HTML`, { status: page.status, bytes: page.text.length });
  }

  for (const [slug, spec] of Object.entries(demoRuns)) {
    const started = await anon.json(`/api/${slug}/run`, {
      action: spec.action,
      inputs: spec.inputs,
    });
    const runId = started.json?.run_id;
    if (!assertFlow(
      `anon POST /api/${slug}/run`,
      started.status === 200 && typeof runId === 'string',
      `${slug} run accepted (status ${started.status})`,
      { status: started.status, body: started.json || started.text },
    )) {
      continue;
    }
    const done = await pollRun(anon, runId);
    assertFlow(
      `anon ${slug} run completes`,
      done.status === 200 && done.json?.status === 'success' && done.json?.outputs && typeof done.json.outputs === 'object',
      `${slug} run reached success with outputs`,
      { status: done.status, run_id: runId, run_status: done.json?.status, error: done.json?.error },
    );
  }

  const authClient = new HttpClient(baseUrl, { origin: baseUrl });
  const signup = await authClient.json('/auth/sign-up/email', {
    email,
    password,
    name: 'Floom Launch E2E',
    callbackURL: `${baseUrl}/me`,
  });
  const signupOk = assertFlow('auth signup', signup.status === 200, 'email/password signup accepted', { status: signup.status, body: signup.json || signup.text.slice(0, 500) });
  let verifiedSession = false;
  let verifyUrl = null;
  if (signupOk) {
    let authEvidence = null;
    const seenVerifyUrls = new Set();
    for (let attempt = 1; attempt <= 4 && !verifiedSession; attempt++) {
      const resend = await authClient.json('/auth/send-verification-email', {
        email,
        callbackURL: `${baseUrl}/me`,
      });
      await new Promise((resolve) => setTimeout(resolve, 6000));
      verifyUrl = pollVerificationUrl(email);
      if (!verifyUrl) break;
      if (seenVerifyUrls.has(verifyUrl)) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      seenVerifyUrls.add(verifyUrl);
      const url = new URL(verifyUrl);
      const verify = await authClient.request(`${url.pathname}${url.search}`, { redirect: 'manual' });
      const verifyAccepted = verify.status >= 200 && verify.status < 400;
      verifiedSession = authClient.cookieHeader().includes('fsid');
      let signin = null;
      if (!verifiedSession) {
        signin = await authClient.json('/auth/sign-in/email', {
          email,
          password,
        });
        verifiedSession = signin.status === 200 && authClient.cookieHeader().includes('fsid');
      }
      authEvidence = {
        attempt,
        verify_status: verify.status,
        verify_location: verify.headers.get('location'),
        verify_accepted: verifyAccepted,
        sign_in_status: signin?.status,
        resend_status: resend.status,
        cookie_names: Array.from(authClient.cookies.keys()),
      };
      if (!verifiedSession && signin?.status === 403 && signin.json?.code === 'EMAIL_NOT_VERIFIED') {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    if (!verifyUrl) {
      blocked('auth verify email', 'FLOOM_E2E_GMAIL_USER/FLOOM_E2E_GMAIL_APP_PASSWORD missing or no verification email found', { email });
    } else {
      if (!verifiedSession) {
        const finalSignin = await authClient.json('/auth/sign-in/email', {
          email,
          password,
        });
        verifiedSession = finalSignin.status === 200 && authClient.cookieHeader().includes('fsid');
        authEvidence = {
          ...authEvidence,
          final_sign_in_status: finalSignin.status,
          cookie_names: Array.from(authClient.cookies.keys()),
        };
      }
      assertFlow(
        'auth verify email',
        verifiedSession,
        `verified account session ${verifiedSession ? 'issued' : 'missing'}`,
        authEvidence,
      );
    }
  }

  if (!verifiedSession) {
    blocked('auth GET /api/me/studio/stats', 'requires verified session');
    blocked('agent token flow', 'requires verified session');
    blocked('MCP agent flow', 'requires verified session and agent token');
    blocked('sharing flow', 'requires verified session');
    blocked('trust+safety live ingest', 'requires verified session');
    blocked('account soft-delete', 'requires verified session');
    blocked('audit log live', 'requires app publish and admin token');
    return;
  }

  const meStats = await authClient.request('/api/me/studio/stats');
  assertFlow('auth GET /api/me/studio/stats', meStats.status === 200 && typeof meStats.json === 'object', 'authenticated creator stats route returned JSON', { status: meStats.status, body: meStats.json || meStats.text.slice(0, 500) });

  const mint = await authClient.json('/api/me/agent-keys', {
    label: `launch-e2e-${runStamp}`,
    scope: 'read-write',
    rate_limit_per_minute: 1000,
  });
  const agentToken = mint.json?.raw_token;
  const agentTokenId = mint.json?.id;
  const tokenOk = assertFlow('agent token mint', mint.status === 201 && /^floom_agent_/.test(agentToken || ''), 'agent token minted and raw token returned once', { status: mint.status, id: agentTokenId, prefix: mint.json?.prefix });

  if (tokenOk) {
    const agentClient = new HttpClient(baseUrl, { authorization: `Bearer ${agentToken}` });
    const session = await agentClient.request('/api/session/me');
    assertFlow(
      'agent token bearer auth',
      session.status === 200 && session.json?.user?.email === email && session.json?.active_workspace?.id,
      'bearer token resolves authenticated user and workspace context',
      { status: session.status, body: session.json },
    );
    const run = await agentClient.json('/api/pitch-coach/run', {
      action: 'coach',
      inputs: { pitch: 'We help finance teams close their monthly books faster with AI reconciliation.' },
    });
    const runId = run.json?.run_id;
    assertFlow('agent token run accepted', run.status === 200 && typeof runId === 'string', 'bearer token can start a run', { status: run.status, body: run.json || run.text.slice(0, 500) });
    if (runId) {
      const done = await pollRun(agentClient, runId);
      assertFlow('agent token run completes', done.status === 200 && done.json?.status === 'success', 'bearer-token run reached success', { status: done.status, run_status: done.json?.status, error: done.json?.error });
    }

    const listTools = await agentClient.json('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { headers: { accept: 'application/json, text/event-stream' } });
    assertFlow('MCP tools/list', listTools.status === 200 && Array.isArray(listTools.json?.result?.tools), 'MCP tools/list returns tools', { status: listTools.status, tools: listTools.json?.result?.tools?.map((t) => t.name) });
    const discovered = await callMcp(anon, agentToken, 'discover_apps', { limit: 10 });
    assertFlow('MCP discover_apps', discovered.status === 200 && Array.isArray(discovered.payload?.apps), 'discover_apps returned app list', { status: discovered.status, count: discovered.payload?.apps?.length });
    const skill = await callMcp(anon, agentToken, 'get_app_skill', { slug: 'pitch-coach' });
    assertFlow('MCP get_app_skill', skill.status === 200 && skill.payload?.slug === 'pitch-coach', 'get_app_skill returned pitch-coach', { status: skill.status, payload: skill.payload });
    const mcpRun = await callMcp(anon, agentToken, 'run_app', { slug: 'pitch-coach', action: 'coach', inputs: { pitch: 'We help support leaders cut ticket escalations with AI routing.' } });
    assertFlow('MCP run_app', mcpRun.status === 200 && !mcpRun.json?.error && mcpRun.payload?.run?.status === 'success', 'run_app returned a successful run payload', { status: mcpRun.status, payload: mcpRun.payload, error: mcpRun.json?.error });

    const revoke = await authClient.request(`/api/me/agent-keys/${agentTokenId}/revoke`, { method: 'POST' });
    assertFlow('agent token revoke', revoke.status === 204, 'agent token revoked', { status: revoke.status });
    const revokedSession = await agentClient.request('/api/session/me');
    assertFlow('agent token rejected after revoke', revokedSession.status === 401, 'revoked bearer returns 401', { status: revokedSession.status, body: revokedSession.json || revokedSession.text.slice(0, 500) });
  }

  const uniqueSlug = `launch-e2e-${runStamp}`;
  const disallowed = await authClient.json('/api/hub/detect', {
    openapi_url: 'http://127.0.0.1/openapi.json',
    slug: `${uniqueSlug}-blocked`,
  });
  assertFlow('trust+safety disallowed URL', disallowed.status >= 400 && /disallowed|loopback|private|Invalid/i.test(disallowed.text), 'loopback OpenAPI URL rejected', { status: disallowed.status, body: disallowed.json || disallowed.text.slice(0, 500) });

  const ingest = await authClient.json('/api/hub/ingest', {
    openapi_url: 'https://petstore3.swagger.io/api/v3/openapi.json',
    slug: uniqueSlug,
    name: 'Launch E2E Petstore',
    description: 'Launch-readiness private app smoke.',
    visibility: 'private',
    max_run_retention_days: 30,
  });
  const ingestOk = assertFlow('trust+safety allowed ingest', [200, 201].includes(ingest.status) && ingest.json?.slug === uniqueSlug, 'public OpenAPI URL ingested as private app', { status: ingest.status, body: ingest.json || ingest.text.slice(0, 500) });

  if (ingestOk) {
    const sharing = await authClient.json(`/api/me/apps/${uniqueSlug}/sharing`, {
      state: 'link',
    }, { method: 'PATCH' });
    const key = sharing.json?.link_share_token;
    const shareOk = assertFlow('sharing create link token', sharing.status === 200 && typeof key === 'string', 'private app moved to link visibility with token', { status: sharing.status, body: sharing.json || sharing.text.slice(0, 500) });
    if (shareOk) {
      const good = await anon.request(`/p/${uniqueSlug}?key=${encodeURIComponent(key)}`);
      const bad = await anon.request(`/p/${uniqueSlug}?key=bad-key`);
      assertFlow('sharing good key', good.status === 200, 'anonymous link token can load permalink', { status: good.status });
      assertFlow('sharing bad key', bad.status === 404, 'bad link token returns 404', { status: bad.status });
    }

    const adminToken = process.env.FLOOM_PREVIEW_ADMIN_TOKEN;
    if (!adminToken) {
      blocked('audit log live', 'FLOOM_PREVIEW_ADMIN_TOKEN not set');
    } else {
      const admin = new HttpClient(baseUrl, { authorization: `Bearer ${adminToken}` });
      const publish = await admin.json(`/api/admin/apps/${uniqueSlug}/publish-status`, { status: 'published' });
      const audit = await admin.request(`/api/admin/audit-log?action=admin.app_approved&target=app:${encodeURIComponent(ingest.json?.app_id || ingest.json?.id || '')}&limit=10`);
      assertFlow('audit publish action', publish.status === 200, 'admin publish-status returned 200', { status: publish.status, body: publish.json || publish.text.slice(0, 500) });
      assertFlow('audit log query', audit.status === 200 && Array.isArray(audit.json?.audit_log), 'admin audit-log returned rows array', { status: audit.status, rows: audit.json?.audit_log?.length });
    }

    await authClient.request(`/api/me/apps/${uniqueSlug}`, { method: 'DELETE' });
  }

  const deleted = await authClient.json('/api/me/delete-account', { confirm_email: email });
  const deleteOk = assertFlow('account soft-delete', deleted.status === 200 && typeof deleted.json?.delete_at === 'string', 'soft-delete returned delete_at', { status: deleted.status, body: deleted.json || deleted.text.slice(0, 500) });
  if (deleteOk) {
    const signin = await authClient.json('/auth/sign-in/email', { email, password });
    assertFlow('account soft-delete sign-in blocked', signin.status === 403 && signin.json?.delete_at && signin.json?.undo_url, 'sign-in after soft-delete returns 403 with delete_at and undo_url', { status: signin.status, body: signin.json || signin.text.slice(0, 500) });
  }
}

await runRetentionSweeperInProcess();
await runLivePreviewFlows();

const failed = results.filter((r) => r.status === 'fail');
const blockedResults = results.filter((r) => r.status === 'blocked');
const passed = results.filter((r) => r.status === 'pass');

console.log('\n=== launch-readiness summary ===');
console.log(`passed: ${passed.length}`);
console.log(`failed: ${failed.length}`);
console.log(`blocked: ${blockedResults.length}`);
for (const item of [...failed, ...blockedResults]) {
  console.log(`- ${item.status.toUpperCase()} ${item.flow}: ${item.detail}`);
}

if (failed.length || blockedResults.length) {
  process.exit(1);
}
