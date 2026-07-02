import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";
import { CollectionSkeleton } from "@/components/collection/CollectionStates";

// A cache-miss tab switch must feel instant: the route shows the page's REAL
// static header (title/subtitle/search/toolbar) immediately and skeletons ONLY
// the list content rows — never a blank screen, never a single centered spinner,
// and never a full-page skeleton that flashes the whole layout. These tests
// assert that shape so a regression to blank/spinner/full-skeleton is caught.

function skeletonBars(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-slot="skeleton"]')) as HTMLElement[];
}

describe("collection cache-miss skeleton", () => {
  it("renders a busy, labelled loading region in the content area (not a blank screen)", () => {
    const { container } = render(<CollectionRouteLoading title="Workers" />);
    const region = container.querySelector('[aria-busy="true"][aria-label="Loading"]');
    expect(region, "content skeleton must expose aria-busy + aria-label for a11y + intent").not.toBeNull();
  });

  it("renders the real header (title/subtitle text) and skeletons only the list rows", () => {
    const { container, getByText } = render(
      <CollectionSkeleton rows={6} title="Workers" subtitle="Your AI workers." />,
    );
    // Header is REAL text, not a placeholder bar.
    expect(getByText("Workers")).toBeInTheDocument();
    expect(getByText("Your AI workers.")).toBeInTheDocument();
    // Skeleton bars exist (one per list row + a filter pill) for the content.
    const bars = skeletonBars(container);
    expect(bars.length).toBeGreaterThanOrEqual(6);
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
