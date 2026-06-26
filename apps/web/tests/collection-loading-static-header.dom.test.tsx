import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";
import { CollectionSkeleton } from "@/components/collection/CollectionStates";

// The route-level loading state must render the page's REAL static header
// (title/subtitle/search/action) and skeleton ONLY the list content rows, so a
// cache-miss tab switch shows the real header instantly with no full-page flash.
// These tests assert that split: real header text vs. a busy content skeleton.

describe("collection loading: real static header + content-only skeleton", () => {
  it("renders the real title text (not a skeleton placeholder)", () => {
    render(<CollectionSkeleton rows={6} title="Library" />);
    // The title is live text "Library", queryable as a DOM text node.
    expect(screen.getByText("Library")).toBeInTheDocument();
  });

  it("renders the real subtitle and a static, non-interactive search box", () => {
    render(
      <CollectionSkeleton
        rows={6}
        title="Library"
        subtitle="Reusable folders of files your workers can read before they act."
      />,
    );
    expect(
      screen.getByText("Reusable folders of files your workers can read before they act."),
    ).toBeInTheDocument();
    // A real-looking search input is present but inert (readOnly, removed from tab order).
    const search = screen.getByLabelText("Search") as HTMLInputElement;
    expect(search).toBeInTheDocument();
    expect(search.readOnly).toBe(true);
    expect(search.tabIndex).toBe(-1);
  });

  it("skeletons ONLY the content/list area (aria-busy ListLoading), not the header", () => {
    const { container } = render(<CollectionSkeleton rows={6} title="Library" />);

    // The busy/loading region is the content list (ListLoading), not the whole page.
    const busy = container.querySelector('[aria-busy="true"][aria-label="Loading"]') as HTMLElement;
    expect(busy).not.toBeNull();
    expect(busy.getAttribute("aria-label")).toBe("Loading");

    // The title text lives OUTSIDE the busy content region (the header is real,
    // rendered before/above the skeleton list), so it is not a skeleton placeholder.
    expect(within(busy).queryByText("Library")).toBeNull();
    expect(screen.getByText("Library")).toBeInTheDocument();

    // One skeleton bar per requested list row sits inside the busy region.
    const rowBars = busy.querySelectorAll('[data-slot="skeleton"]');
    expect(rowBars.length).toBe(6);
  });

  it("renders the action button label when provided, threaded through the route shell", () => {
    render(<CollectionRouteLoading title="Workers" actionLabel="New worker" />);
    expect(screen.getByText("Workers")).toBeInTheDocument();
    expect(screen.getByText("New worker")).toBeInTheDocument();
  });
});
