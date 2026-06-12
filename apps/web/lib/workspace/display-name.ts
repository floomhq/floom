/** UUID-shaped pattern: 8-4-4-4-12 hex */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveWorkspaceName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return "My workspace";
  if (UUID_RE.test(trimmed)) return "My workspace";
  return trimmed;
}
