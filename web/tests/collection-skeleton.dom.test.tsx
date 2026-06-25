import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";
import { CollectionSkeleton } from "@/components/collection/CollectionStates";

// A cache-miss tab switch must feel instant: the route shows a STRUCTURAL
// skeleton that mirrors the real collection layout (header + toolbar + multiple
// list rows) immediately — never a blank screen and never a single centered
// spinner. These tests assert that shape so a regression to blank/spinner is
// caught.

function skeletonBars(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-slot="skeleton"]')) as HTMLElement[];
}

describe("collection cache-miss skeleton", () => {
  it("renders a busy, labelled loading region (not a blank screen)", () => {
    const { container } = render(<CollectionRouteLoading />);
    const region = container.querySelector('[role="status"][aria-busy="true"]');
    expect(region, "skeleton must expose role=status aria-busy for a11y + intent").not.toBeNull();
  });

  it("mirrors the real layout: header + toolbar + multiple list rows", () => {
    const { container } = render(<CollectionSkeleton rows={6} />);
    const bars = skeletonBars(container);
    // Header (title + subtitle = 2) + toolbar (search + toggle + add = 3) +
    // one bar per list row (6) → a rich structural skeleton, far more than the
    // 0-1 elements a blank/spinner would have.
    expect(bars.length).toBeGreaterThanOrEqual(8);
  });

  it("uses the design-system shimmer skeleton, not a spinner", () => {
    const { container } = render(<CollectionSkeleton rows={4} />);
    // Every placeholder is a shimmer bar; there is no animate-spin spinner.
    expect(skeletonBars(container).length).toBeGreaterThan(0);
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("row count scales with the requested rows (footprint matches the real list)", () => {
    const few = render(<CollectionSkeleton rows={3} />);
    const many = render(<CollectionSkeleton rows={9} />);
    expect(skeletonBars(many.container).length).toBeGreaterThan(
      skeletonBars(few.container).length,
    );
  });
});
