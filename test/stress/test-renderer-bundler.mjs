#!/usr/bin/env node
// Renderer bundler unit tests.
//
// Exercises:
//   1. bundleRenderer compiles a minimal TSX file via esbuild
//   2. bundleRenderer is idempotent on identical source hash
//   3. resolveEntryPath rejects absolute paths, .. traversal, and missing files
//   4. bundleRendererFromManifest swallows errors and returns null
//   5. Bundle writes sidecar .hash and .shape files
//   6. hashSource is stable
//
// Uses a throwaway DATA_DIR so it never pollutes the real server DB.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-renderer-bundler-'));
process.env.DATA_DIR = tmp;
// The test imports the bundler from source (tsx compiles on the fly). We do
// NOT import via dist because db.ts has side effects at import time (opens a
// SQLite handle) and we want that to land in our tmp dir.
const {
  bundleRenderer,
  bundleRendererFromManifest,
  resolveEntryPath,
  hashSource,
  clearBundleIndexForTests,
  getBundleResult,
  getReactNodePaths,
  MAX_BUNDLE_BYTES,
} = await import('../../apps/server/src/services/renderer-bundler.ts');

let passed = 0;
let failed = 0;

function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

function throws(fn, msg) {
  try {
    fn();
    return false;
  } catch (err) {
    if (msg && !String(err.message).includes(msg)) return false;
    return true;
  }
}

async function throwsAsync(fn, msg) {
  try {
    await fn();
    return false;
  } catch (err) {
    if (msg && !String(err.message).includes(msg)) return false;
    return true;
  }
}

console.log('renderer bundler tests');

// Set up a fixture "manifest dir" with a tiny renderer.tsx
const manifestDir = join(tmp, 'fixture-app');
mkdirSync(manifestDir, { recursive: true });
const entryFile = join(manifestDir, 'renderer.tsx');
writeFileSync(
  entryFile,
  `import React from 'react';
export default function Demo({ data }) {
  return React.createElement('div', { className: 'demo' }, String(data));
}
`,
);

// ---- hashSource ----
const h1 = hashSource('hello world');
const h2 = hashSource('hello world');
const h3 = hashSource('hello world!');
log('hashSource: deterministic', h1 === h2);
log('hashSource: different input → different hash', h1 !== h3);
log('hashSource: truncated to 16 hex chars', h1.length === 16);

// ---- resolveEntryPath ----
log(
  'resolveEntryPath: relative path inside dir → absolute path',
  resolveEntryPath('renderer.tsx', manifestDir) === entryFile,
);
log(
  'resolveEntryPath: throws on absolute path',
  throws(() => resolveEntryPath('/etc/passwd', manifestDir), 'absolute'),
);
log(
  'resolveEntryPath: throws on .. traversal',
  throws(() => resolveEntryPath('../evil.tsx', manifestDir), '..'),
);
log(
  'resolveEntryPath: throws on missing file',
  throws(() => resolveEntryPath('ghost.tsx', manifestDir), 'does not exist'),
);

// ---- bundleRenderer happy path ----
clearBundleIndexForTests();
const outDir = join(tmp, 'renderers-out');
const result = await bundleRenderer({
  slug: 'demo',
  entryPath: entryFile,
  outputShape: 'table',
  outputDir: outDir,
});
log('bundleRenderer: returns slug', result.slug === 'demo');
log('bundleRenderer: writes bundle file', existsSync(result.bundlePath));
log('bundleRenderer: bundle under size cap', result.bytes < MAX_BUNDLE_BYTES);
log('bundleRenderer: outputShape propagated', result.outputShape === 'table');
log('bundleRenderer: sourceHash set', result.sourceHash.length === 16);
const sidecarHash = readFileSync(`${result.bundlePath}.hash`, 'utf-8');
const sidecarShape = readFileSync(`${result.bundlePath}.shape`, 'utf-8');
log('bundleRenderer: writes .hash sidecar', sidecarHash === result.sourceHash);
log('bundleRenderer: writes .shape sidecar', sidecarShape === 'table');

// Bundle content smoke: must mention React.createElement (or a minified
// form). esbuild --minify renames but the className value is preserved.
const bundleBody = readFileSync(result.bundlePath, 'utf-8');
log('bundleRenderer: bundle references demo className', bundleBody.includes('demo'));
log(
  'bundleRenderer: bundle banner present',
  bundleBody.startsWith('// Floom custom renderer bundle'),
);
// Sandbox mode (sec/renderer-sandbox): react + react-dom are bundled INTO
// the output, so the raw string "react" appears in the minified body (as
// an internal name/comment). The old contract kept react external; the new
// contract requires it inlined so each iframe runs self-contained.
log(
  'bundleRenderer: react bundled into output (sandbox mode)',
  bundleBody.includes('react'),
);
log(
  'bundleRenderer: wrapper posts ready signal',
  bundleBody.includes('ready'),
);
log(
  'bundleRenderer: wrapper installs postMessage listener',
  bundleBody.includes('postMessage'),
);

// ---- bundleRenderer idempotent ----
const result2 = await bundleRenderer({
  slug: 'demo',
  entryPath: entryFile,
  outputShape: 'table',
  outputDir: outDir,
});
log('bundleRenderer: idempotent same hash', result2.sourceHash === result.sourceHash);

// ---- bundleRenderer rebuilds on changed source ----
writeFileSync(
  entryFile,
  `import React from 'react';
export default function Demo({ data }) {
  return React.createElement('span', { className: 'demo-v2' }, String(data));
}
`,
);
const result3 = await bundleRenderer({
  slug: 'demo',
  entryPath: entryFile,
  outputShape: 'table',
  outputDir: outDir,
});
log('bundleRenderer: rebuilds on changed source', result3.sourceHash !== result.sourceHash);
const bundleV2 = readFileSync(result3.bundlePath, 'utf-8');
log('bundleRenderer: new bundle has v2 marker', bundleV2.includes('demo-v2'));

