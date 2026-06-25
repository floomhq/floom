import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ListLoading } from "@/components/collection/CollectionStates";

const CACHE_BACKED_ROUTE_LOADING_FILES = [
  "../app/runs/loading.tsx",
  "../app/workers/loading.tsx",
  "../app/connections/loading.tsx",
  "../app/approvals/loading.tsx",
  "../app/library/loading.tsx",
] as const;

function skeletonBars(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-slot="skeleton"]')) as HTMLElement[];
}

describe("collection cache-miss skeleton", () => {
  it("keeps cache-backed pages free of route-level skeleton fallbacks", () => {
    for (const file of CACHE_BACKED_ROUTE_LOADING_FILES) {
      expect(
        existsSync(new URL(file, import.meta.url)),
        `${file} would mask warm TanStack Query data during App Router navigation`,
      ).toBe(false);
    }
  });

  it("still renders list-body skeleton rows for true cold query loads", () => {
    const { container } = render(<ListLoading rows={6} />);
    expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(skeletonBars(container).length).toBe(6);
  });

  it("uses the design-system shimmer skeleton, not a spinner", () => {
    const { container } = render(<ListLoading rows={4} />);
    // Every placeholder is a shimmer bar; there is no animate-spin spinner.
    expect(skeletonBars(container).length).toBeGreaterThan(0);
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("row count scales with the requested rows (footprint matches the real list)", () => {
    const few = render(<ListLoading rows={3} />);
    const many = render(<ListLoading rows={9} />);
    expect(skeletonBars(many.container).length).toBeGreaterThan(
      skeletonBars(few.container).length,
    );
  });
});
