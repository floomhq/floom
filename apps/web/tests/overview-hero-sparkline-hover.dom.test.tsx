import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// fix/emily-fullscreen-overview-r9 — prove the "Work done this week" hero card
// renders the interactive Sparkline (area variant) and that hovering the chart
// surfaces a value+day tooltip. Exercises the FULL OverviewDashboard render
// path, not just the standalone Sparkline.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/overview",
}));

const overview = {
  stats: {
    runs_24h: 7,
    runs_24h_sparkline: [],
    runs_7d_sparkline: [
      { label: "Mon", started_at: "2026-06-12", total: 1, failed: 0 },
      { label: "Tue", started_at: "2026-06-13", total: 4, failed: 1 },
      { label: "Wed", started_at: "2026-06-14", total: 2, failed: 0 },
      { label: "Thu", started_at: "2026-06-15", total: 5, failed: 0 },
    ],
    success_rate_7d: 1,
    active_workers_count: 2,
    paused_workers_count: 0,
    connections_healthy: 1,
    connections_total: 1,
    work_shipped_7d: 12,
    work_shipped_previous_7d: 8,
    runs_today: 3,
    completed_today: 3,
    failed_today: 0,
    running_now: 0,
    queued_now: 0,
    scheduled_24h_count: 0,
  },
  outcomes: [],
  recent_runs: [],
  scheduled_today: [],
  needs_attention: [],
};

vi.mock("@/lib/api", () => ({
  api: {
    system: { overview: vi.fn().mockResolvedValue(overview) },
    me: vi.fn().mockResolvedValue({ display_name: "Maintainer", email: "local@example.com" }),
  },
}));

beforeEach(() => vi.clearAllMocks());

describe("Overview hero — interactive sparkline", () => {
  it("renders the hero number and a hoverable sparkline with a value+day tooltip", async () => {
    const { OverviewDashboard } = await import(
      "@/components/overview/OverviewDashboard"
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <OverviewDashboard initialData={overview as never} />
      </QueryClientProvider>,
    );

    // Hero "Work done this week" number renders.
    expect(await screen.findByText("Work done this week")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();

    // The interactive sparkline mounts: 4 buckets → 4 invisible hover <rect>s,
    // each carrying a native <title> (value + day). The old static <polyline>
    // had none.
    const hoverRects = Array.from(container.querySelectorAll("rect")).filter(
      (r) => r.querySelector("title") !== null,
    );
    expect(hoverRects.length).toBe(4);

    // At rest, no positioned tooltip.
    expect(screen.queryByRole("tooltip")).toBeNull();

    // Hover the "Thu" bucket (index 3 → 5 runs) and assert the tooltip.
    fireEvent.mouseEnter(hoverRects[3]);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("5");
    expect(tip.textContent).toContain("runs");
    expect(tip.textContent).toContain("Thu");

    fireEvent.mouseLeave(hoverRects[3]);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
