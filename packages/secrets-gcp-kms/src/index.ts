import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type {
  EncryptedSecretRecord,
  SecretPolicy,
  SecretsAdapter,
  SessionContext,
  StorageAdapter,
} from '@floom/adapter-types';

export interface GcpKmsSecretsAdapterOptions {
  keyName: string;
  projectId?: string;
  storage: StorageAdapter;
  kmsClient?: DekWrapper;
}

export interface DekWrapper {
  encryptDek(dek: Buffer): Promise<Buffer>;
  decryptDek(encryptedDek: Buffer): Promise<Buffer>;
}

type KmsClient = InstanceType<
  typeof import('@google-cloud/kms').KeyManagementServiceClient
>;

type SecretStorage = Required<
  Pick<
    StorageAdapter,
    | 'getEncryptedSecret'
    | 'setEncryptedSecret'
    | 'listEncryptedSecrets'
    | 'deleteEncryptedSecret'
  >
>;

const OPERATOR_SECRET_WORKSPACE_ID = 'operator';

interface TestableSecretsAdapter extends SecretsAdapter {
  setCreatorOverrideSecret(
    app_id: string,
    workspace_id: string,
    key: string,
    plaintext: string,
  ): Promise<void>;
  __setCreatorOverrideForTests?(
    app_id: string,
    workspace_id: string,
    key: string,
    plaintext: string,
  ): Promise<void>;
}

class GcpKmsDekWrapper implements DekWrapper {
  private clientPromise?: Promise<KmsClient>;

  constructor(
    private readonly keyName: string,
    private readonly projectId?: string,
  ) {}

  async encryptDek(dek: Buffer): Promise<Buffer> {
    const client = await this.client();
    const [response] = await client.encrypt({
      name: this.keyName,
      plaintext: dek,
    });
    return Buffer.from(response.ciphertext ?? []);
  }

  async decryptDek(encryptedDek: Buffer): Promise<Buffer> {
    const client = await this.client();
    const [response] = await client.decrypt({
      name: this.keyName,
      ciphertext: encryptedDek,
    });
    return Buffer.from(response.plaintext ?? []);
  }

  private client(): Promise<KmsClient> {
    this.clientPromise ??= import('@google-cloud/kms').then(
      ({ KeyManagementServiceClient }) =>
        new KeyManagementServiceClient(
          this.projectId ? { projectId: this.projectId } : undefined,
        ),
    );
    return this.clientPromise;
  }
}

class XorDekWrapper implements DekWrapper {
  private readonly mask = createHash('sha256')
    .update('floom-gcp-kms-conformance')
    .digest();

  encryptDek(dek: Buffer): Promise<Buffer> {
    return Promise.resolve(this.xor(dek));
  }

  decryptDek(encryptedDek: Buffer): Promise<Buffer> {
    return Promise.resolve(this.xor(encryptedDek));
  }

  private xor(input: Buffer): Buffer {
    const out = Buffer.alloc(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = input[i] ^ this.mask[i % this.mask.length];
    }
    return out;
  }
}

export function createMockGcpKmsDekWrapper(): DekWrapper {
  return new XorDekWrapper();
}

