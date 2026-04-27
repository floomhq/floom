// Local (AES-GCM + SQLite) secrets adapter wrapper.
//
// Wraps the reference encrypted-secrets services so they satisfy the
// `SecretsAdapter` interface declared in `adapters/types.ts`.
//
// Two stores are composed:
//   1. `services/user_secrets.ts` — per-(workspace, user) vault. Keys
//      the running user owns. get/set/delete/list/loadUserVaultForRun
//      all map 1:1 to existing exports.
//   2. `services/app_creator_secrets.ts` — per-(app, creator) override
//      vault. Keys the app's creator owns via a `creator_override`
//      policy. Creator policy metadata and value mutation are both part of
//      the adapter surface.
//
// Master key: `FLOOM_MASTER_KEY` (read inside user_secrets.ts). Missing
// in OSS default — the first `set` call that needs encryption will throw
// `MasterKeyError`, same as the live code path today.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { db } from '../db.js';
import type { SecretPolicy, SessionContext } from '../types.js';
import type { SecretsAdapter } from './types.js';
import {
  get as userGet,
  set as userSet,
  del as userDel,
  listMasked as userListMasked,
  loadForRun as userLoadForRun,
  decryptValue,
  getMasterKey,
} from '../services/user_secrets.js';
import {
  loadCreatorSecretsForRun,
  setCreatorSecret,
} from '../services/app_creator_secrets.js';

type LocalSecretsAdapter = SecretsAdapter & {
  __setCreatorOverrideForTests(
    app_id: string,
    workspace_id: string,
    key: string,
    plaintext: string,
  ): Promise<void>;
};

const ADMIN_SECRET_ENVELOPE_PREFIX = 'floom:aes-gcm:v1:';

function encryptAdminSecret(plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getMasterKey(), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${ADMIN_SECRET_ENVELOPE_PREFIX}${nonce.toString('hex')}:${ciphertext.toString('hex')}:${authTag.toString('hex')}`;
}

function decryptAdminSecret(envelope: string): string {
  if (!envelope.startsWith(ADMIN_SECRET_ENVELOPE_PREFIX)) {
    return envelope;
  }
  const encoded = envelope.slice(ADMIN_SECRET_ENVELOPE_PREFIX.length);
  const parts = encoded.split(':');
  if (parts.length !== 3) {
    throw new Error('admin secret envelope has wrong shape');
  }
  const [nonceHex, ciphertextHex, authTagHex] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    getMasterKey(),
    Buffer.from(nonceHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

function writeAdminSecretValue(
  app_id: string | null,
  key: string,
  value: string,
): void {
  const scopedApp = app_id ?? null;
  const existing = db
    .prepare(
      scopedApp === null
        ? 'SELECT id FROM secrets WHERE name = ? AND app_id IS NULL'
        : 'SELECT id FROM secrets WHERE name = ? AND app_id = ?',
    )
    .get(...(scopedApp === null ? [key] : [key, scopedApp])) as
    | { id: string }
    | undefined;
  if (existing) {
    db.prepare('UPDATE secrets SET value = ? WHERE id = ?').run(
      value,
      existing.id,
    );
    return;
  }
  const id =
    globalThis.crypto?.randomUUID?.() ||
    `sec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    'INSERT INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, ?)',
  ).run(id, key, value, scopedApp);
}

