/**
 * Public-facing API base URL, for display in client components (Settings → API
 * tab, CLI snippets, webhook-URL hints).
 *
 * Reads NEXT_PUBLIC_API_BASE (inlined into the client bundle at build time) so a
 * self-hosted instance shows ITS OWN URL instead of the floom-hosted default.
 * Falls back to the cloud URL when unset. Server-side code should keep using
 * FLOOM_API_BASE via lib/server-api.ts — this helper is for what the UI displays.
 */

export const DEFAULT_PUBLIC_API_BASE = "https://workers-api.floom.dev";

/** Absolute API base URL, no trailing slash. */
export function getPublicApiBase(): string {
  const configured = (process.env.NEXT_PUBLIC_API_BASE ?? "").trim();
  const base = configured || DEFAULT_PUBLIC_API_BASE;
  return base.replace(/\/+$/, "");
}

/** Host[:port] of the API base — for display where only the host is shown. */
export function getPublicApiHost(): string {
  const base = getPublicApiBase();
  try {
    return new URL(base).host;
  } catch {
    return base.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  }
}
