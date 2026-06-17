import { describe, expect, it } from "vitest";
import { workerStatusMetric, runsTodayLabel } from "@/components/overview/OverviewDashboard";

describe("overview runs-today copy (round-09 #7)", () => {
  // runs_today is a count of RUNS, not distinct workers. The hero copy
  // previously read "N workers ran today" — fabricating a worker count from a
  // runs metric (live: "30 workers ran today" with 1 worker + 3 runs). The copy
  // must bind to runs, never workers.
  it("labels the runs metric as runs, not workers", () => {
    expect(runsTodayLabel(1)).toBe("run");
    expect(runsTodayLabel(30)).toBe("runs");
    expect(runsTodayLabel(0)).toBe("runs");
  });

  it("never describes the runs_today metric using the word 'worker'", () => {
    expect(runsTodayLabel(1)).not.toMatch(/worker/i);
    expect(runsTodayLabel(30)).not.toMatch(/worker/i);
  });
});

describe("overview worker status metric (#1140)", () => {
  it("surfaces paused workers as the headline when every worker is paused", () => {
    expect(workerStatusMetric({ active_workers_count: 0, paused_workers_count: 6 })).toEqual({
      value: 6,
      label: "Workers paused",
      context: "All workers paused",
    });
  });

  it("keeps active workers as the headline when any worker is active", () => {
    expect(workerStatusMetric({ active_workers_count: 2, paused_workers_count: 6 })).toEqual({
      value: 2,
      label: "Workers on duty",
      context: "6 paused",
    });
  });
});
