import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type {
  CreatorSecretCiphertextRow,
  SecretCiphertextRow,
  SecretCiphertextWriteInput,
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
    | 'getUserSecretRow'
    | 'listUserSecretRows'
    | 'listUserSecretMetadata'
    | 'upsertUserSecretRow'
    | 'deleteUserSecretRow'
    | 'setSecretPolicy'
    | 'upsertCreatorSecretRow'
    | 'listCreatorOverrideSecretRowsForRun'
  >
>;

interface TestableSecretsAdapter extends SecretsAdapter {
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
      const row = storage.getUserSecretRow(ctx.workspace_id, ctx.user_id, key);
      return row ? await decryptSecretRow(kms, row) : null;
    },

    async set(
      ctx: SessionContext,
      key: string,
      plaintext: string,
    ): Promise<void> {
      storage.upsertUserSecretRow({
        workspace_id: ctx.workspace_id,
        user_id: ctx.user_id,
        key,
        ...(await encryptSecret(kms, plaintext)),
      });
    },

    async delete(ctx: SessionContext, key: string): Promise<boolean> {
      return storage.deleteUserSecretRow(ctx.workspace_id, ctx.user_id, key);
    },

    async list(
      ctx: SessionContext,
    ): Promise<Array<{ key: string; updated_at: string }>> {
      return storage.listUserSecretMetadata(ctx.workspace_id, ctx.user_id);
    },

    async loadUserVaultForRun(
      ctx: SessionContext,
      keys: string[],
    ): Promise<Record<string, string>> {
      const rows = storage.listUserSecretRows(
        ctx.workspace_id,
        ctx.user_id,
        keys,
      );
      return await decryptRows(kms, rows);
    },

    async loadCreatorOverrideForRun(
      app_id: string,
      _workspace_id: string,
      keys: string[],
    ): Promise<Record<string, string>> {
      const rows = storage.listCreatorOverrideSecretRowsForRun(app_id, keys);
      return await decryptRows(kms, rows);
    },

    async __setCreatorOverrideForTests(
      app_id: string,
      workspace_id: string,
      key: string,
      plaintext: string,
    ): Promise<void> {
      storage.setSecretPolicy(app_id, key, 'creator_override');
      storage.upsertCreatorSecretRow({
        app_id,
        workspace_id,
        key,
        ...(await encryptSecret(kms, plaintext)),
      });
    },
  };

  return adapter;
}

function requireSecretStorage(storage: StorageAdapter): SecretStorage {
  const methods: Array<keyof SecretStorage> = [
    'getUserSecretRow',
    'listUserSecretRows',
    'listUserSecretMetadata',
    'upsertUserSecretRow',
    'deleteUserSecretRow',
    'setSecretPolicy',
    'upsertCreatorSecretRow',
    'listCreatorOverrideSecretRowsForRun',
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
): Promise<Omit<SecretCiphertextWriteInput, 'workspace_id' | 'user_id' | 'key'>> {
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
    SecretCiphertextRow | CreatorSecretCiphertextRow,
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
  rows: Array<SecretCiphertextRow | CreatorSecretCiphertextRow>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      out[row.key] = await decryptSecretRow(kms, row);
    } catch {
      continue;
    }
  }
  return out;
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
