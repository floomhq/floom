// Persistence constants + cold-start detection for the TanStack Query cache.
//
// Kept in its own module (no "use client") so both the QueryProvider and the
// boot splash gate can share the localStorage key and the warm/cold decision
// without circular imports.

export const PERSIST_STORAGE_KEY = "floom-query-cache";

// Bump BUSTER on any deploy that alters a persisted query's data shape so the
// old localStorage cache is discarded instead of hydrating a stale shape.
export const PERSIST_BUSTER = "floom-cache-v1";

// 24h: how long a persisted cache may live before the persister discards it.
// The QueryClient gcTime must be >= this, or react-query evicts entries before
// they can be restored on the next reload.
export const PERSIST_MAX_AGE = 24 * 60 * 60_000;

// Query-key root prefixes that are safe to persist. These are the dashboard's
// read-only list/overview surfaces. Deliberately excluded: secret VALUES (the
// secrets list carries metadata only, no values), one-off detail fetches, and
// any volatile/sensitive payload. Persisting only the known list surfaces keeps
// the localStorage footprint small and intentional on this auth-gated dashboard.
export const PERSISTABLE_KEY_PREFIXES = [
  "system", // overview
  "workers",
  "connections",
  "secrets", // metadata only (names/status), never secret values
  "runs",
] as const;

// True when a usable persisted cache already exists in localStorage at boot.
// Used by the splash gate to distinguish a WARM start (cache present → render
// immediately, no splash) from a true COLD start (no cache → show the branded
// splash until the first critical query resolves). Read once, synchronously,
// before paint — never inside render-on-every-keystroke paths.
export function hasPersistedCache(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(PERSIST_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as {
      buster?: string;
      timestamp?: number;
      clientState?: { queries?: unknown[] };
    };
    // Stale buster or expired age → treat as cold (the persister will discard it).
    if (parsed.buster !== PERSIST_BUSTER) return false;
    if (typeof parsed.timestamp === "number" && Date.now() - parsed.timestamp > PERSIST_MAX_AGE) {
      return false;
    }
    const queries = parsed.clientState?.queries;
    return Array.isArray(queries) && queries.length > 0;
  } catch {
    return false;
  }
}
