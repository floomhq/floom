import { describe, it, expect } from "vitest";
import {
  isSystemWorker,
  workerStatusPill,
  workerStatusKey,
  isRecent,
  workerSmartTags,
  contentTagOptions,
} from "@/lib/workers/derive";
import type { WorkerSummary } from "@/lib/types";

const w = (over: Partial<WorkerSummary>): WorkerSummary =>
  ({
    id: "w1",
    name: "Worker",
    tags: [],
    status: "healthy",
    trigger_type: "manual",
    runner: "e2b",
    triggers: [],
    triggers_spec: [],
    connections: [],
    ...over,
  }) as WorkerSummary;

describe("isSystemWorker", () => {
  it("flags system flag and the worker-author fallback id", () => {
    expect(isSystemWorker(w({ system: true }))).toBe(true);
    expect(isSystemWorker(w({ id: "worker-author" }))).toBe(true);
    expect(isSystemWorker(w({ id: "regular" }))).toBe(false);
  });
});

describe("workerStatusPill", () => {
  it("maps states to tones", () => {
    expect(workerStatusPill(w({ status: "error" })).tone).toBe("err");
    expect(workerStatusPill(w({ status: "needs_attention" })).tone).toBe("warn");
    expect(workerStatusPill(w({ status: "missing_secret" })).tone).toBe("warn");
    expect(workerStatusPill(w({ status: "healthy" })).tone).toBe("ok");
  });
});

describe("workerStatusKey", () => {
  it("derives the status-tag key", () => {
    expect(workerStatusKey(w({ status: "error" }))).toBe("failing");
    expect(workerStatusKey(w({ status: "missing_secret" }))).toBe("needs-attention");
    expect(workerStatusKey(w({ status: "ready" }))).toBe("healthy");
  });
});

describe("isRecent / workerSmartTags", () => {
  const now = Date.parse("2026-06-09T00:00:00Z");
  it("recent = last run within 14 days", () => {
    expect(isRecent(w({ recent_stats: { last_run_at: "2026-06-08T00:00:00Z", runs_7d: 1 } }), now)).toBe(true);
    expect(isRecent(w({ recent_stats: { last_run_at: "2026-05-01T00:00:00Z", runs_7d: 1 } }), now)).toBe(false);
    expect(isRecent(w({}), now)).toBe(false);
  });
  it("smart tags combine starred + recent + archived", () => {
    const tags = workerSmartTags(
      w({ archived: true, recent_stats: { last_run_at: "2026-06-08T00:00:00Z", runs_7d: 1 } }),
      { starred: true, now },
    );
    expect(tags.sort()).toEqual(["archived", "recent", "starred"]);
  });
});

describe("contentTagOptions", () => {
  it("dedupes + counts + sorts tags across workers", () => {
    const opts = contentTagOptions([
      w({ tags: ["ops", "dach"] }),
      w({ tags: ["ops"] }),
    ]);
    expect(opts).toEqual([
      { value: "dach", label: "dach", count: 1 },
      { value: "ops", label: "ops", count: 2 },
    ]);
  });
});
