import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("sidebar route prefetch", () => {
  it("warms data without Next RSC route prefetches", () => {
    const source = readFileSync(join(process.cwd(), "components/layout/sidebar.tsx"), "utf8");

    expect(source).toContain("prefetch={false}");
    expect(source).toContain("prefetchRouteData(queryClient, href)");
    expect(source).not.toContain("router.prefetch(href)");
    expect(source).toContain("basePath RSC segment");
  });
});
