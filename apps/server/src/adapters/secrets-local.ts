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
//      policy. Creator policy metadata is part of the adapter surface;
//      creator secret value mutation still lives on the owner routes.
//
// Master key: `FLOOM_MASTER_KEY` (read inside user_secrets.ts). Missing
// in OSS default — the first `set` call that needs encryption will throw
// `MasterKeyError`, same as the live code path today.

import { db } from '../db.js';
import type { SecretPolicy, SessionContext } from '../types.js';
import type { SecretsAdapter } from './types.js';
import {
  get as userGet,
  set as userSet,
  del as userDel,
  listMasked as userListMasked,
  loadForRun as userLoadForRun,
} from '../services/user_secrets.js';
import { loadCreatorSecretsForRun } from '../services/app_creator_secrets.js';

export const localSecretsAdapter: SecretsAdapter = {
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
    const scopedApp = app_id ?? null;
    const existing = db
      .prepare(
        scopedApp === null
          ? 'SELECT id FROM secrets WHERE name = ? AND app_id IS NULL'
          : 'SELECT id FROM secrets WHERE name = ? AND app_id = ?',
      )
      .get(
        ...(scopedApp === null ? [key] : [key, scopedApp]),
      ) as { id: string } | undefined;
    if (existing) {
      db.prepare('UPDATE secrets SET value = ? WHERE id = ?').run(
        plaintext,
        existing.id,
      );
      return Promise.resolve();
    }
    const id =
      globalThis.crypto?.randomUUID?.() ||
      `sec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(
      'INSERT INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, ?)',
    ).run(id, key, plaintext, scopedApp);
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
    return Promise.resolve(row?.value ?? null);
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
};
