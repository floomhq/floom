// W2.1 per-user secrets vault.
//
// AES-256-GCM envelope encryption (P.4 section 3):
//
//   FLOOM_MASTER_KEY  →  master KEK (32-byte hex, from env)
//         └─ wraps →  per-workspace DEK (32 bytes, random, persisted in
//                      workspaces.wrapped_dek as "nonce:ciphertext:authTag")
//                     └─ encrypts →  each secret value (user_secrets row,
//                                    stored as nonce/ciphertext/auth_tag)
//
// Key rotation:
//   - A user secret rotates by overwriting the row. Old ciphertext is gone.
//   - A workspace DEK rotates by decrypting every user_secrets row with the
//     old DEK, re-encrypting with a new one, then rewrapping under the
//     master KEK. This is a deliberate rewrap job, not a hot path.
//   - The master KEK rotates the same way, one workspace at a time.
//
// FLOOM_MASTER_KEY resolution order:
//   1. process.env.FLOOM_MASTER_KEY   (operator explicitly sets it)
//   2. <DATA_DIR>/.floom-master-key   (Floom generates a random 32-byte hex
//                                      key on first boot and persists it)
// The file lives in the same volume as floom-chat.db, so a `docker run -v
// floom:/data` operator gets a stable key across restarts automatically.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../db.js';
import { storage } from './storage.js';
import type { SessionContext, WorkspaceRecord } from '../types.js';

const MASTER_KEY_FILE = join(DATA_DIR, '.floom-master-key');

let cachedMasterKey: Buffer | null = null;
// Cache of unwrapped DEKs so we don't unwrap on every decrypt call.
const dekCache = new Map<string, Buffer>();

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

/**
 * Load (or initialize) the 32-byte master KEK. Resolution order:
 *   1. FLOOM_MASTER_KEY env var (hex string, 64 chars = 32 bytes)
 *   2. <DATA_DIR>/.floom-master-key file
 *   3. Generate a random 32 bytes, write to the file (mode 600), log the
 *      path once, return.
 *
 * The returned buffer MUST NOT be logged or persisted anywhere.
 */
export function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const envKey = process.env.FLOOM_MASTER_KEY;
  if (envKey && envKey.length > 0) {
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length !== 32) {
      throw new MasterKeyError(
        `FLOOM_MASTER_KEY must be a 32-byte hex string (64 chars), got ${buf.length} bytes`,
      );
    }
    cachedMasterKey = buf;
    return buf;
  }

  if (existsSync(MASTER_KEY_FILE)) {
    const raw = readFileSync(MASTER_KEY_FILE, 'utf-8').trim();
    const buf = Buffer.from(raw, 'hex');
    if (buf.length !== 32) {
      throw new MasterKeyError(
        `${MASTER_KEY_FILE} is not a 32-byte hex string (got ${buf.length} bytes)`,
      );
    }
    cachedMasterKey = buf;
    return buf;
  }

  // First boot — mint a fresh key and persist it.
  const fresh = randomBytes(32);
  writeFileSync(MASTER_KEY_FILE, fresh.toString('hex'), 'utf-8');
  try {
    chmodSync(MASTER_KEY_FILE, 0o600);
  } catch {
    // on Windows the chmod is a no-op; the file is still private enough
    // for a Docker volume.
  }
  // eslint-disable-next-line no-console
  console.log(
    `[secrets] generated new master KEK at ${MASTER_KEY_FILE} (back up this file or set FLOOM_MASTER_KEY)`,
  );
  cachedMasterKey = fresh;
  return fresh;
}

/**
 * Test helper. Clears the in-memory caches so a subsequent getMasterKey()
 * call re-reads from env/file. Exported so tests can swap keys mid-run.
 */
export function _resetForTests(): void {
  cachedMasterKey = null;
  dekCache.clear();
}

/**
 * Envelope-wrap the given plaintext DEK under the master KEK. Returns a
 * "nonce:ciphertext:authTag" string (all hex) suitable for storage in
 * workspaces.wrapped_dek.
 */
