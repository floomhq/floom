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
//      policy. Only `loadCreatorOverrideForRun` is part of the adapter
//      surface today — the set/delete path for creator secrets lives on
//      dedicated routes (/api/me/apps/:slug/secrets) and isn't on the
//      generic SecretsAdapter contract.
//
// Master key: `FLOOM_MASTER_KEY` (read inside user_secrets.ts). Missing
// in OSS default — the first `set` call that needs encryption will throw
// `MasterKeyError`, same as the live code path today.

import type { SessionContext } from '../types.js';
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
