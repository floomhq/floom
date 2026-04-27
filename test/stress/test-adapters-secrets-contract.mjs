#!/usr/bin/env node
// Contract tests for the SecretsAdapter.
//
// These tests define executable conformance checks for the local encrypted
// vault and creator-override loader. They print the complete tally and exit
// non-zero when any assertion fails.
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
const secrets = adapters.secrets;

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

  await check('admin global secret CRUD round-trip', async () => {
    await secrets.setAdminSecret(null, 'ADMIN_GLOBAL', 'admin-global-value');
    assert(await secrets.getAdminSecret(null, 'ADMIN_GLOBAL') === 'admin-global-value', 'global admin plaintext mismatch');
    assert(await secrets.deleteAdminSecret(null, 'ADMIN_GLOBAL') === true, 'delete existing global admin secret returned false');
    assert(await secrets.getAdminSecret(null, 'ADMIN_GLOBAL') === null, 'deleted global admin secret remained readable');
  });

  await check('admin app secret list masks plaintext', async () => {
    await secrets.setAdminSecret('secrets-contract-app', 'ADMIN_APP', 'admin-app-value');
    const list = await secrets.listAdminSecrets('secrets-contract-app');
    const row = list.find((item) => item.key === 'ADMIN_APP');
    assert(row, `list=${JSON.stringify(list)}`);
    assert(typeof row.updated_at === 'string' && row.updated_at.length > 0, 'updated_at missing');
    assert(!('value' in row), 'admin list exposed value');
    assert(!('ciphertext' in row), 'admin list exposed ciphertext');
    assert(!JSON.stringify(row).includes('admin-app-value'), 'admin list leaked plaintext');
  });

  await check('admin global and app namespaces are isolated', async () => {
    await secrets.setAdminSecret(null, 'ADMIN_SHARED', 'admin-global-shared');
    await secrets.setAdminSecret('secrets-contract-app', 'ADMIN_SHARED', 'admin-app-shared');
    assert(await secrets.getAdminSecret(null, 'ADMIN_SHARED') === 'admin-global-shared', 'global admin value mismatch');
    assert(await secrets.getAdminSecret('secrets-contract-app', 'ADMIN_SHARED') === 'admin-app-shared', 'app admin value mismatch');
  });

  await check('creator-override namespace is isolated from user vault', async () => {
    await secrets.set(ctx, 'USER_ONLY', 'user-only-value');
    await secrets.set(ctx, 'NO_FALLBACK', 'user-fallback-must-not-load');
    await secrets.setCreatorPolicy('secrets-contract-app', 'CREATOR_ONLY', 'creator_override');
    await secrets.setCreatorPolicy('secrets-contract-app', 'NO_FALLBACK', 'creator_override');
    await secrets.setCreatorOverrideSecret(
      { workspace_id: DEFAULT_WORKSPACE_ID },
      'secrets-contract-app',
      'CREATOR_ONLY',
      'creator-only-value',
    );
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

  await check('creator override get returns only selected workspace value', async () => {
    await secrets.setCreatorOverrideSecret(
      { workspace_id: DEFAULT_WORKSPACE_ID },
      'secrets-contract-app',
      'CREATOR_GET',
      'creator-get-value',
    );
    assert(
      await secrets.getCreatorOverrideSecret(
        { workspace_id: DEFAULT_WORKSPACE_ID },
        'secrets-contract-app',
        'CREATOR_GET',
      ) === 'creator-get-value',
      'creator override get mismatch',
    );
    assert(
      await secrets.getCreatorOverrideSecret(
        { workspace_id: tenantCtx.workspace_id },
        'secrets-contract-app',
        'CREATOR_GET',
      ) === null,
      'creator override leaked across workspace',
    );
  });

  await check('creator override listForRun filters requested keys', async () => {
    await secrets.setCreatorOverrideSecret(
      { workspace_id: DEFAULT_WORKSPACE_ID },
      'secrets-contract-app',
      'CREATOR_LIST_A',
      'creator-list-a',
    );
    await secrets.setCreatorOverrideSecret(
      { workspace_id: DEFAULT_WORKSPACE_ID },
      'secrets-contract-app',
      'CREATOR_LIST_B',
      'creator-list-b',
    );
    await secrets.setCreatorPolicy('secrets-contract-app', 'CREATOR_LIST_A', 'creator_override');
    await secrets.setCreatorPolicy('secrets-contract-app', 'CREATOR_LIST_B', 'creator_override');
    const listed = await secrets.listCreatorOverrideSecretsForRun(
      { workspace_id: DEFAULT_WORKSPACE_ID },
      'secrets-contract-app',
      ['CREATOR_LIST_A'],
    );
    assert(JSON.stringify(Object.keys(listed).sort()) === JSON.stringify(['CREATOR_LIST_A']), `keys=${JSON.stringify(listed)}`);
    assert(listed.CREATOR_LIST_A === 'creator-list-a', `CREATOR_LIST_A=${listed.CREATOR_LIST_A}`);
  });

  await check('creator override delete is idempotent', async () => {
    await secrets.setCreatorOverrideSecret(
      { workspace_id: DEFAULT_WORKSPACE_ID },
      'secrets-contract-app',
      'CREATOR_DELETE',
      'creator-delete-value',
    );
    assert(
      await secrets.deleteCreatorOverrideSecret(
        { workspace_id: DEFAULT_WORKSPACE_ID },
        'secrets-contract-app',
        'CREATOR_DELETE',
      ) === true,
      'delete existing creator override returned false',
    );
    assert(
      await secrets.getCreatorOverrideSecret(
        { workspace_id: DEFAULT_WORKSPACE_ID },
        'secrets-contract-app',
        'CREATOR_DELETE',
      ) === null,
      'deleted creator override remained readable',
    );
    assert(
      await secrets.deleteCreatorOverrideSecret(
        { workspace_id: DEFAULT_WORKSPACE_ID },
        'secrets-contract-app',
        'CREATOR_DELETE',
      ) === false,
      'delete missing creator override returned true',
    );
  });

  await check('creator override write is app-scoped', async () => {
    createApp('secrets-contract-app-c');
    await secrets.setCreatorOverrideSecret(
      { workspace_id: DEFAULT_WORKSPACE_ID },
      'secrets-contract-app',
      'CREATOR_SCOPED',
      'creator-scoped-a',
    );
    await secrets.setCreatorOverrideSecret(
      { workspace_id: DEFAULT_WORKSPACE_ID },
      'secrets-contract-app-c',
      'CREATOR_SCOPED',
      'creator-scoped-c',
    );
    assert(
      await secrets.getCreatorOverrideSecret(
        { workspace_id: DEFAULT_WORKSPACE_ID },
        'secrets-contract-app',
        'CREATOR_SCOPED',
      ) === 'creator-scoped-a',
      'app A creator override mismatch',
    );
    assert(
      await secrets.getCreatorOverrideSecret(
        { workspace_id: DEFAULT_WORKSPACE_ID },
        'secrets-contract-app-c',
        'CREATOR_SCOPED',
      ) === 'creator-scoped-c',
      'app C creator override mismatch',
    );
  });

  await check('creator policy CRUD round-trip', async () => {
    await secrets.setCreatorPolicy('secrets-contract-app', 'POLICY_KEY', 'creator_override');
    assert(await secrets.getCreatorPolicy('secrets-contract-app', 'POLICY_KEY') === 'creator_override', 'creator policy mismatch');
    await secrets.setCreatorPolicy('secrets-contract-app', 'POLICY_KEY', 'user_vault');
    assert(await secrets.getCreatorPolicy('secrets-contract-app', 'POLICY_KEY') === 'user_vault', 'creator policy update mismatch');
  });

  await check('creator policy list returns explicit policies only', async () => {
    await secrets.setCreatorPolicy('secrets-contract-app', 'POLICY_LIST_A', 'creator_override');
    await secrets.setCreatorPolicy('secrets-contract-app', 'POLICY_LIST_B', 'user_vault');
    const list = await secrets.listCreatorPolicies('secrets-contract-app');
    const map = new Map(list.map((row) => [row.key, row.policy]));
    assert(map.get('POLICY_LIST_A') === 'creator_override', `list=${JSON.stringify(list)}`);
    assert(map.get('POLICY_LIST_B') === 'user_vault', `list=${JSON.stringify(list)}`);
    assert(!map.has('MISSING_POLICY'), 'list returned implicit default policy');
  });

  await check('creator policy delete is idempotent', async () => {
    await secrets.setCreatorPolicy('secrets-contract-app', 'POLICY_DELETE', 'creator_override');
    assert(await secrets.deleteCreatorPolicy('secrets-contract-app', 'POLICY_DELETE') === true, 'delete existing policy returned false');
    assert(await secrets.getCreatorPolicy('secrets-contract-app', 'POLICY_DELETE') === null, 'deleted policy remained readable');
    assert(await secrets.deleteCreatorPolicy('secrets-contract-app', 'POLICY_DELETE') === false, 'delete missing policy returned true');
  });

  await check('creator policy namespace is isolated by app_id', async () => {
    createApp('secrets-contract-app-b');
    await secrets.setCreatorPolicy('secrets-contract-app', 'POLICY_ISOLATED', 'creator_override');
    await secrets.setCreatorPolicy('secrets-contract-app-b', 'POLICY_ISOLATED', 'user_vault');
    assert(await secrets.getCreatorPolicy('secrets-contract-app', 'POLICY_ISOLATED') === 'creator_override', 'app A policy mismatch');
    assert(await secrets.getCreatorPolicy('secrets-contract-app-b', 'POLICY_ISOLATED') === 'user_vault', 'app B policy mismatch');
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

  await check('admin secret ciphertext opacity', async () => {
    const canary = 'ADMIN_CANARY_SECRET_aaa';
    await secrets.setAdminSecret('secrets-contract-app', 'ADMIN_CANARY_KEY', canary);
    const storageKey = `admin:${Buffer.from('secrets-contract-app', 'utf8').toString('base64url')}:${Buffer.from('ADMIN_CANARY_KEY', 'utf8').toString('base64url')}`;
    const row = selectedSecretsAdapter.includes('gcp-kms')
      ? db
          .prepare(
            `SELECT ciphertext, nonce, auth_tag, encrypted_dek FROM encrypted_secrets
             WHERE workspace_id = ? AND key = ?`,
          )
          .get('operator', storageKey)
      : db
          .prepare(
            `SELECT value FROM secrets
             WHERE app_id = ? AND name = ?`,
          )
          .get('secrets-contract-app', 'ADMIN_CANARY_KEY');
    assert(row, 'admin secret row missing');
    assert(!JSON.stringify(row).includes(canary), `admin backing row leaked plaintext: ${JSON.stringify(row)}`);
    if (selectedSecretsAdapter.includes('gcp-kms')) {
      assert(typeof row.encrypted_dek === 'string' && row.encrypted_dek.length > 0, 'encrypted_dek missing');
    } else {
      assert(typeof row.value === 'string' && row.value.startsWith('floom:aes-gcm:v1:'), `local admin secret not encrypted: ${JSON.stringify(row)}`);
    }
  });

  await check('local admin plaintext rows lazy-migrate on read', async () => {
    if (selectedSecretsAdapter.includes('gcp-kms')) return;
    const id = 'legacy-admin-secret-row';
    const canary = 'LEGACY_ADMIN_CANARY_SECRET_aaa';
    db.prepare(
      `INSERT INTO secrets (id, name, value, app_id)
       VALUES (?, ?, ?, ?)`,
    ).run(id, 'LEGACY_ADMIN_CANARY_KEY', canary, 'secrets-contract-app');
    assert(
      await secrets.getAdminSecret('secrets-contract-app', 'LEGACY_ADMIN_CANARY_KEY') === canary,
      'legacy plaintext admin value did not read',
    );
    const row = db
      .prepare(`SELECT value FROM secrets WHERE id = ?`)
      .get(id);
    assert(row, 'legacy admin row missing after read');
    assert(!JSON.stringify(row).includes(canary), `legacy admin row did not migrate: ${JSON.stringify(row)}`);
    assert(typeof row.value === 'string' && row.value.startsWith('floom:aes-gcm:v1:'), `legacy admin row not encrypted: ${JSON.stringify(row)}`);
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
process.exit(failed > 0 ? 1 : 0);
