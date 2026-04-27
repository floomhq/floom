#!/usr/bin/env node
// Contract tests for the SecretsAdapter.
//
// These tests define executable conformance checks for the local encrypted
// vault and creator-override loader. They always exit 0 so direct
// documentation runs and CI smoke jobs can print the complete tally; the
// conformance runner parses the tally and returns a failing status when any
// assertion fails.
//
// Run: tsx test/stress/test-adapters-secrets-contract.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-secrets-contract-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);

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
const selectedSecretsAdapter =
  process.env.FLOOM_CONFORMANCE_ADAPTER || process.env.FLOOM_SECRETS || 'local';

const { db, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID } = await import(
  '../../apps/server/src/db.ts'
);
const { adapters } = await import('../../apps/server/src/adapters/index.ts');
const creatorSecrets = await import(
  '../../apps/server/src/services/app_creator_secrets.ts'
);
const secrets = adapters.secrets;
const setCreatorOverrideForTests =
  typeof secrets.__setCreatorOverrideForTests === 'function'
    ? secrets.__setCreatorOverrideForTests.bind(secrets)
    : null;

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

const ctx = {
  workspace_id: DEFAULT_WORKSPACE_ID,
  user_id: DEFAULT_USER_ID,
  device_id: 'secrets-contract-device',
  is_authenticated: false,
};

const tenantCtx = {
  workspace_id: 'secrets-tenant-b',
  user_id: DEFAULT_USER_ID,
  device_id: 'secrets-contract-device-b',
  is_authenticated: false,
};

