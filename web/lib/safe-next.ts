const DEFAULT_NEXT = "/app";

export function safeAppNext(value: unknown, fallback = DEFAULT_NEXT): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) return fallback;
  if (trimmed.includes("\\")) return fallback;
  if (/[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed)) return fallback;
  try {
    const parsed = new URL(trimmed, "https://workers.floom.dev");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