export const localSecretsAdapter: LocalSecretsAdapter = {
  get(ctx: SessionContext, key: string): Promise<string | null> {
    return Promise.resolve(userGet(ctx, key));
  },

  set(ctx: SessionContext, key: string, plaintext: string): Promise<void> {
    return Promise.resolve(userSet(ctx, key, plaintext));
  },

  delete(ctx: SessionContext, key: string): Promise<boolean> {
    return Promise.resolve(userDel(ctx, key));
  },

  list(ctx: SessionContext): Promise<Array<{ key: string; updated_at: string }>> {
    return Promise.resolve(userListMasked(ctx));
  },

  setAdminSecret(
    app_id: string | null,
    key: string,
    plaintext: string,
  ): Promise<void> {
    writeAdminSecretValue(app_id, key, encryptAdminSecret(plaintext));
    return Promise.resolve();
  },

  getAdminSecret(app_id: string | null, key: string): Promise<string | null> {
    const scopedApp = app_id ?? null;
    const row = db
      .prepare(
        scopedApp === null
          ? 'SELECT value FROM secrets WHERE name = ? AND app_id IS NULL'
          : 'SELECT value FROM secrets WHERE name = ? AND app_id = ?',
      )
      .get(
        ...(scopedApp === null ? [key] : [key, scopedApp]),
      ) as { value: string } | undefined;
    if (!row) return Promise.resolve(null);
    const plaintext = decryptAdminSecret(row.value);
    if (!row.value.startsWith(ADMIN_SECRET_ENVELOPE_PREFIX)) {
      writeAdminSecretValue(scopedApp, key, encryptAdminSecret(plaintext));
    }
    return Promise.resolve(plaintext);
  },

  listAdminSecrets(
    app_id: string | null,
  ): Promise<Array<{ key: string; updated_at: string }>> {
    const scopedApp = app_id ?? null;
    const rows = db
      .prepare(
        scopedApp === null
          ? 'SELECT name, created_at FROM secrets WHERE app_id IS NULL ORDER BY name'
          : 'SELECT name, created_at FROM secrets WHERE app_id = ? ORDER BY name',
      )
      .all(...(scopedApp === null ? [] : [scopedApp])) as {
      name: string;
      created_at: string;
    }[];
    return Promise.resolve(
      rows.map((row) => ({ key: row.name, updated_at: row.created_at })),
    );
  },

  deleteAdminSecret(app_id: string | null, key: string): Promise<boolean> {
    const scopedApp = app_id ?? null;
    const res = db
      .prepare(
        scopedApp === null
          ? 'DELETE FROM secrets WHERE name = ? AND app_id IS NULL'
          : 'DELETE FROM secrets WHERE name = ? AND app_id = ?',
      )
      .run(...(scopedApp === null ? [key] : [key, scopedApp]));
    return Promise.resolve(res.changes > 0);
  },

  setCreatorPolicy(
    app_id: string,
    key: string,
    policy: SecretPolicy,
  ): Promise<void> {
    if (policy !== 'user_vault' && policy !== 'creator_override') {
      throw new Error(`Invalid policy: ${policy}`);
    }
    db.prepare(
      `INSERT INTO app_secret_policies (app_id, key, policy, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (app_id, key)
         DO UPDATE SET policy = excluded.policy,
                       updated_at = datetime('now')`,
    ).run(app_id, key, policy);
    return Promise.resolve();
  },

  getCreatorPolicy(app_id: string, key: string): Promise<SecretPolicy | null> {
    const row = db
      .prepare(
        `SELECT policy FROM app_secret_policies WHERE app_id = ? AND key = ?`,
      )
      .get(app_id, key) as { policy: SecretPolicy } | undefined;
    return Promise.resolve(row?.policy ?? null);
  },

  listCreatorPolicies(
    app_id: string,
  ): Promise<Array<{ key: string; policy: SecretPolicy }>> {
    const rows = db
      .prepare(
        `SELECT key, policy FROM app_secret_policies
          WHERE app_id = ?
          ORDER BY key`,
      )
      .all(app_id) as { key: string; policy: SecretPolicy }[];
    return Promise.resolve(rows);
  },

  deleteCreatorPolicy(app_id: string, key: string): Promise<boolean> {
    const res = db
      .prepare(
        `DELETE FROM app_secret_policies WHERE app_id = ? AND key = ?`,
      )
      .run(app_id, key);
    return Promise.resolve(res.changes > 0);
  },

  loadUserVaultForRun(
    ctx: SessionContext,
    keys: string[],
  ): Promise<Record<string, string>> {
    return Promise.resolve(userLoadForRun(ctx, keys));
  },

  loadCreatorOverrideForRun(
    app_id: string,
    workspace_id: string,
    keys: string[],
  ): Promise<Record<string, string>> {
    return Promise.resolve(loadCreatorSecretsForRun(app_id, workspace_id, keys));
  },

  setCreatorOverrideSecret(
    ctx: { workspace_id: string },
    appId: string,
    envKey: string,
    plaintext: string,
  ): Promise<void> {
    setCreatorSecret(appId, ctx.workspace_id, envKey, plaintext);
    return Promise.resolve();
  },

  getCreatorOverrideSecret(
    ctx: { workspace_id: string },
    appId: string,
    envKey: string,
  ): Promise<string | null> {
    const row = db
      .prepare(
        `SELECT workspace_id, ciphertext, nonce, auth_tag
           FROM app_creator_secrets
          WHERE app_id = ?
            AND key = ?
            AND workspace_id = ?`,
      )
      .get(appId, envKey, ctx.workspace_id) as
      | {
          workspace_id: string;
          ciphertext: string;
          nonce: string;
          auth_tag: string;
        }
      | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve(
      decryptValue(row.workspace_id, row.ciphertext, row.nonce, row.auth_tag),
    );
  },

  listCreatorOverrideSecretsForRun(
    ctx: { workspace_id: string },
    appId: string,
    envKeys: string[],
  ): Promise<Record<string, string>> {
    return Promise.resolve(
      loadCreatorSecretsForRun(appId, ctx.workspace_id, envKeys),
    );
  },

  deleteCreatorOverrideSecret(
    ctx: { workspace_id: string },
    appId: string,
    envKey: string,
  ): Promise<boolean> {
    const res = db
      .prepare(
        `DELETE FROM app_creator_secrets
          WHERE app_id = ?
            AND key = ?
            AND workspace_id = ?`,
      )
      .run(appId, envKey, ctx.workspace_id);
    return Promise.resolve(res.changes > 0);
  },

  __setCreatorOverrideForTests(
    app_id: string,
    workspace_id: string,
    key: string,
    plaintext: string,
  ): Promise<void> {
    setCreatorSecret(app_id, workspace_id, key, plaintext);
    return Promise.resolve();
  },
};
