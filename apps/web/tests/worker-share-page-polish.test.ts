import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

describe("public worker share page polish", () => {
  it("passes source files and sharer metadata into the worker share card", () => {
    const source = read("app/s/[token]/StandaloneShareCard.tsx");
    expect(source).toContain("files={share.files}");
    expect(source).toContain("sharedBy={share.shared_by}");
  });

  it("renders overview before source/setup and exposes agent copy/download affordances", () => {
    const source = read("components/share/WorkerShareCard.tsx");
    expect(source).toContain('useState<FileTab>("overview")');
    expect(source).toContain("is sharing this worker with you");
    expect(source).toContain("Copy agent prompt");
    expect(source).toContain("Copy source");
    expect(source).toContain("Download");
    expect(source).toContain("Agent install prompt");
    expect(source).toContain("Source files");
  });

  it("does not render the old low-contrast input placeholder pattern", () => {
    const source = read("components/share/WorkerShareCard.tsx");
    expect(source).not.toContain("font-mono text-xs transition-colors");
    expect(source).not.toContain('["skill", "SKILL.md"]');
  });
});
