/** Pure Brain (contexts) formatting helpers. */

export function formatBytes(n?: number): string {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A folder is a worker memory child when its name matches the `memory-<slug>`
 * convention. Canonical rule shared by the Library tree (BrainCollection) and
 * the worker "Attach a folder" dropdown so both group memory packs identically.
 * The bare `memory` name is the synthetic parent, not a child.
 */
export function isWorkerMemoryContext(name: string): boolean {
  return /^memory-[a-z0-9][a-z0-9._-]*$/i.test(name);
}

/** A folder's writeability key for the status tag family. */
export function writeKey(c: { read_only?: boolean; writeable?: boolean }): "read-only" | "writeable" {
  if (c.read_only) return "read-only";
  return c.writeable ? "writeable" : "read-only";
}
