// Per-app creator-owned secrets + per-key resolution policy.
//
// Two tables:
//
//   app_secret_policies(app_id, key, policy)
//     Declares whose value the runner should inject for this key on this
//     app. Missing row ⇒ default 'user_vault'.
//
//   app_creator_secrets(app_id, workspace_id, key, ciphertext, nonce, auth_tag)
//     Creator-owned value for a 'creator_override' key. Encrypted with
//     the creator's workspace DEK (reuses the W2.1 envelope scheme).
//
// See docs/DEFERRED-UI.md for the product model and routes/me_apps.ts
// for the HTTP surface. The runner (services/runner.ts) reads both
// tables before dispatching a run so the right value ends up in the
// container's environment.
import { storage } from './storage.js';
import {
  encryptValue,
  decryptValue,
  SecretDecryptError,
} from './user_secrets.js';
import type { SecretPolicy, SecretPolicyEntry } from '../types.js';

/**
 * Return the stored policy for (app_id, key), or `'user_vault'` when no
 * explicit row exists. Callers treat a missing row as "each user brings
 * their own value" so pre-existing apps keep working without action.
 */
export function getPolicy(app_id: string, key: string): SecretPolicy {
  const row = storage.getAppSecretPolicy(app_id, key);
  return (row?.policy as SecretPolicy) ?? 'user_vault';
}

/**
 * Upsert the policy for (app_id, key). Does NOT validate the key against
 * the app's manifest — the route layer is responsible for that check so
 * this helper stays usable from tests + future admin tooling without a
 * manifest lookup.
 */
export function setPolicy(
  app_id: string,
  key: string,
  policy: SecretPolicy,
): void {
  if (policy !== 'user_vault' && policy !== 'creator_override') {
    throw new Error(`Invalid policy: ${policy}`);
  }
  storage.upsertAppSecretPolicy({
    app_id,
    key,
    policy,
  });
}

/**
 * List every explicit policy row for an app. The route layer combines
 * this with `manifest.secrets_needed` to produce a complete policy view
 * (including defaulted 'user_vault' entries). Does NOT return plaintext.
 */
export function listPolicies(
  app_id: string,
): SecretPolicyEntry[] {
  const policyRows = storage.listAppSecretPolicies(app_id);
  const valueRows = storage.listAppCreatorSecrets('', app_id); // workspace_id ignored or handle it properly
  const valueKeys = new Set(valueRows.map((r) => r.key));

  return policyRows.map((r) => ({
    key: r.key,
    policy: r.policy as SecretPolicy,
    creator_has_value: valueKeys.has(r.key),
    updated_at: r.updated_at,
  }));
}

/**
 * Return a quick map telling the runner which keys have creator-owned
 * values stored. The runner joins this with the policy to decide
 * injection. Never returns plaintext.
 */
export function hasCreatorValue(app_id: string, key: string): boolean {
  const row = storage.listAppCreatorSecrets('', app_id).find(s => s.key === key);
  return !!row;
}

/**
 * Upsert the creator-owned value for (app_id, key). Encrypted with the
 * creator's workspace DEK (`workspace_id` is the app's workspace, NOT
 * the runner's). Caller is responsible for gating this to the creator
 * and for checking the key is covered by a 'creator_override' policy.
 */
export function setCreatorSecret(
  app_id: string,
  workspace_id: string,
  key: string,
  plaintext: string,
): void {
  const { ciphertext, nonce, auth_tag } = encryptValue(workspace_id, plaintext);
  storage.upsertAppCreatorSecret({
    app_id,
    workspace_id,
    key,
    ciphertext,
    nonce,
    auth_tag,
  });
}

/**
 * Delete the creator-owned value for (app_id, key). Returns true if a
 * row was removed. The policy row is left untouched so the creator can
 * flip back to 'creator_override' later without resetting their choice
 * (they'll just need to re-enter a value).
 */
export function deleteCreatorSecret(app_id: string, key: string): boolean {
  const before = storage.listAppCreatorSecrets('', app_id).length;
  storage.deleteAppCreatorSecret('', app_id, key);
  const after = storage.listAppCreatorSecrets('', app_id).length;
  return before > after;
}

/**
 * Load the plaintext values for every `creator_override` key that has a
 * stored value. Called by the runner on every dispatch; only the keys
 * the manifest actually requests are queried. Silent-skip on individual
 * decrypt errors (same pattern as user_secrets.loadForRun) so one
 * rotation mistake never blocks every subsequent run.
 *
 * `workspace_id` is the app's workspace (i.e. the creator's), not the
 * caller's. A creator-override secret encrypted with workspace A's DEK
 * must be decrypted with workspace A's DEK regardless of who runs it.
 */
export function loadCreatorSecretsForRun(
  app_id: string,
  workspace_id: string,
  keys: string[],
): Record<string, string> {
  if (keys.length === 0) return {};

  const policyRows = storage.listAppSecretPolicies(app_id);
  const overrideKeys = new Set(
    policyRows
      .filter((r) => r.policy === 'creator_override')
      .map((r) => r.key),
  );

  const targetKeys = keys.filter((k) => overrideKeys.has(k));
  if (targetKeys.length === 0) return {};

  const rows = storage.listAppCreatorSecrets('', app_id).filter(s => targetKeys.includes(s.key));

  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      // Prefer the workspace_id stored on the row (that's the DEK the value
      // was wrapped under). Fall back to the caller-supplied workspace_id
      // for legacy rows that might not carry the column yet.
      const ws = row.workspace_id || workspace_id;
      out[row.key] = decryptValue(
        ws,
        row.ciphertext,
        row.nonce,
        row.auth_tag,
      );
    } catch (err) {
      if (err instanceof SecretDecryptError) {
        // Silent on purpose: a rotation mistake on one key does not
        // cascade into "every run fails". The creator will see the
        // failure when they next try to re-read the vault UI.
        continue;
      }
      throw err;
    }
  }
  return out;
}
