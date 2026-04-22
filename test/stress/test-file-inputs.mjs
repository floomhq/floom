#!/usr/bin/env node
// File input pipeline tests.
//
// Scope: the `file` InputType introduced to fix the silent-drop bug
// where Docker apps received `{}` instead of the file contents.
// Coverage:
//   1. Client serializer (apps/web/src/api/serialize-inputs.ts) walks
//      File objects into the shared FileEnvelope shape. Nested arrays
//      + plain objects recurse; oversize files throw with a keyed path.
//   2. Server validator (manifest.ts `validateInputs`) accepts the
//      envelope for `type: 'file'` and rejects malformed shapes.
//   3. Server materializer (lib/file-inputs.ts materializeFileInputs)
//      writes envelopes to a tmp dir, rewrites input values to
//      `/floom/inputs/<name>.<ext>`, and cleanup removes the dir.
//
// These tests are pure-Node (no docker), so they run in CI. The
// full docker round-trip lives in test-file-inputs-docker.mjs.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateInputs, ManifestError } from '../../apps/server/src/services/manifest.ts';
import {
  materializeFileInputs,
  isFileEnvelope,
  assertFileEnvelope,
  decodeEnvelope,
  FileEnvelopeError,
  CONTAINER_INPUTS_DIR,
  SERVER_MAX_FILE_BYTES,
} from '../../apps/server/src/lib/file-inputs.ts';
import {
  serializeInputs,
  DEFAULT_MAX_FILE_BYTES,
  FileInputTooLargeError,
} from '../../apps/web/src/api/serialize-inputs.ts';

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

// -------------------------------------------------------------
// 1. Client serializer
// -------------------------------------------------------------
console.log('client serializeInputs');

// Node 20+ has File via the `node:buffer` re-export. Use the global.
const hello = new File([new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])], 'hello.txt', {
  type: 'text/plain',
});

{
  const out = await serializeInputs({ prompt: 'hi', data: hello });
  log('non-file primitive passes through', out.prompt === 'hi');
  log('File → envelope', out.data?.__file === true);
  log('envelope name preserved', out.data?.name === 'hello.txt');
  log('envelope mime preserved', out.data?.mime_type === 'text/plain');
  log('envelope size matches', out.data?.size === 5);
  // base64('hello') = 'aGVsbG8='
  log('envelope content_b64 decodes correctly', out.data?.content_b64 === 'aGVsbG8=');
}

// Nested inputs: arrays + plain objects should recurse.
{
  const out = await serializeInputs({
    meta: { author: 'f', attachments: [hello] },
  });
  log(
    'nested array File → envelope',
    out.meta?.attachments?.[0]?.__file === true,
  );
}

// Size cap should throw before base64-encoding.
{
  const big = new File([new Uint8Array(DEFAULT_MAX_FILE_BYTES + 1)], 'big.bin');
  try {
    await serializeInputs({ data: big });
    log('oversize file rejected', false, 'did not throw');
  } catch (err) {
    log(
      'oversize file rejected',
      err instanceof FileInputTooLargeError && err.path === 'inputs.data',
      err?.message,
    );
  }
}

// -------------------------------------------------------------
// 2. Server validator
// -------------------------------------------------------------
console.log('server validateInputs for type: file');

const envelope = {
  __file: true,
  name: 'data.csv',
  mime_type: 'text/csv',
  size: 5,
  content_b64: 'aGVsbG8=',
};

const fileAction = {
  name: 'run',
  label: 'Run',
  inputs: [{ name: 'data', type: 'file', required: true }],
  outputs: [],
};

{
  const cleaned = validateInputs(fileAction, { data: envelope });
  log('envelope accepted', cleaned.data?.__file === true);
  log('envelope mime preserved', cleaned.data?.mime_type === 'text/csv');
}

{
  // Path strings are accepted so a replayed run record doesn't trip.
  const cleaned = validateInputs(fileAction, { data: '/floom/inputs/data.csv' });
  log('path string accepted', cleaned.data === '/floom/inputs/data.csv');
}

{
  // Non-object, non-string should be rejected with ManifestError.
  try {
    validateInputs(fileAction, { data: 42 });
    log('number rejected', false, 'did not throw');
  } catch (err) {
    log('number rejected', err instanceof ManifestError);
  }
}

{
  // Missing __file discriminator should be rejected via asserter.
  try {
    validateInputs(fileAction, { data: { name: 'x.csv', content_b64: 'aA==' } });
    log('missing __file rejected', false, 'did not throw');
  } catch (err) {
    log('missing __file rejected', err instanceof ManifestError);
  }
}

// -------------------------------------------------------------
// 3. Server materializer
// -------------------------------------------------------------
console.log('server materializeFileInputs');

{
  // No envelopes → zero-overhead no-op.
  const r = materializeFileInputs('run-empty', { foo: 'bar' });
  log('no envelopes: hostDir empty', r.hostDir === '');
  log('no envelopes: mountSource empty', r.mountSource === '');
  log('no envelopes: inputs unchanged', r.inputs.foo === 'bar');
  r.cleanup(); // safe no-op
}

