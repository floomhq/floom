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

  it("defines Developer as the account-scoped home for programmatic access", () => {
    // Developer owns personal tokens, workspace token, API, MCP, CLI, and Git
    // so Settings stays compact at the top level.
    const nav = src("lib/settings/nav-groups.ts");
    expect(nav).toContain('{ key: "developer", label: "Developer", scope: "account"');
    const s = src("app/settings/page.tsx");
    expect(s).toContain('"developer"');
    expect(s).toContain("function DeveloperSection");
  });

  it("renders GitWorkspacePanel inside the Developer detail", () => {
    const s = src("app/settings/page.tsx");
    const developerSectionIdx = s.indexOf("function DeveloperSection");
    expect(developerSectionIdx).toBeGreaterThanOrEqual(0);
    // Window covers the whole DeveloperSection body (the API tab sits ahead of the
    // Git tab, so the Git panel is further down).
    expect(s.slice(developerSectionIdx, developerSectionIdx + 5000)).toContain("<GitWorkspacePanel />");
  });

  it("uses Bearer auth for account-scoped API snippets", () => {
    const s = src("app/settings/page.tsx");
    const snippetIdx = s.indexOf("const API_CALL_SNIPPET");
    const developerSectionIdx = s.indexOf("function DeveloperSection");
    expect(snippetIdx).toBeGreaterThanOrEqual(0);
    expect(developerSectionIdx).toBeGreaterThanOrEqual(0);

    const snippet = s.slice(snippetIdx, snippetIdx + 600);
    const developerSection = s.slice(developerSectionIdx, developerSectionIdx + 3000);
    expect(snippet).toContain('Authorization: Bearer <your-token>');
    expect(snippet).not.toContain("x-floom-secret");
    expect(developerSection).toContain("Authorization: Bearer");
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
