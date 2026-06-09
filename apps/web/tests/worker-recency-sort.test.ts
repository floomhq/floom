import { describe, expect, it } from "vitest";
import type { WorkerSummary } from "@/lib/types";
import { sortWorkersByRecentActivity } from "@/lib/worker-list-order";

function worker(partial: Partial<WorkerSummary> & { id: string; name?: string }): WorkerSummary {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    tags: [],
    status: "healthy",
    trigger_type: "manual",
    runner: "e2b",
    triggers: [],
    triggers_spec: [],
    connections: [],
    ...partial,
  };
}

describe("worker recency sorting", () => {
  it("places newly created workers ahead of stock/catalog rows on All", () => {
    const input = [
      worker({ id: "weekly_update", name: "Weekly Update" }),
      worker({ id: "research_brief", name: "Research Brief" }),
      worker({ id: "canopy-crm-sync", name: "Canopy CRM Sync", created_at: "2026-06-08T23:57:07Z" }),
      worker({ id: "chain-fix-1780963431726", created_at: "2026-06-09T00:03:52Z" }),
      worker({ id: "chain-par-1780963431726", created_at: "2026-06-09T00:03:58Z" }),
    ];

    expect(sortWorkersByRecentActivity(input).map((w) => w.id)).toEqual([
      "chain-par-1780963431726",
      "chain-fix-1780963431726",
      "canopy-crm-sync",
      "weekly_update",
      "research_brief",
    ]);
  });

  it("uses last run time as recency when it is newer than creation time", () => {
    const input = [
      worker({ id: "new-never-run", created_at: "2026-06-09T00:00:00Z" }),
      worker({
        id: "older-active",
        created_at: "2026-06-01T00:00:00Z",
        recent_stats: { last_run_at: "2026-06-09T00:05:00Z", runs_7d: 1 },
      }),
    ];

    expect(sortWorkersByRecentActivity(input).map((w) => w.id)).toEqual([
      "older-active",
      "new-never-run",
    ]);
  });
});
