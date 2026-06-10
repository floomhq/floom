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
// #616 — Settings Git tab renders the GitHub workspace panel
// ---------------------------------------------------------------------------

describe("#616 Settings Git tab", () => {
  it("imports GitWorkspacePanel", () => {
    const s = src("app/settings/page.tsx");
    expect(s).toContain('import { GitWorkspacePanel } from "@/components/GitWorkspacePanel"');
  });

  it("defines Git as a visible Settings tab", () => {
    const s = src("app/settings/page.tsx");
    expect(s).toContain('"git"');
    expect(s).toContain('{ key: "git", label: "Git" }');
    expect(s).toContain('value="git"');
  });

  it("renders GitWorkspacePanel inside the Git tab", () => {
    const s = src("app/settings/page.tsx");
    const gitTabIdx = s.indexOf('TabsContent value="git"');
    expect(gitTabIdx).toBeGreaterThanOrEqual(0);
    expect(s.slice(gitTabIdx, gitTabIdx + 220)).toContain("<GitWorkspacePanel />");
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