{
  // Single envelope at top level.
  const r = materializeFileInputs('run-1', { data: envelope });
  log('envelope: hostDir populated', r.hostDir.length > 0 && existsSync(r.hostDir));
  log('envelope: mountSource defaults to hostDir', r.mountSource === r.hostDir);
  log(
    'envelope: input rewritten to container path',
    typeof r.inputs.data === 'string' &&
      r.inputs.data.startsWith(CONTAINER_INPUTS_DIR + '/data'),
  );
  // File content should exactly equal decoded bytes.
  const hostFile = r.hostDir + '/' + r.inputs.data.slice(CONTAINER_INPUTS_DIR.length + 1);
  const bytes = readFileSync(hostFile);
  log('envelope: file content matches decoded bytes', bytes.toString('utf8') === 'hello');
  // Cleanup removes the dir.
  r.cleanup();
  log('envelope: cleanup removes hostDir', !existsSync(r.hostDir));
  // Cleanup is idempotent.
  r.cleanup();
  log('envelope: cleanup is idempotent', true);
}

{
  // Nested envelopes: one top-level, one in an array. Basenames must
  // not collide.
  const r = materializeFileInputs('run-2', {
    primary: envelope,
    attachments: [envelope, envelope],
  });
  log('nested: primary rewritten', typeof r.inputs.primary === 'string');
  log('nested: array entries rewritten',
    Array.isArray(r.inputs.attachments) &&
      r.inputs.attachments.every((v) => typeof v === 'string'));
  // Unique basenames (de-dup suffix kicks in for collisions).
  const uniq = new Set([r.inputs.primary, ...r.inputs.attachments]);
  log('nested: basenames are unique', uniq.size === 3);
  r.cleanup();
}

{
  // Extension inference: unknown MIME falls back to .bin, known MIME
  // to the mapped extension when filename has no ext.
  const pdfEnvelope = {
    __file: true,
    name: 'report',
    mime_type: 'application/pdf',
    size: 4,
    content_b64: 'JVBERg==', // '%PDF' header bytes
  };
  const r = materializeFileInputs('run-3', { doc: pdfEnvelope });
  log('mime→ext: pdf envelope picks .pdf',
    typeof r.inputs.doc === 'string' && r.inputs.doc.endsWith('.pdf'));
  r.cleanup();
}

{
  // Containerized-server mode: write into a bind-mounted container path
  // but tell Docker to mount the host-side mirror of that directory.
  const prevDir = process.env.FLOOM_FILE_INPUTS_DIR;
  const prevHostDir = process.env.FLOOM_FILE_INPUTS_HOST_DIR;
  const containerRoot = mkdtempSync(join(tmpdir(), 'floom-file-inputs-container-'));
  process.env.FLOOM_FILE_INPUTS_DIR = containerRoot;
  process.env.FLOOM_FILE_INPUTS_HOST_DIR = '/opt/floom-preview-file-inputs';
  try {
    const r = materializeFileInputs('run-shared', { data: envelope });
    log(
      'shared-root: hostDir uses FLOOM_FILE_INPUTS_DIR',
      r.hostDir === join(containerRoot, 'floom-run-shared'),
      r.hostDir,
    );
    log(
      'shared-root: mountSource uses FLOOM_FILE_INPUTS_HOST_DIR',
      r.mountSource === '/opt/floom-preview-file-inputs/floom-run-shared',
      r.mountSource,
    );
    const hostFile = r.hostDir + '/' + r.inputs.data.slice(CONTAINER_INPUTS_DIR.length + 1);
    log('shared-root: file materialized under container-visible dir', existsSync(hostFile), hostFile);
    r.cleanup();
    log('shared-root: cleanup removes container-visible dir', !existsSync(r.hostDir));
  } finally {
    if (prevDir === undefined) delete process.env.FLOOM_FILE_INPUTS_DIR;
    else process.env.FLOOM_FILE_INPUTS_DIR = prevDir;
    if (prevHostDir === undefined) delete process.env.FLOOM_FILE_INPUTS_HOST_DIR;
    else process.env.FLOOM_FILE_INPUTS_HOST_DIR = prevHostDir;
  }
}

// -------------------------------------------------------------
// 4. Envelope decoder (server cap)
// -------------------------------------------------------------
console.log('server decodeEnvelope');

{
  const buf = decodeEnvelope('data', envelope);
  log('decode returns buffer', Buffer.isBuffer(buf) && buf.toString('utf8') === 'hello');
}

{
  // A near-limit decoded buffer should still pass under the server cap.
  // This exercises the "client cap + slack" invariant.
  const bigEnv = {
    __file: true,
    name: 'big.bin',
    mime_type: 'application/octet-stream',
    size: DEFAULT_MAX_FILE_BYTES,
    content_b64: Buffer.alloc(DEFAULT_MAX_FILE_BYTES).toString('base64'),
  };
  try {
    const buf = decodeEnvelope('data', bigEnv);
    log('at-client-cap envelope accepted by server', buf.length === DEFAULT_MAX_FILE_BYTES);
  } catch (err) {
    log('at-client-cap envelope accepted by server', false, err?.message);
  }
}

{
  // A file above the server cap should be rejected.
  const overEnv = {
    __file: true,
    name: 'over.bin',
    mime_type: 'application/octet-stream',
    size: SERVER_MAX_FILE_BYTES + 1,
    content_b64: Buffer.alloc(SERVER_MAX_FILE_BYTES + 1).toString('base64'),
  };
  try {
    decodeEnvelope('data', overEnv);
    log('over-server-cap envelope rejected', false, 'did not throw');
  } catch (err) {
    log('over-server-cap envelope rejected', err instanceof FileEnvelopeError);
  }
}

// -------------------------------------------------------------
// Summary
// -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
