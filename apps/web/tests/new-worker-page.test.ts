import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createWorkerHref } from "@/lib/create-worker-nav";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

// Product decision (2026-06-24): clicking "New worker" ANYWHERE drives the
// IN-EMILY create flow (`/?create=1`, handled by EmilyDock) that supersedes the
// active Emily chat in place — it must NOT navigate to the separate /workers/new
// page. Every entry point funnels through createWorkerHref, which now returns the
// `?create=1` deep link.
describe("New worker entry points", () => {
  it("createWorkerHref drives the in-Emily ?create=1 flow, not /workers/new", () => {
    expect(createWorkerHref()).toBe("/?create=1");
    expect(createWorkerHref()).not.toContain("/workers/new");
  });

  it("sidebar primary CTA routes via createWorkerHref (in-Emily flow)", () => {
    expect(src("components/layout/sidebar.tsx")).toContain("createWorkerHref()");
  });

  it("command palette and workers collection use createWorkerHref", () => {
    expect(src("components/CommandPalette.tsx")).toContain("go(createWorkerHref())");
    expect(src("app/workers/WorkersCollection.tsx")).toContain("createWorkerHref()");
  });

  it("/workers/new stays reachable as a real page (direct deep link), not a redirect to Emily", () => {
    const page = src("app/workers/new/page.tsx");
    expect(page).toContain("NewWorkerClient");
    expect(page).not.toContain("redirect(`/?create=1");
  });

  it("EmilyDock owns the in-place create flow (?create=1 effect)", () => {
    const emily = src("components/emily/EmilyChat.tsx");
    // The deep-link create channel and the supersede-in-place handler exist.
    expect(emily).toContain('searchParams.get("create")');
    expect(emily).toContain("beginCreateFlow");
    // Emily still stays docked when the user lands directly on /workers/new.
    expect(emily).toContain("isCreateWorkerRoute");
  });

  it("no legacy redirect intercepts ?create=1 to force /workers/new", () => {
    // AppShell no longer mounts CreateWorkerLegacyRedirect, so ?create=1 reaches
    // EmilyDock's effect instead of being forwarded to the separate page.
    expect(src("components/layout/AppShell.tsx")).not.toContain("CreateWorkerLegacyRedirect");
  });
});