// ---- bundleRenderer: getBundleResult returns cached value ----
const cached = getBundleResult('demo');
log('getBundleResult: returns index entry', cached && cached.sourceHash === result3.sourceHash);

// ---- bundleRendererFromManifest: happy path ----
clearBundleIndexForTests();
const fromManifestResult = await bundleRendererFromManifest(
  'demo2',
  manifestDir,
  'renderer.tsx',
  'table',
);
log(
  'bundleRendererFromManifest: returns result on success',
  fromManifestResult && fromManifestResult.slug === 'demo2',
);

// ---- bundleRendererFromManifest: returns null on failure (bad entry) ----
const fromManifestFail = await bundleRendererFromManifest(
  'demo3',
  manifestDir,
  'missing.tsx',
);
log('bundleRendererFromManifest: returns null on error', fromManifestFail === null);

// ---- bundleRenderer: too-large bundle is rejected ----
// Write a huge source file (~300 KB of React element strings) so esbuild
// produces more than MAX_BUNDLE_BYTES (256 KB).
const huge = join(manifestDir, 'huge.tsx');
const hugeLines = [];
hugeLines.push(`import React from 'react';`);
hugeLines.push(`export default function Huge() { return React.createElement('div', null,`);
for (let i = 0; i < 8000; i++) {
  hugeLines.push(`  'line_number_${i}_with_some_filler_text_to_grow_the_bundle',`);
}
hugeLines.push(`); }`);
writeFileSync(huge, hugeLines.join('\n'));
log(
  'bundleRenderer: throws when bundle exceeds MAX_BUNDLE_BYTES',
  await throwsAsync(
    () =>
      bundleRenderer({
        slug: 'huge',
        entryPath: huge,
        outputShape: 'text',
        outputDir: outDir,
      }),
    'exceeds cap',
  ),
);

// ---- B7: getReactNodePaths resolves react AND react-dom -------------------
// Regression: pnpm's virtual store gives each package its own isolated
// node_modules parent, so only adding react's parent would leave imports
// like `react-dom/client` unresolvable at bundle time.
import { createRequire } from 'node:module';
import { existsSync as existsSyncCheck } from 'node:fs';
const nodePaths = getReactNodePaths();
log('getReactNodePaths: returns an array', Array.isArray(nodePaths));
log('getReactNodePaths: returns at least one path', nodePaths.length > 0);
log(
  'getReactNodePaths: every returned path exists on disk',
  nodePaths.every((p) => existsSyncCheck(p)),
);
// Sanity: the paths must actually be usable by `require.resolve` to find
// BOTH react and react-dom/client. This is the exact contract esbuild
// needs — if this fails, the bundler will throw "Could not resolve".
const nodeReq = createRequire(import.meta.url);
let foundReact = false;
let foundReactDomClient = false;
for (const p of nodePaths) {
  try {
    nodeReq.resolve('react', { paths: [p] });
    foundReact = true;
  } catch {
    // ignore — not all paths contain every package
  }
  try {
    nodeReq.resolve('react-dom/client', { paths: [p] });
    foundReactDomClient = true;
  } catch {
    // ignore
  }
}
log(
  'getReactNodePaths: at least one path resolves `react`',
  foundReact,
  JSON.stringify(nodePaths),
);
log(
  'getReactNodePaths: at least one path resolves `react-dom/client`',
  foundReactDomClient,
  JSON.stringify(nodePaths),
);
// Dedup check: set-like behaviour means no duplicate entries.
log(
  'getReactNodePaths: no duplicate entries',
  new Set(nodePaths).size === nodePaths.length,
);

// B7 smoke: end-to-end bundle with `react-dom/client` import must succeed
// (this was the reported failure — esbuild throwing "Could not resolve
// 'react-dom/client'" because the creator's bundle imports it via the
// wrapper and react-dom wasn't reachable from the nodePaths list).
clearBundleIndexForTests();
const b7Dir = join(tmp, 'b7-fixture');
mkdirSync(b7Dir, { recursive: true });
const b7Entry = join(b7Dir, 'renderer.tsx');
writeFileSync(
  b7Entry,
  `import React from 'react';
// Touch react-dom/client directly in user code (wrapper also imports it;
// this guarantees esbuild has to resolve it from the creator's source,
// not only from our stdin-injected wrapper).
import 'react-dom/client';
export default function B7Demo() {
  return React.createElement('div', { 'data-marker': 'b7-marker' }, 'b7');
}
`,
);
let b7Err = null;
let b7Result;
try {
  b7Result = await bundleRenderer({
    slug: 'b7-renderer-smoke',
    entryPath: b7Entry,
    outputShape: 'text',
    outputDir: outDir,
  });
} catch (err) {
  b7Err = err;
}
log(
  'B7 smoke: bundle with react-dom/client import compiles without error',
  b7Err === null,
  b7Err ? String(b7Err.message) : undefined,
);
log(
  'B7 smoke: bundle file written',
  b7Result && existsSync(b7Result.bundlePath),
);
const b7Body = b7Result ? readFileSync(b7Result.bundlePath, 'utf-8') : '';
log(
  'B7 smoke: bundle does not include "Could not resolve" error text',
  !b7Body.includes('Could not resolve'),
);
log(
  'B7 smoke: bundle contains creator marker',
  b7Body.includes('b7-marker'),
);

// Cleanup
rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
