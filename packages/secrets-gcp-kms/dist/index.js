import { createCipheriv, createDecipheriv, createHash, randomBytes, } from 'node:crypto';
const OPERATOR_SECRET_WORKSPACE_ID = 'operator';
class GcpKmsDekWrapper {
    keyName;
    projectId;
    clientPromise;
    constructor(keyName, projectId) {
        this.keyName = keyName;
        this.projectId = projectId;
    }
    async encryptDek(dek) {
        const client = await this.client();
        const [response] = await client.encrypt({
            name: this.keyName,
            plaintext: dek,
        });
        return Buffer.from(response.ciphertext ?? []);
    }
    async decryptDek(encryptedDek) {
        const client = await this.client();
        const [response] = await client.decrypt({
            name: this.keyName,
            ciphertext: encryptedDek,
        });
        return Buffer.from(response.plaintext ?? []);
    }
    client() {
        this.clientPromise ??= import('@google-cloud/kms').then(({ KeyManagementServiceClient }) => new KeyManagementServiceClient(this.projectId ? { projectId: this.projectId } : undefined));
        return this.clientPromise;
    }
}
class XorDekWrapper {
    mask = createHash('sha256')
        .update('floom-gcp-kms-conformance')
        .digest();
    encryptDek(dek) {
        return Promise.resolve(this.xor(dek));
    }
    decryptDek(encryptedDek) {
        return Promise.resolve(this.xor(encryptedDek));
    }
    xor(input) {
        const out = Buffer.alloc(input.length);
        for (let i = 0; i < input.length; i++) {
            out[i] = input[i] ^ this.mask[i % this.mask.length];
        }
        return out;
    }
}
export function createMockGcpKmsDekWrapper() {
    return new XorDekWrapper();
}
export function createGcpKmsSecretsAdapter(opts) {
    const storage = requireSecretStorage(opts.storage);
    const kms = opts.kmsClient ??
        (process.env.FLOOM_GCP_KMS_MOCK === '1'
            ? createMockGcpKmsDekWrapper()
            : new GcpKmsDekWrapper(opts.keyName, opts.projectId));
    const adapter = {
        async get(ctx, key) {
            const row = await storage.getEncryptedSecret({ workspace_id: ctx.workspace_id }, userSecretStorageKey(ctx.user_id, key));
            return row ? await decryptSecretRow(kms, row) : null;
        },
        async set(ctx, key, plaintext) {
            await storage.setEncryptedSecret({ workspace_id: ctx.workspace_id }, userSecretStorageKey(ctx.user_id, key), await encryptSecret(kms, plaintext));
        },
        async delete(ctx, key) {
            return storage.deleteEncryptedSecret({ workspace_id: ctx.workspace_id }, userSecretStorageKey(ctx.user_id, key));
        },
        async list(ctx) {
            const rows = await storage.listEncryptedSecrets({ workspace_id: ctx.workspace_id });
            return rows
                .map((row) => {
                const key = userSecretKeyFromStorageKey(ctx.user_id, row.key);
                return key ? { key, updated_at: row.updated_at } : null;
            })
                .filter((row) => row !== null)
                .sort((a, b) => a.key.localeCompare(b.key));
        },
        async setAdminSecret(app_id, key, plaintext) {
            await storage.setEncryptedSecret({ workspace_id: OPERATOR_SECRET_WORKSPACE_ID }, adminSecretStorageKey(app_id, key), await encryptSecret(kms, plaintext));
        },
        async getAdminSecret(app_id, key) {
            const row = await storage.getEncryptedSecret({ workspace_id: OPERATOR_SECRET_WORKSPACE_ID }, adminSecretStorageKey(app_id, key));
            return row ? await decryptSecretRow(kms, row) : null;
        },
        async listAdminSecrets(app_id) {
            const rows = await storage.listEncryptedSecrets({
                workspace_id: OPERATOR_SECRET_WORKSPACE_ID,
            });
            return rows
                .map((row) => {
                const key = adminSecretKeyFromStorageKey(app_id, row.key);
                return key ? { key, updated_at: row.updated_at } : null;
            })
                .filter((row) => row !== null)
                .sort((a, b) => a.key.localeCompare(b.key));
        },
        async deleteAdminSecret(app_id, key) {
            return storage.deleteEncryptedSecret({ workspace_id: OPERATOR_SECRET_WORKSPACE_ID }, adminSecretStorageKey(app_id, key));
        },
        async setCreatorPolicy(app_id, key, policy) {
            if (policy !== 'user_vault' && policy !== 'creator_override') {
                throw new Error(`Invalid policy: ${policy}`);
            }
            await storage.setEncryptedSecret({ workspace_id: OPERATOR_SECRET_WORKSPACE_ID }, creatorPolicyStorageKey(app_id, key), await encryptSecret(kms, policy));
        },
        async getCreatorPolicy(app_id, key) {
            const row = await storage.getEncryptedSecret({ workspace_id: OPERATOR_SECRET_WORKSPACE_ID }, creatorPolicyStorageKey(app_id, key));
            if (!row)
                return null;
            return normalizePolicy(await decryptSecretRow(kms, row));
        },
        async listCreatorPolicies(app_id) {
            const rows = await storage.listEncryptedSecrets({
                workspace_id: OPERATOR_SECRET_WORKSPACE_ID,
            });
            const out = [];
            for (const row of rows) {
                const key = creatorPolicyKeyFromStorageKey(app_id, row.key);
                if (!key)
                    continue;
                const encrypted = await storage.getEncryptedSecret({ workspace_id: OPERATOR_SECRET_WORKSPACE_ID }, row.key);
                if (!encrypted)
                    continue;
                const policy = normalizePolicy(await decryptSecretRow(kms, encrypted));
                if (policy)
                    out.push({ key, policy });
            }
            return out.sort((a, b) => a.key.localeCompare(b.key));
        },
        async deleteCreatorPolicy(app_id, key) {
            return storage.deleteEncryptedSecret({ workspace_id: OPERATOR_SECRET_WORKSPACE_ID }, creatorPolicyStorageKey(app_id, key));
        },
        async loadUserVaultForRun(ctx, keys) {
            const rows = await loadEncryptedRows(storage, ctx.workspace_id, keys.map((key) => userSecretStorageKey(ctx.user_id, key)));
            return await decryptRows(kms, rows);
        },
        async loadCreatorOverrideForRun(app_id, workspace_id, keys) {
            const rows = await loadEncryptedRows(storage, workspace_id, keys.map((key) => creatorSecretStorageKey(app_id, key)));
            return await decryptRows(kms, rows);
        },
        async __setCreatorOverrideForTests(app_id, workspace_id, key, plaintext) {
            await storage.setEncryptedSecret({ workspace_id }, creatorSecretStorageKey(app_id, key), await encryptSecret(kms, plaintext));
        },
    };
    return adapter;
}
function requireSecretStorage(storage) {
    const methods = [
        'getEncryptedSecret',
        'setEncryptedSecret',
        'listEncryptedSecrets',
        'deleteEncryptedSecret',
    ];
    const missing = methods.filter((method) => typeof storage[method] !== 'function');
    if (missing.length > 0) {
        throw new Error(`GCP KMS SecretsAdapter requires encrypted secret storage methods: ${missing.join(', ')}`);
    }
    return storage;
}
async function encryptSecret(kms, plaintext) {
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
async function decryptSecretRow(kms, row) {
    if (!row.encrypted_dek) {
        throw new Error(`secret row ${row.key} is missing encrypted_dek`);
    }
    const dek = await kms.decryptDek(Buffer.from(row.encrypted_dek, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(row.nonce, 'hex'));
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'hex'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'hex')),
        decipher.final(),
    ]);
    return plaintext.toString('utf8');
}
async function decryptRows(kms, rows) {
    const out = {};
    for (const row of rows) {
        try {
            const decodedKey = decodedSecretKey(row.key);
            if (decodedKey)
                out[decodedKey] = await decryptSecretRow(kms, row);
        }
        catch {
            continue;
        }
    }
    return out;
}
async function loadEncryptedRows(storage, workspace_id, storageKeys) {
    const rows = await Promise.all(storageKeys.map((key) => storage.getEncryptedSecret({ workspace_id }, key)));
    return rows.filter((row) => row !== undefined);
}
function userSecretStorageKey(user_id, key) {
    return `user:${encodeComponent(user_id)}:${encodeComponent(key)}`;
}
function creatorSecretStorageKey(app_id, key) {
    return `creator:${encodeComponent(app_id)}:${encodeComponent(key)}`;
}
function adminSecretStorageKey(app_id, key) {
    return `admin:${encodeComponent(app_id ?? '__global__')}:${encodeComponent(key)}`;
}
function creatorPolicyStorageKey(app_id, key) {
    return `creator-policy:${encodeComponent(app_id)}:${encodeComponent(key)}`;
}
function userSecretKeyFromStorageKey(user_id, storageKey) {
    const prefix = `user:${encodeComponent(user_id)}:`;
    if (!storageKey.startsWith(prefix))
        return null;
    return decodeComponent(storageKey.slice(prefix.length));
}
function adminSecretKeyFromStorageKey(app_id, storageKey) {
    const prefix = `admin:${encodeComponent(app_id ?? '__global__')}:`;
    if (!storageKey.startsWith(prefix))
        return null;
    return decodeComponent(storageKey.slice(prefix.length));
}
function creatorPolicyKeyFromStorageKey(app_id, storageKey) {
    const prefix = `creator-policy:${encodeComponent(app_id)}:`;
    if (!storageKey.startsWith(prefix))
        return null;
    return decodeComponent(storageKey.slice(prefix.length));
}
function normalizePolicy(value) {
    if (value === 'user_vault' || value === 'creator_override')
        return value;
    return null;
}
function decodedSecretKey(storageKey) {
    const parts = storageKey.split(':');
    if (parts.length !== 3)
        return null;
    if (parts[0] !== 'user' && parts[0] !== 'creator')
        return null;
    return decodeComponent(parts[2]);
}
function encodeComponent(value) {
    return Buffer.from(value, 'utf8').toString('base64url');
}
function decodeComponent(value) {
    try {
        return Buffer.from(value, 'base64url').toString('utf8');
    }
    catch {
        return null;
    }
}
export default {
    kind: 'secrets',
    name: 'gcp-kms',
    protocolVersion: '^0.2',
    create(opts) {
        const keyName = opts.keyName ||
            process.env.FLOOM_GCP_KMS_KEY_NAME ||
            process.env.FLOOM_SECRETS_GCP_KMS_KEY_NAME ||
            (process.env.FLOOM_GCP_KMS_MOCK === '1'
                ? 'projects/test/locations/global/keyRings/test/cryptoKeys/test'
                : '');
        if (!keyName) {
            throw new Error('GCP KMS SecretsAdapter requires keyName or FLOOM_GCP_KMS_KEY_NAME');
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