export function createGcpKmsSecretsAdapter(
  opts: GcpKmsSecretsAdapterOptions,
): SecretsAdapter {
  const storage = requireSecretStorage(opts.storage);
  const kms =
    opts.kmsClient ??
    (process.env.FLOOM_GCP_KMS_MOCK === '1'
      ? createMockGcpKmsDekWrapper()
      : new GcpKmsDekWrapper(opts.keyName, opts.projectId));

  const adapter: TestableSecretsAdapter = {
    async get(ctx: SessionContext, key: string): Promise<string | null> {
      const row = await storage.getEncryptedSecret(
        { workspace_id: ctx.workspace_id },
        userSecretStorageKey(ctx.user_id, key),
      );
      return row ? await decryptSecretRow(kms, row) : null;
    },

    async set(
      ctx: SessionContext,
      key: string,
      plaintext: string,
    ): Promise<void> {
      await storage.setEncryptedSecret(
        { workspace_id: ctx.workspace_id },
        userSecretStorageKey(ctx.user_id, key),
        await encryptSecret(kms, plaintext),
      );
    },

    async delete(ctx: SessionContext, key: string): Promise<boolean> {
      return storage.deleteEncryptedSecret(
        { workspace_id: ctx.workspace_id },
        userSecretStorageKey(ctx.user_id, key),
      );
    },

    async list(
      ctx: SessionContext,
    ): Promise<Array<{ key: string; updated_at: string }>> {
      const rows = await storage.listEncryptedSecrets({ workspace_id: ctx.workspace_id });
      return rows
        .map((row) => {
          const key = userSecretKeyFromStorageKey(ctx.user_id, row.key);
          return key ? { key, updated_at: row.updated_at } : null;
        })
        .filter((row): row is { key: string; updated_at: string } => row !== null)
        .sort((a, b) => a.key.localeCompare(b.key));
    },

    async setAdminSecret(
      app_id: string | null,
      key: string,
      plaintext: string,
    ): Promise<void> {
      await storage.setEncryptedSecret(
        { workspace_id: OPERATOR_SECRET_WORKSPACE_ID },
        adminSecretStorageKey(app_id, key),
        await encryptSecret(kms, plaintext),
      );
    },

    async getAdminSecret(
      app_id: string | null,
      key: string,
    ): Promise<string | null> {
      const row = await storage.getEncryptedSecret(
        { workspace_id: OPERATOR_SECRET_WORKSPACE_ID },
        adminSecretStorageKey(app_id, key),
      );
      return row ? await decryptSecretRow(kms, row) : null;
    },

    async listAdminSecrets(
      app_id: string | null,
    ): Promise<Array<{ key: string; updated_at: string }>> {
      const rows = await storage.listEncryptedSecrets({
        workspace_id: OPERATOR_SECRET_WORKSPACE_ID,
      });
      return rows
        .map((row) => {
          const key = adminSecretKeyFromStorageKey(app_id, row.key);
          return key ? { key, updated_at: row.updated_at } : null;
        })
        .filter((row): row is { key: string; updated_at: string } => row !== null)
        .sort((a, b) => a.key.localeCompare(b.key));
    },

    async deleteAdminSecret(
      app_id: string | null,
      key: string,
    ): Promise<boolean> {
      return storage.deleteEncryptedSecret(
        { workspace_id: OPERATOR_SECRET_WORKSPACE_ID },
        adminSecretStorageKey(app_id, key),
      );
    },

    async setCreatorPolicy(
      app_id: string,
      key: string,
      policy: SecretPolicy,
    ): Promise<void> {
      if (policy !== 'user_vault' && policy !== 'creator_override') {
        throw new Error(`Invalid policy: ${policy}`);
      }
      await storage.setEncryptedSecret(
        { workspace_id: OPERATOR_SECRET_WORKSPACE_ID },
        creatorPolicyStorageKey(app_id, key),
        await encryptSecret(kms, policy),
      );
    },

    async getCreatorPolicy(
      app_id: string,
      key: string,
    ): Promise<SecretPolicy | null> {
      const row = await storage.getEncryptedSecret(
        { workspace_id: OPERATOR_SECRET_WORKSPACE_ID },
        creatorPolicyStorageKey(app_id, key),
      );
      if (!row) return null;
      return normalizePolicy(await decryptSecretRow(kms, row));
    },

    async listCreatorPolicies(
      app_id: string,
    ): Promise<Array<{ key: string; policy: SecretPolicy }>> {
      const rows = await storage.listEncryptedSecrets({
        workspace_id: OPERATOR_SECRET_WORKSPACE_ID,
      });
      const out: Array<{ key: string; policy: SecretPolicy }> = [];
      for (const row of rows) {
        const key = creatorPolicyKeyFromStorageKey(app_id, row.key);
        if (!key) continue;
        const encrypted = await storage.getEncryptedSecret(
          { workspace_id: OPERATOR_SECRET_WORKSPACE_ID },
          row.key,
        );
        if (!encrypted) continue;
        const policy = normalizePolicy(await decryptSecretRow(kms, encrypted));
        if (policy) out.push({ key, policy });
      }
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },

    async deleteCreatorPolicy(app_id: string, key: string): Promise<boolean> {
      return storage.deleteEncryptedSecret(
        { workspace_id: OPERATOR_SECRET_WORKSPACE_ID },
        creatorPolicyStorageKey(app_id, key),
      );
    },

    async loadUserVaultForRun(
      ctx: SessionContext,
      keys: string[],
    ): Promise<Record<string, string>> {
      const rows = await loadEncryptedRows(
        storage,
        ctx.workspace_id,
        keys.map((key) => userSecretStorageKey(ctx.user_id, key)),
      );
      return await decryptRows(kms, rows);
    },

    async loadCreatorOverrideForRun(
      app_id: string,
      workspace_id: string,
      keys: string[],
    ): Promise<Record<string, string>> {
      const rows = await loadEncryptedRows(
        storage,
        workspace_id,
        keys.map((key) => creatorSecretStorageKey(app_id, key)),
      );
      return await decryptRows(kms, rows);
    },

    async setCreatorOverrideSecret(
      app_id: string,
      workspace_id: string,
      key: string,
      plaintext: string,
    ): Promise<void> {
      await storage.setEncryptedSecret(
        { workspace_id },
        creatorSecretStorageKey(app_id, key),
        await encryptSecret(kms, plaintext),
      );
    },

    async __setCreatorOverrideForTests(
      app_id: string,
      workspace_id: string,
      key: string,
      plaintext: string,
    ): Promise<void> {
      await storage.setEncryptedSecret(
        { workspace_id },
        creatorSecretStorageKey(app_id, key),
        await encryptSecret(kms, plaintext),
      );
    },
  };

  return adapter;
}

