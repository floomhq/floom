import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("New worker entry points", () => {
  it("sidebar primary CTA routes via createWorkerHref", () => {
    expect(src("components/layout/sidebar.tsx")).toContain("createWorkerHref()");
  });

  it("/workers/new is a real page, not a redirect to Emily", () => {
    const page = src("app/workers/new/page.tsx");
    expect(page).toContain("NewWorkerClient");
    expect(page).not.toContain("redirect(`/?create=1");
  });

  it("command palette and workers collection use createWorkerHref", () => {
    expect(src("components/CommandPalette.tsx")).toContain("go(createWorkerHref())");
    expect(src("app/workers/WorkersCollection.tsx")).toContain("createWorkerHref()");
  });

  it("keeps Emily docked on /workers/new so Emily stays visible", () => {
    expect(src("components/emily/EmilyChat.tsx")).toContain("isCreateWorkerRoute");
  });
});
