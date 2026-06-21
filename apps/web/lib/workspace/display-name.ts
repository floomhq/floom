/** UUID-shaped pattern: 8-4-4-4-12 hex */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveWorkspaceName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return "My workspace";
  if (UUID_RE.test(trimmed)) return "My workspace";
  return trimmed;
}

/** True when the value is a bare UUID (never a human-facing label). */
export function isUuid(value: string | null | undefined): boolean {
  return UUID_RE.test((value ?? "").trim());
}

/**
 * #1728 — resolve a user-facing label from candidate fields, skipping empties
 * and bare UUIDs so a raw user id never leaks into the UI (footer, connection
 * Owner, etc.). Returns `fallback` when no real label is available.
 */
export function resolveUserLabel(
  candidates: Array<string | null | undefined>,
  fallback = "Local user",
): string {
  for (const candidate of candidates) {
    const trimmed = (candidate ?? "").trim();
    if (trimmed && !UUID_RE.test(trimmed)) return trimmed;
  }
  return fallback;
}
