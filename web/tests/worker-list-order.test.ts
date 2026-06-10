import { describe, expect, it } from "vitest";
import { sortWorkersByRecentActivity } from "@/lib/worker-list-order";
import type { WorkerSummary } from "@/lib/types";

function worker(id: string, name: string, lastRunAt?: string | null): WorkerSummary {
  return {
    id,
    name,
    tags: [],
    status: "healthy",
    trigger_type: "manual",
    runner: "e2b",
    connections: [],
    triggers: [],
    triggers_spec: [],
    recent_stats: lastRunAt
      ? { last_run_at: lastRunAt, runs_7d: 1, success_rate_7d: 1 }
      : null,
  };
}

describe("worker list order", () => {
  it("puts recently run workers first in the all tab", () => {
    const ordered = sortWorkersByRecentActivity([
      worker("older", "Older Worker", "2026-06-01T10:00:00Z"),
      worker("newer", "Newer Worker", "2026-06-08T10:00:00Z"),
      worker("never", "Never Run"),
    ]);

    expect(ordered.map((w) => w.id)).toEqual(["newer", "older", "never"]);
  });
});
