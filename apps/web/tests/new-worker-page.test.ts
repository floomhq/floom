import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("dashboard worker creation entry points", () => {
  it("does not expose New worker from the sidebar", () => {
    const sidebar = src("components/layout/sidebar.tsx");
    expect(sidebar).not.toContain("New worker");
    expect(sidebar).not.toContain("createWorkerHref");
  });

  it("does not expose New worker from command palette, Workers, or Runs empty states", () => {
    expect(src("components/CommandPalette.tsx")).not.toContain("New worker");
    expect(src("app/workers/WorkersCollection.tsx")).not.toContain("createWorkerHref");
    expect(src("app/workers/WorkersCollection.tsx")).not.toContain("WorkersEmptyPrompt");
    expect(src("app/runs/RunsCollection.tsx")).not.toContain("Create your first worker");
  });

  it("/workers/new falls back to Workers instead of mounting prompt creation", () => {
    const page = src("app/workers/new/page.tsx");
    expect(page).toContain('redirect("/workers")');
    expect(page).not.toContain("NewWorkerClient");
    expect(page).not.toContain("newFromPrompt");
  });
});
