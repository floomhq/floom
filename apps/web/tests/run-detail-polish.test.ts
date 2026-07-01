import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("standalone run detail polish", () => {
  it("renders a structured skeleton instead of a plain loading sentence", () => {
    const src = read("app/runs/[id]/RunDetailPageClient.tsx");

    expect(src).toContain("function RunDetailLoadingSkeleton");
    expect(src).toContain('aria-label="Loading run details"');
    expect(src).not.toContain("Loading run...");
  });

  it("keeps the timeline rail compact and metrics adaptive", () => {
    const src = read("components/RunDetailSplitPane.tsx");

    expect(src).toContain("showTimelineRail");
    expect(src).toContain("timeline.length > 1");
    expect(src).toContain("md:w-[240px]");
    expect(src).toContain("md:max-w-[280px]");
    expect(src).toContain("lg:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]");
    expect(src).toContain("[border:var(--bd-card)] bg-card px-3 py-2");
    expect(src).not.toContain("gap-px overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--border-default)]");
  });
});
