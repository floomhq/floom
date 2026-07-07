import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "../app/workers/WorkersCollection.tsx"), "utf8");

describe("workers empty state — two real activation paths", () => {
  it("routes new users to the two real paths (templates primary + coding agent)", () => {
    // Honest first-worker framing — no "create it here" claim that dead-ends.
    expect(SRC).toContain("Hire your first worker");
    expect(SRC).not.toContain("Create your first worker");

    // Primary path (Cloud): browse the templates gallery.
    expect(SRC).toContain("Browse templates");
    expect(SRC).toContain("/templates`");
    expect(SRC).toContain("getPublicSiteOrigin()");
    // Templates path is Cloud-gated (no dead /templates link on OSS self-host).
    expect(SRC).toContain("isCloudDeploy()");

    // Secondary path: set Floom up from the coding agent (MCP).
    expect(SRC).toContain("Set up from your coding agent");
    expect(SRC).toContain("Install the Floom MCP server");
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
