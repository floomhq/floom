import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "../app/workers/WorkersCollection.tsx"), "utf8");

describe("workers empty state quick start", () => {
  it("guides new users to create their first worker with CLI or MCP", () => {
    expect(SRC).toContain("Create your first worker");
    expect(SRC).toContain("Quick start");
    expect(SRC).toContain("Go to your coding agent, install the Floom CLI or MCP");
    expect(SRC).toContain("npm install -g @floomhq/floom");
    expect(SRC).toContain("floom login");
    expect(SRC).toContain("floom mcp install");
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
});
