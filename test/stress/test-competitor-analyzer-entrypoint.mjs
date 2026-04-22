#!/usr/bin/env node
// Competitor Analyzer entrypoint contract regression.
//
// The docker runner only treats app output as a success when the entrypoint
// emits a single-line JSON envelope or the canonical __FLOOM_RESULT__ marker.
// This test runs the real Python entrypoint in dry-run mode and asserts that
// both the success path and a validation-error path emit the marker envelope.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

let passed = 0;
let failed = 0;

function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

function runCase(payload) {
  return spawnSync(
    'python3',
    [resolve('examples/competitor-analyzer/main.py'), JSON.stringify(payload)],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: { ...process.env, GEMINI_API_KEY: '' },
    },
  );
}

function parseMarker(stdout) {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.startsWith('__FLOOM_RESULT__'));
  if (!line) return null;
  return JSON.parse(line.slice('__FLOOM_RESULT__'.length));
}

console.log('competitor-analyzer entrypoint contract');

{
  const result = runCase({
    action: 'analyze',
    inputs: {
      urls: ['https://n8n.io', 'https://vercel.com'],
      your_product: 'We sell B2B sales automation software to EU mid-market teams.',
    },
  });
  const parsed = parseMarker(result.stdout);
  log('dry-run success exits 0', result.status === 0, `status=${result.status} stderr=${result.stderr}`);
  log('dry-run success emits __FLOOM_RESULT__ marker', !!parsed, result.stdout.slice(0, 400));
  log('dry-run success parses as ok:true', parsed?.ok === true, JSON.stringify(parsed));
  log('dry-run outputs include competitors[]', Array.isArray(parsed?.outputs?.competitors), JSON.stringify(parsed?.outputs));
  log('dry-run outputs mark meta.dry_run=true', parsed?.outputs?.meta?.dry_run === true, JSON.stringify(parsed?.outputs?.meta));
}

{
  const result = runCase({
    action: 'analyze',
    inputs: {
      urls: [],
      your_product: 'We sell B2B sales automation software to EU mid-market teams.',
    },
  });
  const parsed = parseMarker(result.stdout);
  log('validation error exits non-zero', result.status === 2, `status=${result.status} stderr=${result.stderr}`);
  log('validation error still emits __FLOOM_RESULT__ marker', !!parsed, result.stdout.slice(0, 400));
  log('validation error parses as ok:false', parsed?.ok === false, JSON.stringify(parsed));
  log(
    'validation error keeps the exact user-facing message',
    parsed?.error === 'inputs.urls must be a non-empty array',
    JSON.stringify(parsed),
  );
}

// Bug #350: the runtime manifest declares `urls` as a textarea (no native
// array type in v2.0). Direct API/MCP callers send the raw string; only the
// web UI splits client-side. The entrypoint must accept both shapes.
{
  const result = runCase({
    action: 'analyze',
    inputs: {
      urls: 'https://n8n.io\nhttps://vercel.com',
      your_product: 'We sell B2B sales automation software to EU mid-market teams.',
    },
  });
  const parsed = parseMarker(result.stdout);
  log('string urls (newline-separated) exits 0', result.status === 0, `status=${result.status} stderr=${result.stderr}`);
  log('string urls parses as ok:true', parsed?.ok === true, JSON.stringify(parsed));
  log('string urls normalizes to 2 competitors', parsed?.outputs?.competitors?.length === 2, JSON.stringify(parsed?.outputs?.competitors));
}

{
  const result = runCase({
    action: 'analyze',
    inputs: {
      urls: 'https://n8n.io, https://vercel.com',
      your_product: 'We sell B2B sales automation software to EU mid-market teams.',
    },
  });
  const parsed = parseMarker(result.stdout);
  log('string urls (comma-separated) exits 0', result.status === 0, `status=${result.status} stderr=${result.stderr}`);
  log('string urls (comma) normalizes to 2 competitors', parsed?.outputs?.competitors?.length === 2, JSON.stringify(parsed?.outputs?.competitors));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
