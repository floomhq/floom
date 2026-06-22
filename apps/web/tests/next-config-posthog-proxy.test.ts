import { afterEach, describe, expect, it, vi } from "vitest";

// PostHog first-party reverse proxy (#1724 follow-up). The rewrites make
// ingestion same-origin under /ingest/* so CSP `connect-src 'self'` covers it
// with no PostHog domain in the allowlist (and ad-blockers can't drop events).

type Rewrite = { source: string; destination: string };

async function loadConfig(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import("../next.config")).default;
}

async function loadRewrites(env: Record<string, string | undefined> = {}) {
  const config = await loadConfig(env);
  const rewrites = config.rewrites ? await config.rewrites() : [];
  return rewrites as Rewrite[];
}

const PROXY_ENV_KEYS = [
  "POSTHOG_PROXY_PATH",
  "POSTHOG_PROXY_INGEST_HOST",
  "POSTHOG_PROXY_ASSETS_HOST",
];

describe("next.config PostHog reverse proxy", () => {
  afterEach(() => {
    for (const k of PROXY_ENV_KEYS) delete process.env[k];
    vi.resetModules();
  });

  it("skipTrailingSlashRedirect is set (PostHog requires exact trailing slashes)", async () => {
    const config = await loadConfig();
    expect(config.skipTrailingSlashRedirect).toBe(true);
  });

  it("rewrites /ingest/static/* and /ingest/array/* to the PostHog assets host", async () => {
    const rewrites = await loadRewrites();
    expect(rewrites).toContainEqual({
      source: "/ingest/static/:path*",
      destination: "https://us-assets.i.posthog.com/static/:path*",
    });
    expect(rewrites).toContainEqual({
      source: "/ingest/array/:path*",
      destination: "https://us-assets.i.posthog.com/array/:path*",
    });
  });

  it("rewrites the /ingest/* catch-all to the PostHog ingestion host", async () => {
    const rewrites = await loadRewrites();
    expect(rewrites).toContainEqual({
      source: "/ingest/:path*",
      destination: "https://us.i.posthog.com/:path*",
    });
  });

  it("orders the asset rules before the /ingest/* catch-all", async () => {
    const rewrites = await loadRewrites();
    const idx = (src: string) => rewrites.findIndex((r) => r.source === src);
    const staticIdx = idx("/ingest/static/:path*");
    const arrayIdx = idx("/ingest/array/:path*");
    const catchAllIdx = idx("/ingest/:path*");
    expect(staticIdx).toBeGreaterThanOrEqual(0);
    expect(arrayIdx).toBeGreaterThanOrEqual(0);
    expect(catchAllIdx).toBeGreaterThan(staticIdx);
    expect(catchAllIdx).toBeGreaterThan(arrayIdx);
  });

  it("honors EU / self-hosted host + path overrides", async () => {
    const rewrites = await loadRewrites({
      POSTHOG_PROXY_PATH: "/ph",
      POSTHOG_PROXY_INGEST_HOST: "https://eu.i.posthog.com",
      POSTHOG_PROXY_ASSETS_HOST: "https://eu-assets.i.posthog.com",
    });
    expect(rewrites).toContainEqual({
      source: "/ph/static/:path*",
      destination: "https://eu-assets.i.posthog.com/static/:path*",
    });
    expect(rewrites).toContainEqual({
      source: "/ph/:path*",
      destination: "https://eu.i.posthog.com/:path*",
    });
  });
});
