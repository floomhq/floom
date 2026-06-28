import { describe, expect, it } from "vitest";

import { createWorkerHref } from "@/lib/create-worker-nav";

describe("create worker navigation", () => {
  it("routes create flow to the dedicated /workers/new page", () => {
    expect(createWorkerHref()).toBe("/workers/new");
    expect(createWorkerHref("Send a daily digest")).toBe(
      "/workers/new?prompt=Send%20a%20daily%20digest",
    );
  });

  it("trims empty prompt text", () => {
    expect(createWorkerHref("   ")).toBe("/workers/new");
  });

  it("leaves Next basePath ownership to Link, router.push, and redirect", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/app";
    try {
      expect(createWorkerHref()).toBe("/workers/new");
      expect(createWorkerHref()).not.toContain("/app/app");
      expect(createWorkerHref()).not.toMatch(/^\/app(?:\/|\?)/);
    } finally {
      delete process.env.NEXT_PUBLIC_BASE_PATH;
    }
  });
});
