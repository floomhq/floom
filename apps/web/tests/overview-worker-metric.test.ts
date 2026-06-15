import { describe, expect, it } from "vitest";
import { workerStatusMetric } from "@/components/overview/OverviewDashboard";

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
      label: "Workers active",
      context: "6 paused",
    });
  });
});
