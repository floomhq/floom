/** UUID-shaped pattern: 8-4-4-4-12 hex */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveWorkspaceName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return "My workspace";
  if (UUID_RE.test(trimmed)) return "My workspace";
  return trimmed;
}

/** True when the value is a bare UUID (so it must never be shown to a user). */
export function isUuid(value: string | null | undefined): boolean {
  return UUID_RE.test((value ?? "").trim());
}

/**
 * Resolve a human-readable label for a person/owner from a list of candidate
 * fields (username, email, display_name, …). Skips empty and UUID-shaped
 * candidates so a raw owner/user UUID never leaks into user-facing UI
 * (#1728). Falls back to the given label ("You" / "Local user") when no
 * candidate is human-readable.
 */
export function resolveUserLabel(
  candidates: Array<string | null | undefined>,
  fallback = "You",
): string {
  for (const c of candidates) {
    const trimmed = c?.trim() ?? "";
    if (trimmed && !UUID_RE.test(trimmed)) return trimmed;
  }
  return fallback;
}
