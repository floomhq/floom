import { describe, expect, it } from "vitest";

import { createWorkerHref } from "@/lib/create-worker-nav";

describe("create worker navigation", () => {
  it("keeps OSS create flow at the root app", () => {
    expect(createWorkerHref()).toBe("/?create=1");
    expect(createWorkerHref("Send a daily digest")).toBe(
      "/?create=1&prime=Send%20a%20daily%20digest",
    );
  });

  it("leaves Next basePath ownership to Link, router.push, and redirect", () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/app";
    try {
      expect(createWorkerHref()).toBe("/?create=1");
      expect(createWorkerHref()).not.toContain("/app/app");
      expect(createWorkerHref()).not.toMatch(/^\/app(?:\/|\?)/);
    } finally {
      delete process.env.NEXT_PUBLIC_BASE_PATH;
    }
  });
});
