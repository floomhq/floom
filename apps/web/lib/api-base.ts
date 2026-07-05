/**
 * Public-facing API base URL, for display in client components (Settings → API
 * tab, CLI snippets, webhook-URL hints).
 *
 * Reads NEXT_PUBLIC_API_BASE (inlined into the client bundle at build time) so a
 * self-hosted instance shows its own URL. Server-side code should keep using
 * FLOOM_API_BASE via lib/server-api.ts — this helper is for what the UI displays.
 */

export const DEFAULT_PUBLIC_API_BASE = "http://localhost:8000";
export const DEFAULT_CLOUD_PUBLIC_API_BASE = "https://workeros-api.floom.dev";

/** True when the dashboard is the managed Cloud wrapper (not self-hosted OSS). */
export function isCloudDeploy(): boolean {
  return process.env.NEXT_PUBLIC_WORKEROS_DEPLOY === "cloud";
}

function defaultPublicApiBase(): string {
  return isCloudDeploy() ? DEFAULT_CLOUD_PUBLIC_API_BASE : DEFAULT_PUBLIC_API_BASE;
}

// #953 — platform-internal deployment hostnames are infrastructure identity,
// never the public API surface. The managed deploy is fronted by the stable
// alias (the default above); surfacing the raw platform origin in Settings
// handed every member a direct-to-origin target that bypasses the proxy
// layer. A configured base on one of these domains is a deploy
// misconfiguration: fall back to the alias for everything the UI displays.
// Self-hosters on platforms with internal origins should set
// NEXT_PUBLIC_API_BASE to their custom public domain.
const INTERNAL_INFRA_HOST_RE = /(^|\.)((up\.railway\.app)|(railway\.internal))$/i;

/** True when the host is a platform-internal origin that must not be shown. */
export function isInternalInfraHost(host: string): boolean {
  return INTERNAL_INFRA_HOST_RE.test(host.replace(/:\d+$/, ""));
}

/** Absolute API base URL, no trailing slash. */
export function getPublicApiBase(): string {
  const configured = (
    process.env.NEXT_PUBLIC_API_BASE ??
    (isCloudDeploy() ? process.env.NEXT_PUBLIC_WORKEROS_API_BASE : undefined) ??
    ""
  ).trim();
  const base = configured || defaultPublicApiBase();
  try {
    if (isInternalInfraHost(new URL(base).host)) return defaultPublicApiBase();
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

// Canonical public origin of the dashboard apex (managed Cloud is fronted by
// floom.dev). Used to build absolute shareable URLs (og:image, canonical) that
// scrapers can fetch — a relative path resolved against Next's metadataBase
// falls back to the raw platform deployment alias (e.g. r9-detail…vercel.app),
// which 404s cross-project and is infra identity, never the public surface.
export const DEFAULT_CLOUD_PUBLIC_SITE_ORIGIN = "https://floom.dev";

/**
 * Absolute public site origin — scheme + host only, no path, no trailing slash.
 *
 * Priority: explicit `NEXT_PUBLIC_SITE_ORIGIN` (self-host override) → the
 * managed Cloud apex → the request host (self-host zero-config) → the Cloud
 * apex as a safe last resort. On Cloud the apex is returned directly, so a
 * per-deployment platform alias (r9-detail…) is never surfaced; the request-host
 * branch additionally drops internal infra hosts, mirroring getPublicApiBase().
 *
 * @param requestHost optional `Host`/`x-forwarded-host` from the inbound request
 */
export function getPublicSiteOrigin(requestHost?: string | null): string {
  const configured = process.env.NEXT_PUBLIC_SITE_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (isCloudDeploy()) return DEFAULT_CLOUD_PUBLIC_SITE_ORIGIN;
  const host = requestHost?.trim();
  if (host && !isInternalInfraHost(host)) {
    const local = /^(localhost|127\.|\[::1\])/i.test(host);
    return `${local ? "http" : "https"}://${host}`;
  }
  return DEFAULT_CLOUD_PUBLIC_SITE_ORIGIN;
}
