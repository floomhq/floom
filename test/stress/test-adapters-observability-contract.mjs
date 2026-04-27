#!/usr/bin/env node
// Contract tests for the ObservabilityAdapter.
//
// These tests define executable conformance checks for no-throw behavior,
// secret scrubbing, tag pass-through, and no-op fallback mode. They print the
// complete tally and exit non-zero when any assertion fails.
//
// Run: tsx test/stress/test-adapters-observability-contract.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-observability-contract-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
delete process.env.SENTRY_DSN;

function preserveSelectedConcernEnv() {
  const selected = process.env.FLOOM_CONFORMANCE_CONCERN;
  for (const k of [
    'FLOOM_RUNTIME',
    'FLOOM_STORAGE',
    'FLOOM_AUTH',
    'FLOOM_SECRETS',
    'FLOOM_OBSERVABILITY',
  ]) {
    if (selected && k === `FLOOM_${selected.toUpperCase()}`) continue;
    delete process.env[k];
  }
}
preserveSelectedConcernEnv();

const { adapters } = await import('../../apps/server/src/adapters/index.ts');
const { __testing } = await import('../../apps/server/src/lib/sentry.ts');
const observability = adapters.observability;

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  ok    ${label}`);
}

function fail(label, reason) {
  failed++;
  console.log(`  FAIL  ${label}: ${reason}`);
}

async function check(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (err) {
    fail(label, err && err.message ? err.message : String(err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function captureConsole(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

console.log('adapter-observability contract tests');

try {
  await check('never throws on malformed input', async () => {
    observability.captureError(undefined, { request: { cookie: 'secret-cookie' } });
    observability.increment('', NaN, { bad: 'tag' });
    observability.timing('negative.duration', -1, { route: '/x' });
    observability.gauge('infinite.gauge', Infinity, { app_type: 'docker' });
  });

  await check('secret scrubbing redacts sensitive error context', async () => {
    const context = {
      password: 'hunter2',
      api_key: 'sk-abc',
      nested: {
        cookie: 'session-cookie',
        safe: 'visible',
      },
    };
    const scrubbed = __testing.scrubSecrets(structuredClone(context));
    const serialized = JSON.stringify(scrubbed);
    assert(!serialized.includes('hunter2'), serialized);
    assert(!serialized.includes('sk-abc'), serialized);
    assert(!serialized.includes('session-cookie'), serialized);
    assert(serialized.includes('[Scrubbed]'), serialized);
    assert(serialized.includes('visible'), serialized);
  });

  await check('tag pass-through keeps metric tag keys and values', async () => {
    const lines = captureConsole(() => {
      observability.increment('run.started', 1, {
        app_type: 'docker',
        workspace_id: 'local',
      });
    });
    const joined = lines.join('\n');
    assert(joined.includes('run.started'), joined);
    assert(joined.includes('app_type=docker'), joined);
    assert(joined.includes('workspace_id=local'), joined);
  });

  await check('no-op fallback works without SENTRY_DSN or endpoint', async () => {
    delete process.env.SENTRY_DSN;
    const lines = captureConsole(() => {
      observability.captureError(new Error('no dsn'), { token: 'secret-token' });
      observability.timing('run.ms', 42, { app_type: 'proxied' });
      observability.gauge('queue.depth', 0, { queue: 'default' });
    });
    const joined = lines.join('\n');
    assert(joined.includes('app_type=proxied'), joined);
    assert(joined.includes('queue=default'), joined);
    assert(!joined.includes('secret-token'), joined);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passing, ${failed} failing`);
process.exit(failed > 0 ? 1 : 0);
