#!/usr/bin/env node
// Stress/unit coverage for scripts/ops/launch-apps-real-run-gate.sh.
//
// This test boots a local mock API for /api/run + /api/run/:id and executes
// the gate script against it twice:
//   1) all launch apps return non-dry-run payloads -> gate exits 0
//   2) one app returns dry_run=true + model="dry-run" -> gate exits 1

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const GATE_SCRIPT = join(REPO_ROOT, 'scripts', 'ops', 'launch-apps-real-run-gate.sh');

const SLUGS = [
  'lead-scorer',
  'competitor-lens',
  'ai-readiness-audit',
  'pitch-coach',
];

let passed = 0;
let failed = 0;

function log(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function outputsForSlug(slug, failingSlug) {
  if (slug === failingSlug) {
    if (slug === 'competitor-lens') {
      return {
        positioning: [],
        pricing: [],
        pricing_insight: 'dry-run failure fixture',
        unique_to_you: [],
        unique_to_competitor: [],
        meta: { dry_run: true, model: 'dry-run' },
      };
    }
    return { dry_run: true, model: 'dry-run' };
  }

  if (slug === 'competitor-lens') {
    return {
      positioning: [],
      pricing: [],
      pricing_insight: 'ok',
      unique_to_you: [],
      unique_to_competitor: [],
      meta: { dry_run: false, model: 'gemini-2.5-flash-lite' },
    };
  }

  return {
    dry_run: false,
    model: 'gemini-2.5-flash-lite',
  };
}

async function getFreePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function startMockRunApi(failingSlug = null) {
  const port = await getFreePort();
  const runToSlug = new Map();
  let nextId = 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/api/run') {
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) raw += chunk;

      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      const slug = body?.app_slug;
      if (!SLUGS.includes(slug)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `unknown slug: ${slug}` }));
        return;
      }

      const runId = `run-${nextId++}`;
      runToSlug.set(runId, slug);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ run_id: runId, status: 'pending' }));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/run/')) {
      const runId = url.pathname.slice('/api/run/'.length);
      const slug = runToSlug.get(runId);
      if (!slug) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'run not found' }));
        return;
      }

      const row = {
        id: runId,
        status: 'success',
        outputs: outputsForSlug(slug, failingSlug),
        duration_ms: 1200,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(row));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function runGate(baseUrl) {
  return await new Promise((resolve) => {
    const child = spawn(
      'bash',
      [
        GATE_SCRIPT,
        '--base-url',
        baseUrl,
        '--poll-interval-ms',
        '10',
        '--poll-timeout-ms',
        '1000',
        '--max-run-ms',
        '30000',
      ],
      {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ status: code, stdout, stderr });
    });
  });
}

console.log('launch-apps no-dry-run gate');

{
  const mock = await startMockRunApi(null);
  try {
    const result = await runGate(mock.baseUrl);
    log('gate passes when all apps return dry_run=false', result.status === 0, result.stderr || result.stdout);
    assert.equal(result.status, 0);
  } finally {
    await mock.close();
  }
}

{
  const mock = await startMockRunApi('pitch-coach');
  try {
    const result = await runGate(mock.baseUrl);
    log('gate fails when one app returns dry_run=true', result.status === 1, result.stderr || result.stdout);
    assert.equal(result.status, 1);
  } finally {
    await mock.close();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
