import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "../app/workers/WorkersCollection.tsx"), "utf8");
const EMPTY_STATE_SRC = SRC.slice(
  SRC.indexOf("const WORKERS_EMPTY_ONBOARD_PROMPT"),
  SRC.indexOf("export type WorkersExtraView"),
);

describe("workers empty state quick start", () => {
  it("keeps the first-worker title and one-line help", () => {
    expect(SRC).toContain("Create your first worker");
    expect(SRC).toContain(
      "Workers are YAML-defined automations with code, tools, secrets, memory, and run history.",
    );
  });

  it("presents one copyable onboarding prompt as the hero action", () => {
    expect(EMPTY_STATE_SRC).toContain("Get started, paste this into Claude Code or Cursor:");
    expect(EMPTY_STATE_SRC).toContain(
      "Read https://floom.dev/onboard and walk me through setting up Floom.",
    );
    expect(EMPTY_STATE_SRC).toContain("navigator.clipboard.writeText(WORKERS_EMPTY_ONBOARD_PROMPT)");
    expect(EMPTY_STATE_SRC).toContain('aria-label={copied ? "Copied" : "Copy prompt"}');
    expect(EMPTY_STATE_SRC).toContain('copied ? "Copied" : "Copy prompt"');
  });

  it("removes every competing empty-state action and example", () => {
    expect(SRC).not.toContain("WORKER_PROMPT_EXAMPLES");
    expect(SRC).not.toContain("summarizes my latest 5 Gmail emails");
    expect(EMPTY_STATE_SRC).not.toContain("npx -y @floomhq/floom mcp install");
    expect(EMPTY_STATE_SRC).not.toContain("Install MCP");
    expect(EMPTY_STATE_SRC).not.toContain("Worker guide");
    expect(EMPTY_STATE_SRC).not.toContain("Emily");
    expect(EMPTY_STATE_SRC).not.toContain("Start from a template");
    expect(EMPTY_STATE_SRC).not.toContain("Build one from your coding agent");
  });

  it("keeps one quiet templates link on the public-site origin", () => {
    expect(SRC).toContain("`${getPublicSiteOrigin()}/templates`");
    expect(EMPTY_STATE_SRC).toContain("or browse templates");
    expect(EMPTY_STATE_SRC).toContain("href={WORKERS_EMPTY_TEMPLATES_URL}");
  });

  it("keeps filtered-empty search results separate from first-worker onboarding", () => {
    expect(SRC).toContain("filteredEmpty");
    expect(SRC).toContain("No workers found");
    expect(SRC).toContain("Clear the search or filters to see your workers.");
  });

  it("uses one full-width borderless cool-gray mono block", () => {
    expect(SRC).toContain("max-w-[620px] flex-col items-center");
    expect(EMPTY_STATE_SRC).toContain("w-full items-center justify-between");
    expect(EMPTY_STATE_SRC).toContain("border-0 bg-[#F3F4F6]");
    expect(EMPTY_STATE_SRC).toContain("font-mono");
    expect(EMPTY_STATE_SRC).not.toContain("[border:");
    expect(EMPTY_STATE_SRC).not.toContain("c-vpill");
  });
});
