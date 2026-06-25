import { describe, expect, it } from "vitest";

import { createWorkerHref } from "@/lib/create-worker-nav";

describe("create worker navigation", () => {
  // Product decision (2026-06-24): "New worker" drives the IN-EMILY create flow
  // (`/?create=1`, handled by EmilyDock) that supersedes the active Emily chat
  // in place — it must NOT route to the separate /workers/new page.
  it("routes the create flow to the in-Emily ?create=1 deep link", () => {
    expect(createWorkerHref()).toBe("/?create=1");
    expect(createWorkerHref("Send a daily digest")).toBe(
      "/?create=1&prime=Send%20a%20daily%20digest",
    );
  });

  it("does not route to the separate /workers/new page", () => {
    expect(createWorkerHref()).not.toContain("/workers/new");
    expect(createWorkerHref("x")).not.toContain("/workers/new");
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
