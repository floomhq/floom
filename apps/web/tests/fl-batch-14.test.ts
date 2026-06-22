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

  it("defines Connect & automate as the account-scoped home for Git sync", () => {
    // The Workspace/Account split moved token CRUD into two dedicated panes and
    // re-homed the developer reference (API/MCP/CLI/Git) under "Connect &
    // automate". Git still lives there, account-scoped.
    const nav = src("lib/settings/nav-groups.ts");
    expect(nav).toContain('{ key: "connect", label: "Connect & automate", scope: "account"');
    const s = src("app/settings/page.tsx");
    expect(s).toContain('"connect"');
    expect(s).toContain("function ConnectSection()");
  });

  it("renders GitWorkspacePanel inside the Connect & automate detail", () => {
    const s = src("app/settings/page.tsx");
    const connectSectionIdx = s.indexOf("function ConnectSection()");
    expect(connectSectionIdx).toBeGreaterThanOrEqual(0);
    // Window covers the whole ConnectSection body (the API tab sits ahead of the
    // Git tab, so the Git panel is further down).
    expect(s.slice(connectSectionIdx, connectSectionIdx + 5000)).toContain("<GitWorkspacePanel />");
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
