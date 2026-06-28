import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createWorkerHref } from "@/lib/create-worker-nav";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("New worker entry points", () => {
  it("createWorkerHref drives the dedicated /workers/new flow", () => {
    expect(createWorkerHref()).toBe("/workers/new");
    expect(createWorkerHref("Daily digest")).toBe("/workers/new?prompt=Daily%20digest");
  });

  it("sidebar primary CTA routes via createWorkerHref", () => {
    expect(src("components/layout/sidebar.tsx")).toContain("createWorkerHref()");
  });

  it("command palette and workers collection use createWorkerHref", () => {
    expect(src("components/CommandPalette.tsx")).toContain("go(createWorkerHref())");
    expect(src("app/workers/WorkersCollection.tsx")).toContain("createWorkerHref()");
  });

  it("/workers/new is a real page, not a redirect to Emily", () => {
    const page = src("app/workers/new/page.tsx");
    expect(page).toContain("NewWorkerClient");
    expect(page).not.toContain("redirect(`/?");
  });

  it("dedicated page owns prompt-to-worker creation", () => {
    const client = src("app/workers/new/NewWorkerClient.tsx");
    expect(client).toContain("api.workers.newFromPrompt");
    expect(client).toContain('mode: "create"');
  });

  it("Emily stays docked on /workers/new", () => {
    expect(src("components/emily/EmilyChat.tsx")).toContain("isCreateWorkerRoute");
  });
});
