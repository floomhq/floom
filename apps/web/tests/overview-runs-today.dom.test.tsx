import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Round-09 #7 — render the REAL OverviewDashboard with the live bug data
// (runs_today = 30 but only 1 active worker) and prove the hero copy reads "30
// runs ran today", never "30 workers ran today". Exercises the full render path,
// not just the pure runsTodayLabel() helper.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/overview",
}));

const overview = {
  stats: {
    runs_24h: 30,
    runs_24h_sparkline: [],
    runs_7d_sparkline: [],
    success_rate_7d: 1,
    active_workers_count: 1,
    paused_workers_count: 0,
    connections_healthy: 0,
    connections_total: 0,
    work_shipped_7d: 0,
    work_shipped_previous_7d: 0,
    runs_today: 30,
    completed_today: 30,
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
  api: { system: { overview: vi.fn().mockResolvedValue(overview) } },
}));

beforeEach(() => vi.clearAllMocks());

describe("OverviewDashboard runs-today copy (round-09 #7)", () => {
  it("renders '30 runs ran today', never '30 workers ran today'", async () => {
    const { OverviewDashboard } = await import(
      "@/components/overview/OverviewDashboard"
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <OverviewDashboard initialData={overview as never} />
      </QueryClientProvider>,
    );

    // The hero summary must contain the runs phrasing.
    expect(await screen.findByText(/ran today/i)).toBeInTheDocument();
    const body = document.body.textContent || "";

    // CRITICAL: the runs_today metric must NOT be described as workers.
    expect(body).not.toMatch(/30\s+workers?\s+ran today/i);
    expect(body).toMatch(/30\s+runs\s+ran today/i);
  });
});