function createApp(id) {
  db.prepare(
    `INSERT INTO apps (id, slug, name, description, manifest, code_path, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    `Contract ${id}`,
    'Secrets contract fixture',
    JSON.stringify({
      name: id,
      description: 'Secrets contract fixture',
      actions: { run: { label: 'Run', inputs: [], outputs: [] } },
      runtime: 'python',
      python_dependencies: [],
      node_dependencies: {},
      secrets_needed: ['CREATOR_ONLY', 'USER_ONLY', 'NO_FALLBACK'],
      manifest_version: '1.0',
    }),
    '/tmp/secrets-contract',
    DEFAULT_WORKSPACE_ID,
  );
}

console.log('adapter-secrets contract tests');

try {
  db.prepare(
    `INSERT INTO workspaces (id, slug, name, plan) VALUES (?, ?, ?, 'team')`,
  ).run(tenantCtx.workspace_id, tenantCtx.workspace_id, 'Secrets Tenant B');
  createApp('secrets-contract-app');

  await check('set/get/delete round-trip', async () => {
    await secrets.set(ctx, 'ROUND_TRIP_KEY', 'round-trip-value');
    assert(await secrets.get(ctx, 'ROUND_TRIP_KEY') === 'round-trip-value', 'get did not return plaintext');
    assert(await secrets.delete(ctx, 'ROUND_TRIP_KEY') === true, 'delete existing returned false');
    assert(await secrets.get(ctx, 'ROUND_TRIP_KEY') === null, 'deleted key remained readable');
  });

  await check('list masks plaintext and ciphertext', async () => {
    await secrets.set(ctx, 'MASKED_KEY', 'masked-super-secret');
    const list = await secrets.list(ctx);
    const row = list.find((item) => item.key === 'MASKED_KEY');
    assert(row, `list=${JSON.stringify(list)}`);
    assert(typeof row.updated_at === 'string' && row.updated_at.length > 0, 'updated_at missing');
    assert(!('value' in row), 'list exposed value');
    assert(!('ciphertext' in row), 'list exposed ciphertext');
    assert(!JSON.stringify(row).includes('masked-super-secret'), 'list leaked plaintext');
  });

  await check('loadUserVaultForRun filters by requested keys', async () => {
    await secrets.set(ctx, 'KEY_A', 'value-a');
    await secrets.set(ctx, 'KEY_B', 'value-b');
    await secrets.set(ctx, 'KEY_C', 'value-c');
    const loaded = await secrets.loadUserVaultForRun(ctx, ['KEY_A']);
    assert(JSON.stringify(Object.keys(loaded).sort()) === JSON.stringify(['KEY_A']), `keys=${JSON.stringify(loaded)}`);
    assert(loaded.KEY_A === 'value-a', `KEY_A=${loaded.KEY_A}`);
  });

  await check('creator-override namespace is isolated from user vault', async () => {
    await secrets.set(ctx, 'USER_ONLY', 'user-only-value');
    await secrets.set(ctx, 'NO_FALLBACK', 'user-fallback-must-not-load');
    creatorSecrets.setPolicy('secrets-contract-app', 'CREATOR_ONLY', 'creator_override');
    creatorSecrets.setPolicy('secrets-contract-app', 'NO_FALLBACK', 'creator_override');
    if (setCreatorOverrideForTests) {
      await setCreatorOverrideForTests(
        'secrets-contract-app',
        DEFAULT_WORKSPACE_ID,
        'CREATOR_ONLY',
        'creator-only-value',
      );
    } else {
      creatorSecrets.setCreatorSecret(
        'secrets-contract-app',
        DEFAULT_WORKSPACE_ID,
        'CREATOR_ONLY',
        'creator-only-value',
      );
    }
    const creatorLoaded = await secrets.loadCreatorOverrideForRun(
      'secrets-contract-app',
      DEFAULT_WORKSPACE_ID,
      ['CREATOR_ONLY', 'USER_ONLY', 'NO_FALLBACK'],
    );
    assert(creatorLoaded.CREATOR_ONLY === 'creator-only-value', `creatorLoaded=${JSON.stringify(creatorLoaded)}`);
    assert(!('USER_ONLY' in creatorLoaded), 'creator loader returned user-vault key');
    assert(!('NO_FALLBACK' in creatorLoaded), 'creator loader fell back to user vault');
    const userLoaded = await secrets.loadUserVaultForRun(ctx, ['CREATOR_ONLY', 'USER_ONLY']);
    assert(userLoaded.USER_ONLY === 'user-only-value', `userLoaded=${JSON.stringify(userLoaded)}`);
    assert(!('CREATOR_ONLY' in userLoaded), 'user loader returned creator-only key');
  });

  await check('tenant isolation keeps same key separate by workspace_id', async () => {
    await secrets.set(ctx, 'TENANT_KEY', 'tenant-a-value');
    await secrets.set(tenantCtx, 'TENANT_KEY', 'tenant-b-value');
    assert(await secrets.get(ctx, 'TENANT_KEY') === 'tenant-a-value', 'tenant A read mismatch');
    assert(await secrets.get(tenantCtx, 'TENANT_KEY') === 'tenant-b-value', 'tenant B read mismatch');
    const tenantLoaded = await secrets.loadUserVaultForRun(tenantCtx, ['KEY_A']);
    assert(
      tenantLoaded.KEY_A === undefined,
      'tenant B loaded tenant A key',
    );
  });

  await check('idempotent delete returns false for missing key', async () => {
    assert(await secrets.delete(ctx, 'MISSING_SECRET_KEY') === false, 'delete missing returned true');
  });

  await check('ciphertext opacity keeps plaintext out of backing store', async () => {
    const canary = 'CANARY_SECRET_aaa';
    await secrets.set(ctx, 'CANARY_KEY', canary);
    const gcpStorageKey = `user:${Buffer.from(ctx.user_id, 'utf8').toString('base64url')}:${Buffer.from('CANARY_KEY', 'utf8').toString('base64url')}`;
    const row = selectedSecretsAdapter.includes('gcp-kms')
      ? db
          .prepare(
            `SELECT ciphertext, nonce, auth_tag FROM encrypted_secrets
             WHERE workspace_id = ? AND key = ?`,
          )
          .get(ctx.workspace_id, gcpStorageKey)
      : db
          .prepare(
            `SELECT ciphertext, nonce, auth_tag FROM user_secrets
             WHERE workspace_id = ? AND user_id = ? AND key = ?`,
          )
          .get(ctx.workspace_id, ctx.user_id, 'CANARY_KEY');
    assert(row, selectedSecretsAdapter.includes('gcp-kms') ? 'encrypted_secrets row missing' : 'user_secrets row missing');
    assert(!JSON.stringify(row).includes(canary), `backing row leaked plaintext: ${JSON.stringify(row)}`);
    assert(/^[0-9a-f]+$/i.test(row.ciphertext), 'ciphertext is not hex-like');
    assert(/^[0-9a-f]{24}$/i.test(row.nonce), 'nonce shape mismatch');
    assert(/^[0-9a-f]{32}$/i.test(row.auth_tag), 'auth_tag shape mismatch');
  });
} finally {
  try {
    db.close();
  } catch {
    // best effort
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passing, ${failed} failing`);
process.exit(0);
