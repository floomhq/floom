import assert from 'node:assert/strict';
import type {
  CreatorSecretCiphertextRow,
  CreatorSecretCiphertextWriteInput,
  SecretCiphertextRow,
  SecretCiphertextWriteInput,
  StorageAdapter,
} from '@floom/adapter-types';
import {
  createGcpKmsSecretsAdapter,
  createMockGcpKmsDekWrapper,
} from '../src/index.ts';

class MemorySecretStorage {
  readonly userRows = new Map<string, SecretCiphertextRow>();
  readonly creatorRows = new Map<string, CreatorSecretCiphertextRow>();
  readonly policies = new Map<string, 'user_vault' | 'creator_override'>();

  getUserSecretRow(
    workspace_id: string,
    user_id: string,
    key: string,
  ): SecretCiphertextRow | undefined {
    return this.userRows.get(userKey(workspace_id, user_id, key));
  }

  listUserSecretRows(
    workspace_id: string,
    user_id: string,
    keys: string[],
  ): SecretCiphertextRow[] {
    return keys
      .map((key) => this.getUserSecretRow(workspace_id, user_id, key))
      .filter((row): row is SecretCiphertextRow => !!row);
  }

  listUserSecretMetadata(
    workspace_id: string,
    user_id: string,
  ): Array<{ key: string; updated_at: string }> {
    return [...this.userRows.values()]
      .filter((row) => row.workspace_id === workspace_id && row.user_id === user_id)
      .map((row) => ({ key: row.key, updated_at: row.updated_at }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  upsertUserSecretRow(row: SecretCiphertextWriteInput): void {
    this.userRows.set(userKey(row.workspace_id, row.user_id, row.key), {
      ...row,
      updated_at: new Date().toISOString(),
    });
  }

  deleteUserSecretRow(
    workspace_id: string,
    user_id: string,
    key: string,
  ): boolean {
    return this.userRows.delete(userKey(workspace_id, user_id, key));
  }

  setSecretPolicy(
    app_id: string,
    key: string,
    policy: 'user_vault' | 'creator_override',
  ): void {
    this.policies.set(`${app_id}:${key}`, policy);
  }

  upsertCreatorSecretRow(row: CreatorSecretCiphertextWriteInput): void {
    this.creatorRows.set(`${row.app_id}:${row.key}`, {
      ...row,
      updated_at: new Date().toISOString(),
    });
  }

  listCreatorOverrideSecretRowsForRun(
    app_id: string,
    keys: string[],
  ): CreatorSecretCiphertextRow[] {
    return keys
      .filter((key) => this.policies.get(`${app_id}:${key}`) === 'creator_override')
      .map((key) => this.creatorRows.get(`${app_id}:${key}`))
      .filter((row): row is CreatorSecretCiphertextRow => !!row);
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

const backingRow = storage.getUserSecretRow('workspace-a', 'user-1', 'API_KEY');
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

const testHook = secrets as typeof secrets & {
  __setCreatorOverrideForTests(
    app_id: string,
    workspace_id: string,
    key: string,
    plaintext: string,
  ): Promise<void>;
};
await testHook.__setCreatorOverrideForTests(
  'app-1',
  'workspace-a',
  'CREATOR_ONLY',
  'creator-secret',
);
assert.deepEqual(
  await secrets.loadCreatorOverrideForRun('app-1', 'workspace-a', ['CREATOR_ONLY']),
  { CREATOR_ONLY: 'creator-secret' },
);

assert.equal(await secrets.delete(ctx, 'API_KEY'), true);
assert.equal(await secrets.get(ctx, 'API_KEY'), null);
assert.equal(await secrets.delete(ctx, 'API_KEY'), false);

console.log('gcp-kms secrets unit tests passed');

function userKey(workspace_id: string, user_id: string, key: string): string {
  return `${workspace_id}:${user_id}:${key}`;
}
