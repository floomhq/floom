#!/usr/bin/env node
// Studio renderer preview helper tests.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const mod = await import(
  pathToFileURL(
    resolve(import.meta.dirname, '../../apps/web/src/lib/renderer-preview.ts'),
  ).href,
);

const {
  buildRendererPreviewOutput,
  buildRendererPreviewPick,
  buildRendererPreviewRun,
  creatorRunToPreviewRun,
} = mod;

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

const app = {
  slug: 'lead-scorer',
  name: 'Lead Scorer',
  description: 'Score inbound leads',
  category: 'sales',
  icon: null,
  author: null,
  actions: ['score'],
  runtime: 'python',
  created_at: '2026-04-22T09:00:00.000Z',
  manifest: {
    name: 'Lead Scorer',
    description: 'Score inbound leads',
    actions: {
      score: {
        label: 'Score lead',
        inputs: [],
        outputs: [{ name: 'result', label: 'Result', type: 'json' }],
      },
      compare: {
        label: 'Compare leads',
        inputs: [],
        outputs: [{ name: 'rows', label: 'Rows', type: 'table' }],
      },
    },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
    primary_action: 'score',
  },
};

check('buildRendererPreviewPick mirrors app identity', () => {
  const pick = buildRendererPreviewPick(app);
  assert.equal(pick.slug, 'lead-scorer');
  assert.equal(pick.name, 'Lead Scorer');
  assert.equal(pick.confidence, 1);
});

check('buildRendererPreviewRun uses primary action and success status', () => {
  const run = buildRendererPreviewRun(app, 'table');
  assert.equal(run.action, 'score');
  assert.equal(run.status, 'success');
  assert.equal(run.app_slug, 'lead-scorer');
  assert.ok(Array.isArray(run.outputs));
});

check('buildRendererPreviewRun falls back to first action when primary is invalid', () => {
  const fallbackApp = {
    ...app,
    manifest: {
      ...app.manifest,
      primary_action: 'missing',
    },
  };
  const run = buildRendererPreviewRun(fallbackApp, 'text');
  assert.equal(run.action, 'score');
});

check('buildRendererPreviewOutput: markdown creates a markdown field', () => {
  const output = buildRendererPreviewOutput('markdown', 'Lead Scorer');
  assert.equal(typeof output.markdown, 'string');
  assert.match(output.markdown, /Lead Scorer preview/);
});

check('buildRendererPreviewOutput: table is deterministic', () => {
  const output = buildRendererPreviewOutput('table', 'Lead Scorer');
  assert.equal(Array.isArray(output), true);
  assert.equal(output.length, 2);
  assert.equal(output[0].company, 'Acme');
});

check('creatorRunToPreviewRun preserves latest successful run data', () => {
  const run = creatorRunToPreviewRun(app, {
    id: 'run-123',
    action: 'score',
    status: 'success',
    inputs: { company: 'Acme' },
    outputs: { score: 91 },
    duration_ms: 840,
    started_at: '2026-04-22T09:10:00.000Z',
    finished_at: '2026-04-22T09:10:00.840Z',
    error: null,
    error_type: null,
    upstream_status: null,
    caller_hash: 'anon',
    is_self: true,
  });
  assert.equal(run.id, 'run-123');
  assert.equal(run.app_slug, 'lead-scorer');
  assert.equal(run.outputs.score, 91);
  assert.equal(run.logs, '');
});

if (failed > 0) {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\n${passed} passed, 0 failed`);
