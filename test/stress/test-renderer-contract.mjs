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
  pickInputShape,
  resolveAppShape,
  INPUT_SHAPES,
  APP_SHAPES,
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

// ---- parseRendererManifest: new v15.3 fields (input_shape + shape) ----
log(
  'parseRendererManifest: input_shape propagates',
  parseRendererManifest({ kind: 'default', input_shape: 'csv' }).input_shape === 'csv',
);
log(
  'parseRendererManifest: throws on bad input_shape',
  throws(
    () => parseRendererManifest({ kind: 'default', input_shape: 'gif' }),
    'input_shape',
  ),
);
log(
  'parseRendererManifest: shape: prompt propagates',
  parseRendererManifest({ kind: 'default', shape: 'prompt' }).shape === 'prompt',
);
log(
  'parseRendererManifest: shape: form propagates',
  parseRendererManifest({ kind: 'default', shape: 'form' }).shape === 'form',
);
log(
  'parseRendererManifest: shape: auto propagates',
  parseRendererManifest({ kind: 'default', shape: 'auto' }).shape === 'auto',
);
log(
  'parseRendererManifest: throws on bad shape',
  throws(
    () => parseRendererManifest({ kind: 'default', shape: 'whatever' }),
    'shape',
  ),
);

// ---- INPUT_SHAPES + APP_SHAPES constants ----
log(
  'INPUT_SHAPES: 14 entries, all strings',
  INPUT_SHAPES.length === 14 && INPUT_SHAPES.every((s) => typeof s === 'string'),
);
log(
  'APP_SHAPES: prompt, form, auto',
  APP_SHAPES.length === 3 &&
    APP_SHAPES.includes('prompt') &&
    APP_SHAPES.includes('form') &&
    APP_SHAPES.includes('auto'),
);

// ---- pickInputShape ----
log('pickInputShape: undefined → text', pickInputShape(undefined) === 'text');
log('pickInputShape: null → text', pickInputShape(null) === 'text');
log('pickInputShape: empty → text', pickInputShape({}) === 'text');

log(
  'pickInputShape: x-floom-input-shape wins',
  pickInputShape({ type: 'string', 'x-floom-input-shape': 'csv' }) === 'csv',
);
log(
  'pickInputShape: x-floom-input-shape invalid falls through',
  pickInputShape({ type: 'string', 'x-floom-input-shape': 'gif' }) === 'text',
);

// file family (binary)
log(
  'pickInputShape: string+binary+text/csv → csv',
  pickInputShape({ type: 'string', format: 'binary', contentMediaType: 'text/csv' }) === 'csv',
);
log(
  'pickInputShape: string+binary+image/png → image',
  pickInputShape({ type: 'string', format: 'binary', contentMediaType: 'image/png' }) === 'image',
);
log(
  'pickInputShape: string+binary generic → file',
  pickInputShape({ type: 'string', format: 'binary', contentMediaType: 'application/pdf' }) === 'file',
);
log(
  'pickInputShape: string+binary no contentType → file',
  pickInputShape({ type: 'string', format: 'binary' }) === 'file',
);

// multifile
log(
  'pickInputShape: array of binary → multifile',
  pickInputShape({
    type: 'array',
    items: { type: 'string', format: 'binary' },
  }) === 'multifile',
);
log(
  'pickInputShape: array of images → image (per-item detection)',
  pickInputShape({
    type: 'array',
    items: { type: 'string', format: 'binary', contentMediaType: 'image/png' },
  }) === 'image',
);
log(
  'pickInputShape: array of CSVs → csv (per-item detection)',
  pickInputShape({
    type: 'array',
    items: { type: 'string', format: 'binary', contentMediaType: 'text/csv' },
  }) === 'csv',
);

// date / datetime / url
log(
  'pickInputShape: string+format:date → date',
  pickInputShape({ type: 'string', format: 'date' }) === 'date',
);
log(
  'pickInputShape: string+format:date-time → datetime',
  pickInputShape({ type: 'string', format: 'date-time' }) === 'datetime',
);
log(
  'pickInputShape: string+format:uri → url',
  pickInputShape({ type: 'string', format: 'uri' }) === 'url',
);
log(
  'pickInputShape: string+format:url → url (alias)',
  pickInputShape({ type: 'string', format: 'url' }) === 'url',
);

// enum / json / code / textarea / text
log(
  'pickInputShape: string+enum → enum',
  pickInputShape({ type: 'string', enum: ['A4', 'Letter'] }) === 'enum',
);
log(
  'pickInputShape: string+empty enum → text',
  pickInputShape({ type: 'string', enum: [] }) === 'text',
);
log(
  'pickInputShape: string+contentMediaType application/json → json',
  pickInputShape({ type: 'string', contentMediaType: 'application/json' }) === 'json',
);
log(
  'pickInputShape: string+x-floom-language → code',
  pickInputShape({ type: 'string', 'x-floom-language': 'python' }) === 'code',
);
log(
  'pickInputShape: string+x-floom-multiline → textarea',
  pickInputShape({ type: 'string', 'x-floom-multiline': true }) === 'textarea',
);
log(
  'pickInputShape: string+maxLength > 200 → textarea',
  pickInputShape({ type: 'string', maxLength: 500 }) === 'textarea',
);
log(
  'pickInputShape: string+maxLength <= 200 → text',
  pickInputShape({ type: 'string', maxLength: 80 }) === 'text',
);
log(
  'pickInputShape: bare string → text',
  pickInputShape({ type: 'string' }) === 'text',
);

// number / boolean
log(
  'pickInputShape: number → number',
  pickInputShape({ type: 'number' }) === 'number',
);
log(
  'pickInputShape: integer → number',
  pickInputShape({ type: 'integer' }) === 'number',
);
log(
  'pickInputShape: boolean → boolean',
  pickInputShape({ type: 'boolean' }) === 'boolean',
);

// precedence: explicit ext beats derivation
log(
  'pickInputShape: x-floom-input-shape beats binary',
  pickInputShape({
    type: 'string',
    format: 'binary',
    contentMediaType: 'text/csv',
    'x-floom-input-shape': 'file',
  }) === 'file',
);

// resolveAppShape
log(
  'resolveAppShape: explicit prompt → prompt',
  resolveAppShape('prompt', ['file']) === 'prompt',
);
log(
  'resolveAppShape: explicit form → form',
  resolveAppShape('form', ['textarea']) === 'form',
);
log(
  'resolveAppShape: auto + 1 textarea → prompt',
  resolveAppShape('auto', ['textarea']) === 'prompt',
);
log(
  'resolveAppShape: auto + 1 text → prompt',
  resolveAppShape('auto', ['text']) === 'prompt',
);
log(
  'resolveAppShape: auto + 1 file → form',
  resolveAppShape('auto', ['file']) === 'form',
);
log(
  'resolveAppShape: auto + 0 inputs → form',
  resolveAppShape('auto', []) === 'form',
);
log(
  'resolveAppShape: auto + multiple inputs → form',
  resolveAppShape('auto', ['textarea', 'enum']) === 'form',
);
log(
  'resolveAppShape: undefined (nullish) → auto behavior',
  resolveAppShape(undefined, ['textarea']) === 'prompt',
);
log(
  'resolveAppShape: null → auto behavior',
  resolveAppShape(null, ['file']) === 'form',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
