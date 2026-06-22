import { describe, expect, it } from "vitest";
import { rankWorkersForCommandPalette } from "@/lib/command-palette";
import type { WorkerSummary } from "@/lib/types";

function worker(id: string, name: string, description = ""): WorkerSummary {
  return {
    id,
    name,
    description,
    tags: [],
    status: "ready",
    trigger_type: "manual",
    runner: "e2b",
    triggers: [],
    triggers_spec: [],
    connections: [],
  };
}

describe("command palette worker ranking", () => {
  it("does not slice out exact matches after the first twelve workers", () => {
    const workers = [
      ...Array.from({ length: 12 }, (_, i) => worker(`worker_${i}`, `Worker ${i}`)),
      worker("pentest_reporter", "Pentest Reporter"),
      worker("pentest_triage", "Pentest Triage"),
    ];

    expect(rankWorkersForCommandPalette(workers, "Pentest").map((w) => w.name)).toEqual([
      "Pentest Reporter",
      "Pentest Triage",
    ]);
  });

  it("ranks name matches above description-only matches", () => {
    const workers = [
      worker("bad_cron2", "Bad Cron2", "mentions pentest in stale notes"),
      worker("pentest_alerts", "Pentest Alerts"),
    ];

    expect(rankWorkersForCommandPalette(workers, "pentest").map((w) => w.id)).toEqual([
      "pentest_alerts",
      "bad_cron2",
    ]);
  });
});
