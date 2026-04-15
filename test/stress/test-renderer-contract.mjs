#!/usr/bin/env node
// Renderer contract unit tests — pure TS, no React rendering.
//
// Covers:
//   1. parseRendererManifest: null, component happy path, missing entry,
//      absolute path, traversal, bad kind, bad output_shape
//   2. pickOutputShape: schema discriminator precedence rules
//   3. resolveRenderTarget: state machine transitions
//
// Run via the server's npm test (which uses tsx so .ts imports work). Never
// touches the DB or the filesystem.

import {
  parseRendererManifest,
  pickOutputShape,
} from '../../packages/renderer/src/contract/index.ts';
import { resolveRenderTarget } from '../../packages/renderer/src/RendererShell.tsx';

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

console.log('renderer contract tests');

// ---- parseRendererManifest ----
log(
  'parseRendererManifest: null → default',
  parseRendererManifest(null).kind === 'default',
);
log(
  'parseRendererManifest: undefined → default',
  parseRendererManifest(undefined).kind === 'default',
);
log(
  'parseRendererManifest: {kind: default} → default',
  parseRendererManifest({ kind: 'default' }).kind === 'default',
);
const c1 = parseRendererManifest({ kind: 'component', entry: './renderer.tsx' });
log(
  'parseRendererManifest: component w/ entry → kind + entry set',
  c1.kind === 'component' && c1.entry === './renderer.tsx',
);
const c2 = parseRendererManifest({
  kind: 'component',
  entry: './renderer.tsx',
  output_shape: 'table',
});
log(
  'parseRendererManifest: output_shape propagates',
  c2.output_shape === 'table',
);
log(
  'parseRendererManifest: throws on missing entry',
  throws(() => parseRendererManifest({ kind: 'component' }), 'entry'),
);
log(
  'parseRendererManifest: throws on absolute path',
  throws(() => parseRendererManifest({ kind: 'component', entry: '/etc/passwd' }), 'relative'),
);
log(
  'parseRendererManifest: throws on .. traversal',
  throws(() => parseRendererManifest({ kind: 'component', entry: '../evil.tsx' }), '..'),
);
log(
  'parseRendererManifest: throws on unknown kind',
  throws(() => parseRendererManifest({ kind: 'spooky' }), 'kind'),
);
log(
  'parseRendererManifest: throws on bad output_shape',
  throws(
    () => parseRendererManifest({ kind: 'default', output_shape: 'gif' }),
    'output_shape',
  ),
);
log(
  'parseRendererManifest: throws on non-object input',
  throws(() => parseRendererManifest('oops'), 'object'),
);

// ---- pickOutputShape ----
log('pickOutputShape: undefined → text', pickOutputShape(undefined) === 'text');
log('pickOutputShape: null → text', pickOutputShape(null) === 'text');
log('pickOutputShape: empty → text', pickOutputShape({}) === 'text');
log(
  'pickOutputShape: x-floom-output-shape wins',
  pickOutputShape({ type: 'object', 'x-floom-output-shape': 'code' }) === 'code',
);
log(
  'pickOutputShape: x-floom-output-shape invalid → falls through',
  pickOutputShape({ type: 'object', 'x-floom-output-shape': 'gif' }) === 'object',
);
log(
  'pickOutputShape: text/event-stream → stream',
  pickOutputShape({ contentType: 'text/event-stream' }) === 'stream',
);
log(
  'pickOutputShape: application/x-ndjson → stream',
  pickOutputShape({ contentType: 'application/x-ndjson' }) === 'stream',
);
log(
  'pickOutputShape: image/png → image',
  pickOutputShape({ contentType: 'image/png' }) === 'image',
);
log(
  'pickOutputShape: application/pdf → pdf',
  pickOutputShape({ contentType: 'application/pdf' }) === 'pdf',
);
log(
  'pickOutputShape: audio/mpeg → audio',
  pickOutputShape({ contentType: 'audio/mpeg' }) === 'audio',
);
log(
  'pickOutputShape: text/markdown → markdown',
  pickOutputShape({ contentType: 'text/markdown' }) === 'markdown',
);
log(
  'pickOutputShape: array of objects → table',
  pickOutputShape({ type: 'array', items: { type: 'object' } }) === 'table',
);
log(
  'pickOutputShape: array of primitives → table',
  pickOutputShape({ type: 'array' }) === 'table',
);
log(
  'pickOutputShape: type object → object',
  pickOutputShape({ type: 'object' }) === 'object',
);
log(
  'pickOutputShape: string + format markdown → markdown',
  pickOutputShape({ type: 'string', format: 'markdown' }) === 'markdown',
);
log(
  'pickOutputShape: string + x-floom-language → code',
  pickOutputShape({ type: 'string', 'x-floom-language': 'python' }) === 'code',
);
log(
  'pickOutputShape: string plain → text',
  pickOutputShape({ type: 'string' }) === 'text',
);

// ---- resolveRenderTarget ----
const r1 = resolveRenderTarget('input-available', 'table', false);
log(
  'resolveRenderTarget: input-available → default table loading',
  r1.component === 'default' && r1.shape === 'table' && r1.loading === true,
);
const r2 = resolveRenderTarget('output-error', 'table', false);
log(
  'resolveRenderTarget: output-error → default error',
  r2.component === 'default' && r2.shape === 'error',
);
const r3 = resolveRenderTarget('output-available', 'table', false);
log(
  'resolveRenderTarget: output-available no custom → default',
  r3.component === 'default' && r3.shape === 'table' && r3.loading === false,
);
const r4 = resolveRenderTarget('output-available', 'table', true);
log(
  'resolveRenderTarget: output-available w/ custom → custom',
  r4.component === 'custom' && r4.shape === 'table',
);
const r5 = resolveRenderTarget('output-error', 'table', true);
log(
  'resolveRenderTarget: output-error even w/ custom → default error (custom never gets error)',
  r5.component === 'default' && r5.shape === 'error',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
