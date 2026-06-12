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

// #953 — platform-internal deployment hostnames are infrastructure identity,
// never the public API surface. The managed deploy is fronted by the stable
// alias (the default above); surfacing the raw Railway origin in Settings
// handed every member a direct-to-origin target that bypasses the proxy
// layer. A configured base on one of these domains is a deploy
// misconfiguration: fall back to the alias for everything the UI displays.
// Self-hosters on Railway should set NEXT_PUBLIC_API_BASE to their custom
// (public) domain instead of the *.up.railway.app origin.
const INTERNAL_INFRA_HOST_RE = /(^|\.)((up\.railway\.app)|(railway\.internal))$/i;

/** True when the host is a platform-internal origin that must not be shown. */
export function isInternalInfraHost(host: string): boolean {
  return INTERNAL_INFRA_HOST_RE.test(host.replace(/:\d+$/, ""));
}

/** Absolute API base URL, no trailing slash. */
export function getPublicApiBase(): string {
  const configured = (process.env.NEXT_PUBLIC_API_BASE ?? "").trim();
  const base = configured || DEFAULT_PUBLIC_API_BASE;
  try {
    if (isInternalInfraHost(new URL(base).host)) return DEFAULT_PUBLIC_API_BASE;
  } catch {
    // unparseable configured value: keep legacy behavior (string cleanup below)
  }
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
