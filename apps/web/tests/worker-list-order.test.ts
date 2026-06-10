import { describe, expect, it } from "vitest";
import { hasWorkerActivity, sortWorkersByRecentActivity } from "@/lib/worker-list-order";
import type { WorkerSummary } from "@/lib/types";

function worker(
  id: string,
  name: string,
  lastRunAt?: string | null,
  timestamps: Pick<WorkerSummary, "created_at" | "updated_at"> = {}
): WorkerSummary {
  return {
    id,
    name,
    ...timestamps,
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

  it("uses updated and created timestamps for workers that have never run", () => {
    const newlyCreated = worker("newly-created", "Newly Created", null, {
      created_at: "2026-06-09T10:00:00Z",
    });
    const ordered = sortWorkersByRecentActivity([
      worker("older-run", "Older Run", "2026-06-05T10:00:00Z"),
      newlyCreated,
      worker("recently-updated", "Recently Updated", null, {
        created_at: "2026-06-01T10:00:00Z",
        updated_at: "2026-06-10T10:00:00Z",
      }),
    ]);

    expect(hasWorkerActivity(newlyCreated)).toBe(true);
    expect(ordered.map((w) => w.id)).toEqual([
      "recently-updated",
      "newly-created",
      "older-run",
    ]);
  });
});