function requireSecretStorage(storage: StorageAdapter): SecretStorage {
  const methods: Array<keyof SecretStorage> = [
    'getEncryptedSecret',
    'setEncryptedSecret',
    'listEncryptedSecrets',
    'deleteEncryptedSecret',
  ];
  const missing = methods.filter((method) => typeof storage[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(
      `GCP KMS SecretsAdapter requires encrypted secret storage methods: ${missing.join(', ')}`,
    );
  }
  return storage as SecretStorage;
}

async function encryptSecret(
  kms: DekWrapper,
  plaintext: string,
): Promise<{
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  encrypted_dek: string;
}> {
  const dek = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const encryptedDek = await kms.encryptDek(dek);
  return {
    ciphertext: ciphertext.toString('hex'),
    nonce: nonce.toString('hex'),
    auth_tag: authTag.toString('hex'),
    encrypted_dek: encryptedDek.toString('base64'),
  };
}

async function decryptSecretRow(
  kms: DekWrapper,
  row: Pick<
    EncryptedSecretRecord,
    'key' | 'ciphertext' | 'nonce' | 'auth_tag' | 'encrypted_dek'
  >,
): Promise<string> {
  if (!row.encrypted_dek) {
    throw new Error(`secret row ${row.key} is missing encrypted_dek`);
  }
  const dek = await kms.decryptDek(Buffer.from(row.encrypted_dek, 'base64'));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    dek,
    Buffer.from(row.nonce, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

async function decryptRows(
  kms: DekWrapper,
  rows: EncryptedSecretRecord[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      const decodedKey = decodedSecretKey(row.key);
      if (decodedKey) out[decodedKey] = await decryptSecretRow(kms, row);
    } catch {
      continue;
    }
  }
  return out;
}

async function loadEncryptedRows(
  storage: SecretStorage,
  workspace_id: string,
  storageKeys: string[],
): Promise<EncryptedSecretRecord[]> {
  const rows = await Promise.all(
    storageKeys.map((key) => storage.getEncryptedSecret({ workspace_id }, key)),
  );
  return rows.filter((row): row is EncryptedSecretRecord => row !== undefined);
}

function userSecretStorageKey(user_id: string, key: string): string {
  return `user:${encodeComponent(user_id)}:${encodeComponent(key)}`;
}

function creatorSecretStorageKey(app_id: string, key: string): string {
  return `creator:${encodeComponent(app_id)}:${encodeComponent(key)}`;
}

function adminSecretStorageKey(app_id: string | null, key: string): string {
  return `admin:${encodeComponent(app_id ?? '__global__')}:${encodeComponent(key)}`;
}

function creatorPolicyStorageKey(app_id: string, key: string): string {
  return `creator-policy:${encodeComponent(app_id)}:${encodeComponent(key)}`;
}

function userSecretKeyFromStorageKey(user_id: string, storageKey: string): string | null {
  const prefix = `user:${encodeComponent(user_id)}:`;
  if (!storageKey.startsWith(prefix)) return null;
  return decodeComponent(storageKey.slice(prefix.length));
}

function adminSecretKeyFromStorageKey(
  app_id: string | null,
  storageKey: string,
): string | null {
  const prefix = `admin:${encodeComponent(app_id ?? '__global__')}:`;
  if (!storageKey.startsWith(prefix)) return null;
  return decodeComponent(storageKey.slice(prefix.length));
}

function creatorPolicyKeyFromStorageKey(
  app_id: string,
  storageKey: string,
): string | null {
  const prefix = `creator-policy:${encodeComponent(app_id)}:`;
  if (!storageKey.startsWith(prefix)) return null;
  return decodeComponent(storageKey.slice(prefix.length));
}

function normalizePolicy(value: string): SecretPolicy | null {
  if (value === 'user_vault' || value === 'creator_override') return value;
  return null;
}

function decodedSecretKey(storageKey: string): string | null {
  const parts = storageKey.split(':');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'user' && parts[0] !== 'creator') return null;
  return decodeComponent(parts[2]);
}

function encodeComponent(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeComponent(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

interface FactoryOptions {
  keyName?: string;
  projectId?: string;
  storage?: StorageAdapter;
}

export default {
  kind: 'secrets' as const,
  name: 'gcp-kms',
  protocolVersion: '^0.2',
  create(opts: FactoryOptions): SecretsAdapter {
    const keyName =
      opts.keyName ||
      process.env.FLOOM_GCP_KMS_KEY_NAME ||
      process.env.FLOOM_SECRETS_GCP_KMS_KEY_NAME ||
      (process.env.FLOOM_GCP_KMS_MOCK === '1'
        ? 'projects/test/locations/global/keyRings/test/cryptoKeys/test'
        : '');
    if (!keyName) {
      throw new Error(
        'GCP KMS SecretsAdapter requires keyName or FLOOM_GCP_KMS_KEY_NAME',
      );
    }
    if (!opts.storage) {
      throw new Error('GCP KMS SecretsAdapter requires a storage adapter');
    }
    return createGcpKmsSecretsAdapter({
      keyName,
      projectId: opts.projectId || process.env.GOOGLE_CLOUD_PROJECT,
      storage: opts.storage,
    });
  },
};
