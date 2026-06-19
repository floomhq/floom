export function sanitizeRedirect(
  raw: string | null | undefined,
  fallback = "/overview",
): string {
  if (!raw || typeof raw !== "string") return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(raw)) return fallback;
  return raw;
}

