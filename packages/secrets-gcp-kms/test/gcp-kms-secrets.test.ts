import assert from 'node:assert/strict';
import type {
  EncryptedSecretRecord,
  StorageAdapter,
} from '@floom/adapter-types';
import {
  createGcpKmsSecretsAdapter,
  createMockGcpKmsDekWrapper,
} from '../src/index.ts';

class MemorySecretStorage {
  readonly rows = new Map<string, EncryptedSecretRecord>();

  async getEncryptedSecret(
    ctx: { workspace_id: string },
    key: string,
  ): Promise<EncryptedSecretRecord | undefined> {
    return this.rows.get(rowKey(ctx.workspace_id, key));
  }

  async listEncryptedSecrets(
    ctx: { workspace_id: string },
  ): Promise<Array<{ key: string; updated_at: string }>> {
    return [...this.rows.values()]
      .filter((row) => row.workspace_id === ctx.workspace_id)
      .map((row) => ({ key: row.key, updated_at: row.updated_at }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async setEncryptedSecret(
    ctx: { workspace_id: string },
    key: string,
    payload: {
      ciphertext: string;
      nonce: string;
      auth_tag: string;
      encrypted_dek: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = this.rows.get(rowKey(ctx.workspace_id, key));
    this.rows.set(rowKey(ctx.workspace_id, key), {
      workspace_id: ctx.workspace_id,
      key,
      ...payload,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
  }

  async deleteEncryptedSecret(
    ctx: { workspace_id: string },
    key: string,
  ): Promise<boolean> {
    return this.rows.delete(rowKey(ctx.workspace_id, key));
  }
}

const storage = new MemorySecretStorage();
const secrets = createGcpKmsSecretsAdapter({
  keyName: 'projects/test/locations/global/keyRings/test/cryptoKeys/test',
  storage: storage as unknown as StorageAdapter,
  kmsClient: createMockGcpKmsDekWrapper(),
});

const ctx = {
  workspace_id: 'workspace-a',
  user_id: 'user-1',
  device_id: 'device-1',
  is_authenticated: true,
};
const tenantCtx = { ...ctx, workspace_id: 'workspace-b' };

await secrets.set(ctx, 'API_KEY', 'sk-live-secret');
assert.equal(await secrets.get(ctx, 'API_KEY'), 'sk-live-secret');

const backingRow = [...storage.rows.values()].find((row) => row.workspace_id === 'workspace-a');
assert.ok(backingRow);
assert.notEqual(backingRow.ciphertext, 'sk-live-secret');
assert.ok(!JSON.stringify(backingRow).includes('sk-live-secret'));
assert.match(backingRow.ciphertext, /^[0-9a-f]+$/);
assert.match(backingRow.nonce, /^[0-9a-f]{24}$/);
assert.match(backingRow.auth_tag, /^[0-9a-f]{32}$/);
assert.ok(backingRow.encrypted_dek);

const listed = await secrets.list(ctx);
assert.deepEqual(listed.map((row) => row.key), ['API_KEY']);
assert.ok(!JSON.stringify(listed).includes('sk-live-secret'));

await secrets.set(ctx, 'EXTRA', 'extra-value');
assert.deepEqual(await secrets.loadUserVaultForRun(ctx, ['API_KEY']), {
  API_KEY: 'sk-live-secret',
});

await secrets.set(tenantCtx, 'API_KEY', 'tenant-b-secret');
assert.equal(await secrets.get(ctx, 'API_KEY'), 'sk-live-secret');
assert.equal(await secrets.get(tenantCtx, 'API_KEY'), 'tenant-b-secret');

await secrets.setCreatorOverrideSecret(
  { workspace_id: 'workspace-a' },
  'app-1',
  'CREATOR_ONLY',
  'creator-secret',
);
assert.equal(
  await secrets.getCreatorOverrideSecret(
    { workspace_id: 'workspace-a' },
    'app-1',
    'CREATOR_ONLY',
  ),
  'creator-secret',
);
assert.deepEqual(
  await secrets.loadCreatorOverrideForRun('app-1', 'workspace-a', ['CREATOR_ONLY']),
  { CREATOR_ONLY: 'creator-secret' },
);
assert.deepEqual(
  await secrets.listCreatorOverrideSecretsForRun(
    { workspace_id: 'workspace-a' },
    'app-1',
    ['CREATOR_ONLY'],
  ),
  { CREATOR_ONLY: 'creator-secret' },
);
assert.equal(
  await secrets.deleteCreatorOverrideSecret(
    { workspace_id: 'workspace-a' },
    'app-1',
    'CREATOR_ONLY',
  ),
  true,
);
assert.equal(
  await secrets.getCreatorOverrideSecret(
    { workspace_id: 'workspace-a' },
    'app-1',
    'CREATOR_ONLY',
  ),
  null,
);

assert.equal(await secrets.delete(ctx, 'API_KEY'), true);
assert.equal(await secrets.get(ctx, 'API_KEY'), null);
assert.equal(await secrets.delete(ctx, 'API_KEY'), false);

console.log('gcp-kms secrets unit tests passed');

function rowKey(workspace_id: string, key: string): string {
  return `${workspace_id}:${key}`;
}
