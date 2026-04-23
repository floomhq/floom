#!/usr/bin/env node
// Launch-hardening 2026-04-23: end-to-end smoke test for the 3 hero
// store apps (lead-scorer, competitor-analyzer, resume-screener) that
// are the ONLY public-runnable apps on floom.dev day 1.
//
// What it asserts per app:
//   1. Valid-input run returns 200 + sane JSON shape (has runId or job id).
//   2. Invalid-input run returns 4xx (NOT 5xx, NOT 200 with error strings
//      leaked into logs).
//   3. 10 concurrent valid runs across all 3 apps: zero 5xx responses,
//      every dispatch at least accepted by the server.
//
// Dry-run mode: if GEMINI_API_KEY is not configured on the target
// server, the Python handlers bail out early with a synthetic
// result payload (dry_run: true). That's fine for the smoke test —
// we're exercising the HTTP layer, body-size cap, rate limiter,
// manifest validation, and container orchestration. LLM correctness
// is covered by examples/<slug>/test-integration.py.
//
// Usage:
//   BASE=http://127.0.0.1:8787 COOKIE="floom.session_token=..." \
//     node scripts/store-smoke-test.mjs
//   # Or for anonymous-mode tests (the production launch-day path):
//   BASE=http://127.0.0.1:8787 node scripts/store-smoke-test.mjs
//
// Exit code: 0 = all green, 1 = at least one assertion failed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const COOKIE = process.env.COOKIE || '';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 90_000);
const POLL_INTERVAL_MS = 1_000;

const SLUGS = ['lead-scorer', 'competitor-analyzer', 'resume-screener'];

// ---------------------------------------------------------------------------
// Per-slug valid + invalid input fixtures. Kept small so the smoke test
// runs in <90s even when the backend has to pull the image cold.
// ---------------------------------------------------------------------------

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}

const SAMPLE_CSV = `company,website,industry,country\nStripe,stripe.com,fintech,US\nMonzo,monzo.com,fintech,UK\nRevolut,revolut.com,fintech,UK\n`;

function fileEnvelope(name, mimeType, bytes) {
  return {
    __file: true,
    name,
    mime_type: mimeType,
    size: bytes.length,
    content_b64: b64(bytes),
  };
}

function cvsZipEnvelope() {
  // Read the bundled sample that ships with the repo so we exercise
  // the real unzip codepath inside the container.
  const zipPath = path.resolve(
    __dirname,
    '..',
    'examples',
    'resume-screener',
    'sample-cvs',
    'cvs.zip',
  );
  const bytes = readFileSync(zipPath);
  return fileEnvelope('sample-cvs.zip', 'application/zip', bytes);
}

const VALID_INPUTS = {
  'lead-scorer': {
    action: 'score',
    inputs: {
      data: fileEnvelope('leads.csv', 'text/csv', Buffer.from(SAMPLE_CSV)),
      icp: 'B2B SaaS CFOs at 100-500 employee fintechs in EU.',
    },
  },
  'competitor-analyzer': {
    action: 'analyze',
    inputs: {
      urls: ['https://linear.app', 'https://notion.so', 'https://asana.com'],
      your_product:
        'B2B sales automation software for EU mid-market teams.',
    },
  },
  'resume-screener': {
    action: 'screen',
    inputs: {
      cvs_zip: cvsZipEnvelope(),
      job_description:
        'Senior Backend Engineer (Remote EU). 5+ years Python. ' +
        'Postgres, FastAPI, Redis, AWS.',
      must_haves: '5+ years Python\nProduction Postgres experience',
    },
  },
};

// Invalid-input fixtures. Each should be rejected by manifest
// validation BEFORE the container runs — i.e. fast 400 from the
// server, not a 500 or a 200 with a crashed exit code.
const INVALID_INPUTS = {
  'lead-scorer': {
    // Missing required `data` file + empty icp string (fails required+minLen).
    action: 'score',
    inputs: { icp: '' },
  },
  'competitor-analyzer': {
    // Non-array `urls` violates the manifest shape.
    action: 'analyze',
    inputs: { urls: 'not-an-array', your_product: '' },
  },
  'resume-screener': {
    // Empty required textarea.
    action: 'screen',
    inputs: { job_description: '' },
  },
};

// ---------------------------------------------------------------------------
// HTTP helpers.
// ---------------------------------------------------------------------------

