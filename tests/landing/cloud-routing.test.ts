import { afterEach, describe, expect, it, vi } from "vitest";

describe("Cloud app routing", () => {
  afterEach(() => {
    delete process.env.CLOUD_DASHBOARD_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    vi.resetModules();
  });

  it("rewrites Cloud app routes to the Cloud dashboard and never to the OSS domain", async () => {
    process.env.CLOUD_DASHBOARD_URL = "https://cloud-dashboard.example.com";
    const config = (await import("../../next.config")).default;

    expect(config.redirects).toBeUndefined();
    const rewrites = config.rewrites ? await config.rewrites() : [];
    expect(rewrites).toContainEqual({
      source: "/app",
      destination: "https://cloud-dashboard.example.com/app",
    });
    expect(rewrites).toContainEqual({
      source: "/app/:path*",
      destination: "https://cloud-dashboard.example.com/app/:path*",
    });
    expect(rewrites).toContainEqual({
      source: "/workers/:path*",
      destination: "https://cloud-dashboard.example.com/app/workers/:path*",
    });
    expect(JSON.stringify(rewrites)).not.toContain("workers.floom.dev");
  });

  it("keeps landing app URLs relative by default and ignores the legacy OSS host", async () => {
    let mod = await import("../../lib/app-url");
    expect(mod.appUrl("/workers/new", { prompt: "draft job" })).toBe("/workers/new?prompt=draft+job");

    vi.resetModules();
    process.env.NEXT_PUBLIC_APP_URL = "https://workers.floom.dev";
    mod = await import("../../lib/app-url");
    expect(mod.appUrl("/workers/new")).toBe("/workers/new");
  });
});

