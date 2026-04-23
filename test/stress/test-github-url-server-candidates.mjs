#!/usr/bin/env node
// Regression: server-side generateSpecCandidates must translate
// github.com web URLs into raw.githubusercontent.com probes.
//
// Bug (2026-04-23, Federico's second report):
//   Pasting https://github.com/federicodeponte/openblog at /build → server
//   receives the raw github.com URL and probes
//     https://github.com/federicodeponte/openapi.json  (404, wrong path)
//     https://github.com/federicodeponte/openblog/openapi.json  (404, HTML 200)
//   instead of the actual file at
//     https://raw.githubusercontent.com/federicodeponte/openblog/main/openapi.json
//   …resulting in "couldn't find your app file" even though the spec is RIGHT
//   THERE. Web side already does the translation, but MCP clients + direct
//   API callers hit the raw server path.
//
// Run: pnpm exec tsx test/stress/test-github-url-server-candidates.mjs

import {
  generateSpecCandidates,
  parseGithubWebUrl,
  buildGithubRawCandidates,
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

console.log('server-side GitHub URL candidate generation');

// --- parseGithubWebUrl coverage ---
{
  const p = parseGithubWebUrl('https://github.com/federicodeponte/openblog');
  if (!p) fail('parse bare repo', 'got null');
  else if (p.owner === 'federicodeponte' && p.repo === 'openblog' && p.branch === null && p.subdir === '' && !p.directSpecRawUrl) {
    ok('parse bare repo');
  } else fail('parse bare repo', JSON.stringify(p));
}

{
  const p = parseGithubWebUrl('https://github.com/owner/repo.git');
  if (p?.repo === 'repo') ok('strip .git suffix');
  else fail('strip .git suffix', JSON.stringify(p));
}

{
  const p = parseGithubWebUrl('https://github.com/owner/repo/tree/develop');
  if (p?.branch === 'develop' && p.subdir === '') ok('parse tree + branch');
  else fail('parse tree + branch', JSON.stringify(p));
}

{
  const p = parseGithubWebUrl('https://github.com/owner/repo/tree/main/api/docs');
  if (p?.branch === 'main' && p.subdir === 'api/docs') ok('parse tree + branch + subdir');
  else fail('parse tree + branch + subdir', JSON.stringify(p));
}

{
  const p = parseGithubWebUrl('https://github.com/owner/repo/blob/main/openapi.yaml');
  if (
    p?.branch === 'main' &&
    p.directSpecRawUrl === 'https://raw.githubusercontent.com/owner/repo/main/openapi.yaml'
  ) {
    ok('parse blob URL → direct raw file');
  } else fail('parse blob URL → direct raw file', JSON.stringify(p));
}

{
  const p = parseGithubWebUrl('https://github.com/marketplace/actions/foo');
  if (p === null) ok('reject reserved owner (marketplace)');
  else fail('reject reserved owner (marketplace)', JSON.stringify(p));
}

{
  const p = parseGithubWebUrl('https://gitlab.com/owner/repo');
  if (p === null) ok('reject non-github host');
  else fail('reject non-github host', JSON.stringify(p));
}

{
  const p = parseGithubWebUrl('https://github.com/only-owner');
  if (p === null) ok('reject single-segment owner-only path');
  else fail('reject single-segment owner-only path', JSON.stringify(p));
}

// --- buildGithubRawCandidates coverage ---
{
  const p = parseGithubWebUrl('https://github.com/federicodeponte/openblog');
  const cands = buildGithubRawCandidates(p);
  const expected = 'https://raw.githubusercontent.com/federicodeponte/openblog/main/openapi.json';
  if (cands.includes(expected)) ok('bare repo → main/openapi.json in candidates');
  else fail('bare repo → main/openapi.json in candidates', cands.join(' | '));

  const all = cands.join(' ');
  if (all.includes('openapi.yaml')) ok('bare repo → yaml variant included');
  else fail('bare repo → yaml variant included', all);
}

{
  const p = parseGithubWebUrl('https://github.com/owner/repo/blob/main/api/openapi.yaml');
  const cands = buildGithubRawCandidates(p);
  if (cands[0] === 'https://raw.githubusercontent.com/owner/repo/main/api/openapi.yaml') {
    ok('blob URL → exact file leads');
  } else fail('blob URL → exact file leads', cands[0]);
}

// --- generateSpecCandidates integration ---
{
  const cands = generateSpecCandidates('https://github.com/federicodeponte/openblog');
  if (cands.every((c) => c.startsWith('https://raw.githubusercontent.com/'))) {
    ok('generateSpecCandidates rewrites github.com → raw (no github.com candidates)');
  } else fail(
    'generateSpecCandidates rewrites github.com → raw (no github.com candidates)',
    cands.filter((c) => !c.startsWith('https://raw.githubusercontent.com/')).join(' | '),
  );

  const expected = 'https://raw.githubusercontent.com/federicodeponte/openblog/main/openapi.json';
  if (cands.includes(expected)) ok('generateSpecCandidates includes openblog/main/openapi.json');
  else fail('generateSpecCandidates includes openblog/main/openapi.json', cands.join('\n    '));
}

{
  // Regression: the old buggy output.
  const cands = generateSpecCandidates('https://github.com/federicodeponte/openblog');
  const bad = cands.filter((c) =>
    c === 'https://github.com/openapi.json' ||
    c === 'https://github.com/federicodeponte/openapi.json' ||
    c === 'https://github.com/federicodeponte/openblog/openapi.json',
  );
  if (bad.length === 0) ok('no more github.com/<x>/openapi.json 404 traps');
  else fail('no more github.com/<x>/openapi.json 404 traps', bad.join(' | '));
}

{
  // Non-github URLs still use the generic walk-up path logic.
  const cands = generateSpecCandidates('https://api.example.com/v2/users/orders');
  if (cands[0] === 'https://api.example.com/v2/users/orders') {
    ok('non-github URL: original URL still leads');
  } else fail('non-github URL: original URL still leads', cands[0]);
}

// --- Live probe (only when NO_NETWORK is not set) ---
if (!process.env.NO_NETWORK) {
  console.log('\nlive openblog detect (skip with NO_NETWORK=1)');
  try {
    const mod = await import('../../apps/server/src/services/openapi-ingest.ts');
    const result = await mod.detectAppFromUrl('https://github.com/federicodeponte/openblog');
    if (result?.slug === 'openblog-neo-api') {
      ok('live detect returns openblog-neo-api');
    } else {
      fail('live detect returns openblog-neo-api', JSON.stringify({ slug: result?.slug, name: result?.name }));
    }
  } catch (err) {
    fail('live detect', err?.message || String(err));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
