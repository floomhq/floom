/**
 * Batch-14 frontend fix tests.
 * #616 — Settings exposes GitWorkspacePanel.
 *
 * Run: npx vitest run tests/fl-batch-14.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");

function src(rel: string) { return readFileSync(resolve(ROOT, rel), "utf8"); }

// ---------------------------------------------------------------------------
// #616 — Settings exposes the GitHub workspace panel
// ---------------------------------------------------------------------------

describe("#616 Settings Developer section", () => {
  it("imports GitWorkspacePanel", () => {
    const s = src("app/settings/page.tsx");
    expect(s).toContain('import { GitWorkspacePanel } from "@/components/GitWorkspacePanel"');
  });

  it("defines Developer as the visible Settings home for account integrations", () => {
    // Phase 3 recomposes Settings into the Collection pattern. Git no longer
    // has a standalone workspace tab; it lives under Account · Developer.
    const nav = src("lib/settings/nav-groups.ts");
    expect(nav).toContain('{ key: "developer", label: "Developer", scope: "account"');
    const s = src("app/settings/page.tsx");
    expect(s).toContain('"developer"');
    expect(s).toContain("function DeveloperSection()");
  });

  it("renders GitWorkspacePanel inside the Developer detail", () => {
    const s = src("app/settings/page.tsx");
    const developerSectionIdx = s.indexOf("function DeveloperSection()");
    expect(developerSectionIdx).toBeGreaterThanOrEqual(0);
    // Window covers the whole DeveloperSection body (now includes the API tab
    // ahead of the Git tab, so the Git panel sits further down than before).
    expect(s.slice(developerSectionIdx, developerSectionIdx + 4000)).toContain("<GitWorkspacePanel />");
  });

  it("keeps GitWorkspacePanel wired to the /system/git API wrappers", () => {
    const s = src("components/GitWorkspacePanel.tsx");
    for (const method of [
      "gitStatus",
      "gitConnect",
      "gitListRepos",
      "gitCreateRepo",
      "gitLink",
      "gitPush",
      "gitDisconnect",
    ]) {
      expect(s).toContain(`api.system.${method}`);
    }
  });
});
