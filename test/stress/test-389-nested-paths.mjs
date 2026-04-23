#!/usr/bin/env node
// Regression test for issue #389: /api/hub/detect fails on nested OpenAPI
// paths. Covers the full acceptance matrix:
//
//   - Nested JSON spec (/api/v3/openapi.json) resolves on candidate 0
//   - Nested YAML spec (/api/v3/openapi.yaml) resolves on candidate 0
//   - Spec behind a 301/302 redirect chain
//   - Path ending `/` (directory) detects via fanout
//   - text/plain YAML (raw.githubusercontent.com serves YAML as text/plain)
//   - GitHub raw URL at a nested path — candidates stay within the repo
//     (no `https://raw.githubusercontent.com/openapi.json` garbage)
//   - Bare GitHub repo whose spec is in a subfolder (Redocly/openapi-starter)
//
// Offline assertions on `generateSpecCandidates` run with NO_NETWORK=1.
// Live-network assertions on `fetchSpecWithFallback` + `detectAppFromUrl`
// run against the public Swagger Petstore + Redocly starter when
// NO_NETWORK is unset.
//
// Run: pnpm exec tsx test/stress/test-389-nested-paths.mjs

import {
  generateSpecCandidates,
  fetchSpecWithFallback,
  detectAppFromUrl,
  parseGithubWebUrl,
  SpecNotFoundError,
} from '../../apps/server/src/services/openapi-ingest.ts';

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  ok    ${label}`);
}
function fail(label, detail) {
  failed++;
  console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
}
function assertFirst(cands, url, label) {
  if (cands[0] === url) ok(label);
  else fail(label, `expected ${url}, got ${cands[0]}`);
}
function assertContains(cands, url, label) {
  if (cands.includes(url)) ok(label);
  else fail(label, `expected to contain ${url}, got:\n    ${cands.join('\n    ')}`);
}
function assertNone(cands, predicate, label) {
  const bad = cands.filter(predicate);
  if (bad.length === 0) ok(label);
  else fail(label, `unwanted: ${bad.join(' | ')}`);
}

console.log('#389 nested-paths: offline candidate generation');

// --- (1) Nested JSON spec: input must lead; no self-as-directory garbage ---
{
  const cands = generateSpecCandidates('https://petstore3.swagger.io/api/v3/openapi.json');
  assertFirst(cands, 'https://petstore3.swagger.io/api/v3/openapi.json', 'nested .json: input URL leads');
  assertNone(
    cands,
    (c) => c.includes('/openapi.json/openapi.'),
    'nested .json: no `/openapi.json/openapi.*` self-appended garbage',
  );
}

// --- (2) Nested YAML spec: same ---
{
  const cands = generateSpecCandidates('https://petstore3.swagger.io/api/v3/openapi.yaml');
  assertFirst(cands, 'https://petstore3.swagger.io/api/v3/openapi.yaml', 'nested .yaml: input URL leads');
  assertNone(
    cands,
    (c) => c.includes('/openapi.yaml/openapi.'),
    'nested .yaml: no `/openapi.yaml/openapi.*` self-appended garbage',
  );
  // Should also try the .json sibling at the same path as a fallback.
  assertContains(
    cands,
    'https://petstore3.swagger.io/api/v3/openapi.json',
    'nested .yaml: sibling .json is in candidates',
  );
}

// --- (3) Path ending `/` (directory) → index filenames are probed ---
{
  const cands = generateSpecCandidates('https://api.example.com/docs/');
  if (
    cands.some((c) => c.endsWith('/index.yaml')) ||
    cands.some((c) => c.endsWith('/index.json')) ||
    cands.some((c) => c.endsWith('/index.yml'))
  ) ok('trailing-slash: index.{yaml,json,yml} appears in candidates');
  else fail('trailing-slash: index.{yaml,json,yml} appears in candidates', cands.join(' | '));
}

// --- (4) GitHub raw URL at nested path: candidates stay within repo ---
{
  const cands = generateSpecCandidates(
    'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.yaml',
  );
  assertFirst(
    cands,
    'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.yaml',
    'raw nested: input URL leads',
  );
  assertNone(
    cands,
    (c) =>
      c === 'https://raw.githubusercontent.com/openapi.json' ||
      c === 'https://raw.githubusercontent.com/Redocly/openapi.json' ||
      c === 'https://raw.githubusercontent.com/Redocly/openapi-starter/openapi.json',
    'raw nested: no domain-root garbage (owner-level, repo-level, branchless probes)',
  );
  // Should still try sibling filenames at the same nested path.
  assertContains(
    cands,
    'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.json',
    'raw nested: sibling .json in same subdir is probed',
  );
  // And should fall back to repo root within the same branch.
  assertContains(
    cands,
    'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi.yaml',
    'raw nested: falls back to <branch>/openapi.yaml at repo root',
  );
}

// --- (5) parseGithubWebUrl accepts raw.githubusercontent.com ---
{
  const parsed = parseGithubWebUrl(
    'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.yaml',
  );
  if (
    parsed?.owner === 'Redocly' &&
    parsed.repo === 'openapi-starter' &&
    parsed.branch === 'main' &&
    parsed.subdir === 'openapi' &&
    parsed.directSpecRawUrl?.endsWith('/openapi/openapi.yaml')
  ) ok('parseGithubWebUrl accepts raw.githubusercontent.com nested file URL');
  else fail('parseGithubWebUrl accepts raw.githubusercontent.com nested file URL', JSON.stringify(parsed));
}

{
  // Raw URL under a path without a filename extension → treat the whole
  // rest as subdir, no directSpecRawUrl (no filename to lock onto).
  const parsed = parseGithubWebUrl(
    'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/',
  );
  if (
    parsed?.owner === 'Redocly' &&
    parsed.repo === 'openapi-starter' &&
    parsed.branch === 'main' &&
    parsed.subdir === 'openapi' &&
    parsed.directSpecRawUrl === null
  ) ok('parseGithubWebUrl raw URL with no filename → no directSpecRawUrl');
  else fail('parseGithubWebUrl raw URL with no filename → no directSpecRawUrl', JSON.stringify(parsed));
}

{
  // Raw URL with too few segments (just /owner/repo) → null.
  const parsed = parseGithubWebUrl('https://raw.githubusercontent.com/owner/repo');
  if (parsed === null) ok('parseGithubWebUrl raw URL needs owner/repo/branch minimum');
  else fail('parseGithubWebUrl raw URL needs owner/repo/branch minimum', JSON.stringify(parsed));
}

// --- (6) Bare GitHub repo: probes common subdirs (openapi/, docs/, api/, spec/) ---
{
  const cands = generateSpecCandidates('https://github.com/Redocly/openapi-starter');
  // Root probes come first (openblog regression).
  assertFirst(
    cands,
    'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi.yaml',
    'bare repo: root openapi.yaml leads',
  );
  // Subdir probes present for Redocly-style layouts.
  assertContains(
    cands,
    'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.yaml',
    'bare repo: probes `openapi/openapi.yaml` subdir',
  );
}

// --- (7) Candidate cap stays at 8 so total budget holds ---
{
  const cands = generateSpecCandidates('https://api.example.com/v3/docs/openapi.json');
  if (cands.length <= 8) ok('candidate cap holds at ≤8');
  else fail('candidate cap holds at ≤8', `got ${cands.length}: ${cands.join(' | ')}`);
}

// --- (8) SpecNotFoundError carries the list of attempted URLs ---
// (offline: can't call fetchSpecWithFallback without network, so we just
// type-check that the constructor shape is public.)
{
  const err = new SpecNotFoundError('https://nope.invalid/x', ['a', 'b']);
  if (err.code === 'spec_not_found' && Array.isArray(err.attempted) && err.attempted.length === 2)
    ok('SpecNotFoundError carries code + attempted list');
  else fail('SpecNotFoundError carries code + attempted list', JSON.stringify(err));
}

// --- Live assertions (skip with NO_NETWORK=1) ---
if (!process.env.NO_NETWORK) {
  console.log('\n#389 nested-paths: live network (skip with NO_NETWORK=1)');

  // Petstore v3 — nested JSON
  try {
    const { url } = await fetchSpecWithFallback('https://petstore3.swagger.io/api/v3/openapi.json');
    if (url === 'https://petstore3.swagger.io/api/v3/openapi.json')
      ok('live: Petstore v3 nested .json resolves on candidate 0');
    else fail('live: Petstore v3 nested .json resolves on candidate 0', url);
  } catch (err) {
    fail('live: Petstore v3 nested .json', err?.message || String(err));
  }

  // Petstore v3 — nested YAML with application/yaml content-type
  try {
    const { url } = await fetchSpecWithFallback('https://petstore3.swagger.io/api/v3/openapi.yaml');
    if (url === 'https://petstore3.swagger.io/api/v3/openapi.yaml')
      ok('live: Petstore v3 nested .yaml resolves on candidate 0');
    else fail('live: Petstore v3 nested .yaml resolves on candidate 0', url);
  } catch (err) {
    fail('live: Petstore v3 nested .yaml', err?.message || String(err));
  }

  // Trailing slash — detect via fanout
  try {
    const { url } = await fetchSpecWithFallback('https://petstore3.swagger.io/api/v3/');
    // Any suffix at api/v3/ is valid — must just not throw.
    if (url.startsWith('https://petstore3.swagger.io/api/v3/'))
      ok('live: trailing-slash directory detects via suffix fanout');
    else fail('live: trailing-slash directory detects via suffix fanout', url);
  } catch (err) {
    fail('live: trailing-slash directory detects via suffix fanout', err?.message || String(err));
  }

  // GitHub raw at nested path — text/plain YAML
  try {
    const { url } = await fetchSpecWithFallback(
      'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.yaml',
    );
    if (url === 'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.yaml')
      ok('live: raw GitHub nested .yaml (text/plain Content-Type) parses');
    else fail('live: raw GitHub nested .yaml (text/plain Content-Type) parses', url);
  } catch (err) {
    fail('live: raw GitHub nested .yaml (text/plain Content-Type) parses', err?.message || String(err));
  }

  // Bare GitHub repo with subfolder spec — Redocly issue #389 primary repro
  try {
    const result = await detectAppFromUrl('https://github.com/Redocly/openapi-starter');
    if (
      result.openapi_spec_url ===
      'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.yaml'
    ) {
      ok('live: bare Redocly repo → detects subfolder spec (issue #389 primary repro)');
    } else {
      fail(
        'live: bare Redocly repo → detects subfolder spec (issue #389 primary repro)',
        result.openapi_spec_url,
      );
    }
  } catch (err) {
    fail('live: bare Redocly repo → detects subfolder spec', err?.message || String(err));
  }

  // GitHub blob URL at nested path — issue #389 explicit repro
  try {
    const { url } = await fetchSpecWithFallback(
      'https://github.com/Redocly/openapi-starter/blob/main/openapi/openapi.yaml',
    );
    if (url === 'https://raw.githubusercontent.com/Redocly/openapi-starter/main/openapi/openapi.yaml')
      ok('live: github.com /blob/ nested URL → direct raw spec');
    else fail('live: github.com /blob/ nested URL → direct raw spec', url);
  } catch (err) {
    fail('live: github.com /blob/ nested URL → direct raw spec', err?.message || String(err));
  }

  // Spec behind a 301/302 redirect chain. httpbin /redirect-to?url=... issues
  // a 302 to the target — forces the manual-redirect handler in fetchSpec.
  try {
    const target = 'https://petstore3.swagger.io/api/v3/openapi.json';
    const redirectUrl = `https://httpbin.org/redirect-to?url=${encodeURIComponent(target)}&status_code=302`;
    const { spec } = await fetchSpecWithFallback(redirectUrl);
    if (spec && (spec.openapi || spec.swagger) && Object.keys(spec.paths || {}).length > 0)
      ok('live: 302 redirect chain resolves to final spec');
    else fail('live: 302 redirect chain resolves to final spec', JSON.stringify(spec).slice(0, 100));
  } catch (err) {
    fail('live: 302 redirect chain resolves to final spec', err?.message || String(err));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
