import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "../app/workers/WorkersCollection.tsx"), "utf8");

describe("workers empty state quick start", () => {
  it("leads with the template gallery as the primary activation path", () => {
    expect(SRC).toContain("Create your first worker");
    // PRIMARY: start from a template (the gallery's Add-to-workspace path).
    expect(SRC).toContain("Start from a template");
    expect(SRC).toContain("Browse templates");
    expect(SRC).toContain("/templates`");
    expect(SRC).toContain("getPublicSiteOrigin");
  });

  it("keeps the coding-agent / MCP path as the secondary quickstart", () => {
    expect(SRC).toContain("Build one from your coding agent");
    expect(SRC).toContain("Install the Floom MCP server in Claude Code, Codex, or Cursor");
    expect(SRC).toContain("npx -y @floomhq/floom mcp install");
    expect(SRC).not.toContain("npm install -g @floomhq/floom");
    expect(SRC).not.toContain("floom login");
    expect(SRC).toContain("/connections/mcp?from_install=workers-empty");
    expect(SRC).not.toContain("github.com/floomhq/floom/blob/main/apps/mcp/README.md");
    expect(SRC).toContain("Install MCP");
    expect(SRC).toContain("https://floom.dev/v3/docs/worker-yml");
    expect(SRC).not.toContain("github.com/floomhq/floom/blob/main/docs/AUTHORING.md");
  });

  it("shows concrete worker prompt examples instead of the old empty copy", () => {
    expect(SRC).toContain("summarizes my latest 5 Gmail emails every hour");
    expect(SRC).toContain("checks new Linear issues every morning");
    expect(SRC).toContain("watches a Google Sheet for new rows");
    expect(SRC).not.toContain("Dashboard worker creation is temporarily unavailable");
  });

  it("keeps filtered-empty search results separate from first-worker onboarding", () => {
    expect(SRC).toContain("filteredEmpty");
    expect(SRC).toContain("No workers found");
    expect(SRC).toContain("Clear the search or filters to see your workers.");
  });

  it("keeps the quick start visually aligned with collection empty states", () => {
    expect(SRC).toContain("max-w-[620px] flex-col items-center");
    expect(SRC).not.toContain("rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-2)] p-4");
    expect(SRC).toContain('className="c-vpill"');
  });
});
