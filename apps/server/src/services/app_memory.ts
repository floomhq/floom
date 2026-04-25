// W2.1 per-user app memory.
//
// A single JSON blob store keyed by (workspace_id, app_slug, user_id, key).
// Creators declare `memory_keys: [foo, bar]` in their manifest; Floom gates
// get/set to the declared list. Values are JSON-encoded strings.
//
// Storage path:
//   POST /api/memory/:app_slug body={key, value}
//     → appMemory.set(ctx, app_slug, key, value)
//     → UPSERT into app_memory with device_id from ctx
//
// Retrieval path (runner inject):
//   ctx built by middleware → loadAppMemoryForRun(ctx, app_slug)
//     → returns Record<string, unknown> ready to merge into run inputs
//
// The `device_id` column stays populated so the re-key transaction can
// find these rows on login (see session.ts rekeyDevice).
import { storage } from './storage.js';
import type { NormalizedManifest, SessionContext } from '../types.js';

export class MemoryKeyNotAllowedError extends Error {
  public readonly key: string;
  public readonly allowed: string[];
  constructor(key: string, allowed: string[]) {
    super(
      `Memory key "${key}" is not declared in the app manifest's memory_keys list. ` +
        `Allowed: ${allowed.length === 0 ? '(none)' : allowed.join(', ')}`,
    );
    this.name = 'MemoryKeyNotAllowedError';
    this.key = key;
    this.allowed = allowed;
  }
}

function assertAllowed(manifest: NormalizedManifest | null, key: string): void {
  const allowed = manifest?.memory_keys || [];
  if (!allowed.includes(key)) {
    throw new MemoryKeyNotAllowedError(key, allowed);
  }
}

/**
 * Load the manifest for an app slug. Returns null if the app doesn't exist
 * or the manifest is corrupted. Pure helper — doesn't touch ctx.
 */
function loadManifest(app_slug: string): NormalizedManifest | null {
  const app = storage.getApp(app_slug);
  if (!app) return null;
  try {
    return JSON.parse(app.manifest || '{}') as NormalizedManifest;
  } catch {
    return null;
  }
}

/**
 * Get a single memory value. Returns null if unset. Throws
 * MemoryKeyNotAllowedError if the key is not declared in the manifest.
 */
export function get(
  ctx: SessionContext,
  app_slug: string,
  key: string,
): unknown | null {
  assertAllowed(loadManifest(app_slug), key);
  const value = storage.getAppMemory(ctx.workspace_id, app_slug, ctx.user_id, key);
  if (value === undefined) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Upsert a memory value. Rejects if the key is not in the manifest's
 * declared memory_keys list.
 */
export function set(
  ctx: SessionContext,
  app_slug: string,
  key: string,
  value: unknown,
): void {
  assertAllowed(loadManifest(app_slug), key);
  const json = JSON.stringify(value ?? null);
  storage.setAppMemory({
    workspace_id: ctx.workspace_id,
    app_slug,
    user_id: ctx.user_id,
    device_id: ctx.device_id,
    key,
    value: json,
  });
}

/**
 * Remove a single memory key.
 */
export function del(
  ctx: SessionContext,
  app_slug: string,
  key: string,
): boolean {
  // No manifest check on delete — if the manifest changed and a key was
  // removed, we still want the user to be able to clean it up.
  return storage.deleteAppMemory(ctx.workspace_id, app_slug, ctx.user_id, key);
}

/**
 * List all memory entries for this (workspace, user, app). Returns a plain
 * object keyed by the stored `key` column, with parsed JSON values.
 */
export function list(
  ctx: SessionContext,
  app_slug: string,
): Record<string, unknown> {
  const rows = storage.listAppMemory(ctx.workspace_id, app_slug, ctx.user_id);
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

/**
 * Load all declared-and-populated memory for a run. Called by the runner
 * before dispatch so the app's handler sees a prepopulated state bag.
 * Only keys declared in the manifest's memory_keys are returned — if the
 * creator narrows the list in a new manifest version, stale keys stay in
 * the DB but aren't injected.
 */
export function loadForRun(
  ctx: SessionContext,
  app_slug: string,
): Record<string, unknown> {
  const manifest = loadManifest(app_slug);
  const allowed = manifest?.memory_keys || [];
  if (allowed.length === 0) return {};
  const rows = storage.listAppMemoryKeys(ctx.workspace_id, app_slug, ctx.user_id, allowed);
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}