function wrapDek(dek: Buffer): string {
  const kek = getMasterKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${nonce.toString('hex')}:${ciphertext.toString('hex')}:${authTag.toString('hex')}`;
}

/**
 * Envelope-unwrap a stored wrapped DEK string. Throws SecretDecryptError
 * if the KEK is wrong or the ciphertext has been tampered with.
 */
function unwrapDek(wrapped: string): Buffer {
  const kek = getMasterKey();
  const parts = wrapped.split(':');
  if (parts.length !== 3) {
    throw new SecretDecryptError('wrapped DEK has wrong shape (expected nonce:ct:tag)');
  }
  const [nonceHex, ctHex, tagHex] = parts;
  const nonce = Buffer.from(nonceHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    throw new SecretDecryptError(
      `DEK unwrap failed: ${(err as Error).message}. ` +
        'The FLOOM_MASTER_KEY may have changed. Rotate the secret or restore the original key.',
    );
  }
}

/**
 * Load the per-workspace DEK. Generates + wraps + persists one on first
 * use if the workspaces.wrapped_dek column is NULL. Caches in memory so
 * the second call is instant.
 */
function loadWorkspaceDek(workspace_id: string): Buffer {
  const cached = dekCache.get(workspace_id);
  if (cached) return cached;

  const row = storage.getWorkspace(workspace_id);
  if (!row) {
    throw new SecretDecryptError(`workspace ${workspace_id} does not exist`);
  }

  if (row.wrapped_dek) {
    const dek = unwrapDek(row.wrapped_dek);
    dekCache.set(workspace_id, dek);
    return dek;
  }

  // First use — mint a fresh DEK, wrap it, persist, cache.
  const fresh = randomBytes(32);
  const wrapped = wrapDek(fresh);
  storage.updateWorkspace(workspace_id, { wrapped_dek: wrapped });
  dekCache.set(workspace_id, fresh);
  return fresh;
}

/**
 * Encrypt `plaintext` under the workspace DEK. Returns the tuple that lands
 * in user_secrets (all hex strings).
 *
 * Exported so sibling services (e.g. app_creator_secrets) can reuse the
 * envelope scheme without duplicating the crypto.
 */
export function encryptValue(
  workspace_id: string,
  plaintext: string,
): { ciphertext: string; nonce: string; auth_tag: string } {
  const dek = loadWorkspaceDek(workspace_id);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('hex'),
    nonce: nonce.toString('hex'),
    auth_tag: tag.toString('hex'),
  };
}

/**
 * Decrypt a stored row. Throws SecretDecryptError on tamper or wrong DEK.
 *
 * Exported alongside encryptValue so app_creator_secrets.ts can share the
 * same envelope scheme.
 */
export function decryptValue(
  workspace_id: string,
  ciphertext: string,
  nonce: string,
  auth_tag: string,
): string {
  const dek = loadWorkspaceDek(workspace_id);
  const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(nonce, 'hex'));
  decipher.setAuthTag(Buffer.from(auth_tag, 'hex'));
  try {
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'hex')),
      decipher.final(),
    ]);
    return pt.toString('utf-8');
  } catch (err) {
    throw new SecretDecryptError(
      `secret decrypt failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Get a single secret by key. Returns the plaintext, or null if unset.
 * Never logs the plaintext.
 */
export function get(ctx: SessionContext, key: string): string | null {
  const row = storage.listUserSecrets(ctx.workspace_id, ctx.user_id).find(s => s.key === key);
  if (!row) return null;
  return decryptValue(ctx.workspace_id, row.ciphertext, row.nonce, row.auth_tag);
}

/**
 * Set (upsert) a secret. `plaintext` is encrypted under the workspace DEK
 * and persisted; the plaintext is never logged or echoed back.
 */
export function set(ctx: SessionContext, key: string, plaintext: string): void {
  const { ciphertext, nonce, auth_tag } = encryptValue(ctx.workspace_id, plaintext);
  storage.upsertUserSecret({
    workspace_id: ctx.workspace_id,
    user_id: ctx.user_id,
    key,
    ciphertext,
    nonce,
    auth_tag,
  });
}

/**
 * Delete a single secret. Returns true if a row was removed.
 */
export function del(ctx: SessionContext, key: string): boolean {
  const before = storage.listUserSecrets(ctx.workspace_id, ctx.user_id).length;
  storage.deleteUserSecret(ctx.workspace_id, ctx.user_id, key);
  const after = storage.listUserSecrets(ctx.workspace_id, ctx.user_id).length;
  return before > after;
}

/**
 * List the keys the user has populated, masked. Returns only the key names
 * and masked previews ("****") so the UI can show a list without leaking
 * plaintext. Use `get()` for a single-key unmask when the user explicitly
 * asks.
 */
export function listMasked(ctx: SessionContext): { key: string; updated_at: string }[] {
  return storage.listUserSecrets(ctx.workspace_id, ctx.user_id).map(s => ({
    key: s.key,
    updated_at: s.updated_at,
  }));
}

/**
 * Load all secrets for a run as a plaintext map. Called by the runner
 * before dispatch so persisted user credentials are merged into the
 * secrets bag before the per-call _auth override takes precedence.
 *
 * Filtered to `keys` so the runner only injects the secret names the
 * manifest declared (prevents leaking unrelated credentials into an app
 * that doesn't need them).
 */
export function loadForRun(
  ctx: SessionContext,
  keys: string[],
): Record<string, string> {
  if (keys.length === 0) return {};
  const rows = storage.listUserSecrets(ctx.workspace_id, ctx.user_id).filter(s => keys.includes(s.key));
  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      out[row.key] = decryptValue(
        ctx.workspace_id,
        row.ciphertext,
        row.nonce,
        row.auth_tag,
      );
    } catch {
      // A row that fails to decrypt is silently skipped so a single
      // rotation mistake doesn't blow up every subsequent run. The
      // operator can rewrap or re-set the value via the vault UI.
    }
  }
  return out;
}

/**
 * Return the workspace row (or undefined). Exposed for the vault UI which
 * needs to know whether a wrapped_dek is present (for rewrap visibility).
 */
export function getWorkspace(workspace_id: string): WorkspaceRecord | undefined {
  return storage.getWorkspace(workspace_id);
}
