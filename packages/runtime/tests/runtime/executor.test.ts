/**
 * Unit tests for executor.buildRunCommand (no sandbox, pure logic).
 *
 * The executor's real behaviour is tested end-to-end by the Suite H rerun
 * and the OpenDraft e2e test. This covers the input-to-shell wiring in
 * isolation so we catch quoting bugs fast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunCommand, __test } from '../../src/runtime/executor.ts';
import type { Manifest } from '../../src/runtime/types.ts';

const base: Manifest = {
  name: 'demo',
  displayName: 'Demo',
  description: 'test',
  creator: 'test',
  runtime: 'python3.12',
  run: 'python app.py',
  inputs: [
    { name: 'topic', type: 'string', required: true },
  ],
  outputs: { type: 'stdout' },
};

test('buildRunCommand: argv input is appended as --name value', () => {
  const { cmd, envs, stdin } = buildRunCommand(base, { topic: 'floom' });
  assert.equal(cmd, "python app.py --topic 'floom'");
  assert.deepEqual(envs, {});
  assert.equal(stdin, undefined);
});

test('buildRunCommand: inputs escape single quotes', () => {
  const { cmd } = buildRunCommand(base, { topic: "it's fine" });
  assert.match(cmd, /--topic 'it'\\''s fine'/);
});

test('buildRunCommand: env input flows into envs, not argv', () => {
  const manifest: Manifest = {
    ...base,
    inputs: [{ name: 'api_key', type: 'string', required: true, from: 'env' }],
  };
  const { cmd, envs } = buildRunCommand(manifest, { api_key: 'sk-abc' });
  assert.equal(cmd, 'python app.py');
  assert.deepEqual(envs, { API_KEY: 'sk-abc' });
});

test('buildRunCommand: stdin input returns stdin string', () => {
  const manifest: Manifest = {
    ...base,
    inputs: [{ name: 'payload', type: 'string', required: true, from: 'stdin' }],
  };
  const { cmd, stdin } = buildRunCommand(manifest, { payload: 'hello world' });
  assert.equal(cmd, 'python app.py');
  assert.equal(stdin, 'hello world');
});

test('buildRunCommand: workdir prefix applied', () => {
  const manifest: Manifest = { ...base, workdir: 'apps/backend' };
  const { cmd } = buildRunCommand(manifest, { topic: 'x' });
  assert.equal(cmd, "cd apps/backend && python app.py --topic 'x'");
});

test('buildRunCommand: default used when input missing', () => {
  const manifest: Manifest = {
    ...base,
    inputs: [{ name: 'topic', type: 'string', required: false, default: 'fallback' }],
  };
  const { cmd } = buildRunCommand(manifest, {});
  assert.match(cmd, /--topic 'fallback'/);
});

test('buildRunCommand: missing required input throws', () => {
  assert.throws(() => buildRunCommand(base, {}), /Missing required input: topic/);
});

test('parseTimeout: accepts s, m, ms, h, raw ms', () => {
  assert.equal(__test.parseTimeout('60s'), 60_000);
  assert.equal(__test.parseTimeout('2m'), 120_000);
  assert.equal(__test.parseTimeout('500ms'), 500);
  assert.equal(__test.parseTimeout('1h'), 3_600_000);
  assert.equal(__test.parseTimeout('5000'), 5000);
  assert.equal(__test.parseTimeout(undefined), 60_000);
});