async function postRun(slug, body) {
  const url = `${BASE}/api/${slug}/run`;
  const headers = { 'content-type': 'application/json' };
  if (COOKIE) headers.cookie = COOKIE;
  const started = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return {
    status: resp.status,
    body: parsed,
    raw: text,
    ms: Date.now() - started,
  };
}

async function pollRun(runId, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const url = `${BASE}/api/run/${runId}`;
  const headers = {};
  if (COOKIE) headers.cookie = COOKIE;
  while (Date.now() < deadline) {
    const resp = await fetch(url, { headers });
    if (resp.status !== 200) {
      return { status: resp.status, body: null, terminal: true };
    }
    const j = await resp.json();
    if (j.status === 'succeeded' || j.status === 'failed') {
      return { status: 200, body: j, terminal: true };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status: 408, body: null, terminal: false };
}

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`  [${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function checkValidRun(slug) {
  const body = VALID_INPUTS[slug];
  const r = await postRun(slug, body);
  if (r.status !== 200 && r.status !== 202) {
    record(
      `${slug}: valid input accepted`,
      false,
      `got ${r.status} (${r.raw?.slice(0, 200)})`,
    );
    return;
  }
  const runId = r.body?.runId ?? r.body?.run_id ?? r.body?.id;
  if (!runId) {
    record(
      `${slug}: valid input returns runId`,
      false,
      `no runId in ${JSON.stringify(r.body).slice(0, 200)}`,
    );
    return;
  }
  record(
    `${slug}: valid input accepted`,
    true,
    `run=${runId} dispatch=${r.ms}ms`,
  );
  const polled = await pollRun(runId, TIMEOUT_MS);
  if (!polled.terminal) {
    record(`${slug}: valid run reaches terminal state`, false, 'timeout');
    return;
  }
  const status = polled.body?.status;
  record(
    `${slug}: valid run finished`,
    status === 'succeeded' || status === 'failed',
    `status=${status} exit=${polled.body?.exitCode ?? polled.body?.exit_code}`,
  );
}

async function checkInvalidRun(slug) {
  const body = INVALID_INPUTS[slug];
  const r = await postRun(slug, body);
  // Manifest validation should reject with 400/422. Never 5xx. Never
  // 200 (because then the container would run with garbage input).
  const ok = r.status >= 400 && r.status < 500;
  record(
    `${slug}: invalid input rejected 4xx`,
    ok,
    `got ${r.status} (${r.raw?.slice(0, 180)})`,
  );
}

async function checkConcurrentWaves() {
  // 10 concurrent dispatches spread across the 3 apps. Assertion: no
  // 5xx, no dropped connections. Do NOT poll to completion — we're
  // measuring dispatch health, not Gemini latency.
  const tasks = [];
  for (let i = 0; i < 10; i++) {
    const slug = SLUGS[i % SLUGS.length];
    tasks.push(postRun(slug, VALID_INPUTS[slug]).then((r) => ({ slug, ...r })));
  }
  const resps = await Promise.all(tasks);
  const fiveXX = resps.filter((r) => r.status >= 500);
  const rejectedOther = resps.filter(
    (r) => r.status !== 200 && r.status !== 202 && r.status !== 429,
  );
  record(
    `concurrent x10: no 5xx`,
    fiveXX.length === 0,
    fiveXX.length
      ? fiveXX.map((r) => `${r.slug}=${r.status}`).join(', ')
      : undefined,
  );
  record(
    `concurrent x10: every dispatch valid (2xx or 429-throttle OK)`,
    rejectedOther.length === 0,
    rejectedOther.length
      ? rejectedOther.map((r) => `${r.slug}=${r.status}`).join(', ')
      : undefined,
  );
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

(async () => {
  console.log(`Store smoke test → ${BASE}`);
  console.log(`  cookie=${COOKIE ? 'set' : '(anonymous)'}  timeout=${TIMEOUT_MS}ms\n`);

  for (const slug of SLUGS) {
    console.log(`— ${slug} —`);
    await checkInvalidRun(slug);
    await checkValidRun(slug);
  }

  console.log('\n— concurrent dispatch —');
  await checkConcurrentWaves();

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${failed.length === 0 ? 'ALL GREEN' : 'FAILURES'}: ${results.length - failed.length}/${results.length} assertions passed`,
  );
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('smoke-test crashed:', err);
  process.exit(2);
});
