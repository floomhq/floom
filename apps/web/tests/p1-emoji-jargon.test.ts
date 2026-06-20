import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

describe("P1 UI copy regressions", () => {
  it("renders review verdicts with icons, not emoji glyph constants", () => {
    const reviewFlow = read("app/review/[token]/ReviewFlow.tsx");

    expect(reviewFlow).not.toContain("VERDICT_EMOJI");
    expect(reviewFlow).toContain("function VerdictIcon");
    expect(reviewFlow).toContain("ThumbsUp");
    expect(reviewFlow).toContain("HelpCircle");
    expect(reviewFlow).toContain("ThumbsDown");
  });

  it("does not render stale pack jargon in the worker Brain toast or privacy page", () => {
    const workers = read("app/workers/WorkersCollection.tsx");
    const privacy = read("app/privacy/page.tsx");

    expect(workers).not.toMatch(/knowledge packs?/i);
    expect(privacy).not.toMatch(/brain packs?|knowledge packs?/i);
    expect(workers).toContain("Could not load brain folders.");
    expect(privacy).toContain("Conversations and brain folders");
  });

  it("keeps cli auth terminal status glyphs as lucide icons", () => {
    const cliAuth = read("app/cli-auth/page.tsx");

    expect(cliAuth).not.toContain("✓");
    expect(cliAuth).toContain('import { Check, X } from "lucide-react"');
  });
});
