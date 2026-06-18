import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { Sparkline } from "@/components/Sparkline";
import type { OverviewSparklineBucket } from "@/lib/types";

// fix/emily-fullscreen-overview-r9 — the "Work done this week" hero card used a
// static, non-interactive <polyline>. It now reuses the shared Sparkline (area
// variant), which is HOVERABLE: hovering a point shows a tooltip with the
// bucket value + day label and drops an active-point dot. This test proves the
// hover behaviour: no tooltip at rest, value + label tooltip on mouse enter.

const buckets: OverviewSparklineBucket[] = [
  { label: "Mon", started_at: "2026-06-12", total: 1, failed: 0 },
  { label: "Tue", started_at: "2026-06-13", total: 4, failed: 1 },
  { label: "Wed", started_at: "2026-06-14", total: 2, failed: 0 },
];

describe("Sparkline area variant — hover", () => {
  it("shows no tooltip at rest and a value+label tooltip on hover", () => {
    cleanup();
    const { container } = render(
      <Sparkline data={buckets} width={150} height={44} variant="area" />,
    );

    // At rest: no positioned tooltip element.
    expect(screen.queryByRole("tooltip")).toBeNull();

    // Hover the second bucket's invisible hover region (index 1 → "Tue", 4 runs).
    const regions = container.querySelectorAll("rect");
    expect(regions.length).toBe(buckets.length);
    fireEvent.mouseEnter(regions[1]);

    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("4");
    expect(tip.textContent).toContain("runs");
    expect(tip.textContent).toContain("Tue");

    // Active-point dot (a filled accent circle) appears on the hovered point.
    expect(container.querySelector("circle")).not.toBeNull();

    // Leaving clears the tooltip + dot.
    fireEvent.mouseLeave(regions[1]);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("singularises the unit for a single-run bucket", () => {
    cleanup();
    const { container } = render(
      <Sparkline data={buckets} width={150} height={44} variant="area" />,
    );
    const regions = container.querySelectorAll("rect");
    fireEvent.mouseEnter(regions[0]); // "Mon", 1 run
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("1");
    expect(tip.textContent).toContain("run");
    expect(tip.textContent).not.toContain("runs");
  });
});
