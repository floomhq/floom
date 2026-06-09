/** Pure Brain (contexts) formatting helpers. */

export function formatBytes(n?: number): string {
  if (!n || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A folder's writeability key for the status tag family. */
export function writeKey(c: { read_only?: boolean; writeable?: boolean }): "read-only" | "writeable" {
  if (c.read_only) return "read-only";
  return c.writeable ? "writeable" : "read-only";
}
