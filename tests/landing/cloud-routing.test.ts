import { readFileSync } from "node:fs";
import path from "node:path";
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

    const redirects = config.redirects ? await config.redirects() : [];
    expect(redirects).toContainEqual({
      source: "/",
      has: [
        { type: "query", key: "create", value: "(?<create>.+)" },
        { type: "query", key: "prime", value: "(?<prime>.+)" },
      ],
      destination: "/app?create=:create&prime=:prime",
      permanent: false,
    });
    expect(redirects).toContainEqual({
      source: "/",
      has: [{ type: "query", key: "create", value: "(?<create>.+)" }],
      destination: "/app?create=:create",
      permanent: false,
    });
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

  it("defaults app rewrites to the canonical dashboard production domain", async () => {
    const config = (await import("../../next.config")).default;
    const dashboard = "https://r9-detail.floom.dev";
    const staleDashboardHosts = [
      ["workeros-cloud-dashboard", "three.vercel.app"].join("-"),
      [["web", "iota", "five"].join("-"), "12.vercel.app"].join("-"),
      "workeros-cloud-dashboard.vercel.app",
    ];

    const rewrites = config.rewrites ? await config.rewrites() : [];
    expect(rewrites).toContainEqual({
      source: "/cli-auth",
      destination: `${dashboard}/app/cli-auth`,
    });

    const vercelConfig = JSON.parse(
      readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"),
    ) as { rewrites?: Array<{ source: string; destination: string }> };
    expect(vercelConfig.rewrites).toContainEqual({
      source: "/app",
      destination: `${dashboard}/app`,
    });
    expect(vercelConfig.rewrites).toContainEqual({
      source: "/app/:path*",
      destination: `${dashboard}/app/:path*`,
    });

    const routingConfig = JSON.stringify({ rewrites, vercelConfig });
    for (const host of staleDashboardHosts) {
      expect(routingConfig).not.toContain(host);
    }
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
