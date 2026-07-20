import { describe, it, expect } from "vitest";
import {
  isSystemWorker,
  workerStatusPill,
  workerStatusReason,
  workerStatusKey,
  workerStageKey,
  workerStageLabel,
  isRecent,
  workerSmartTags,
  contentTagOptions,
  orderedSourceFiles,
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

describe("workerStatusReason (#1208)", () => {
  it("explains a failed last run, taking priority over disabled", () => {
    expect(
      workerStatusReason(
        w({ status: "needs_attention", enabled: false, last_run: { id: "r1", worker_id: "w1", status: "failed", trigger_source: "manual" } }),
      ),
    ).toBe("Last run failed");
  });

  it("prefers the stored auto-pause reason when the worker is durably disabled", () => {
    expect(
      workerStatusReason(
        w({
          status: "needs_attention",
          enabled: false,
          archive_reason: "Paused automatically after repeated scheduled setup failures.",
        }),
      ),
    ).toBe("Paused automatically after repeated scheduled setup failures.");
  });

  it("falls back to a generic disabled reason with no archive_reason", () => {
    expect(workerStatusReason(w({ status: "needs_attention", enabled: false }))).toBe("Worker is disabled");
  });

  it("names a single missing secret", () => {
    expect(workerStatusReason(w({ status: "missing_secret", missing_secrets: ["OPENAI_API_KEY"] }))).toBe(
      "Missing secret: OPENAI_API_KEY",
    );
  });

  it("lists multiple missing secrets", () => {
    expect(
      workerStatusReason(w({ status: "missing_secret", missing_secrets: ["A_KEY", "B_KEY"] })),
    ).toBe("Missing secrets: A_KEY, B_KEY");
  });

  it("returns null for healthy/ready/error workers (no explanation needed)", () => {
    expect(workerStatusReason(w({ status: "healthy" }))).toBeNull();
    expect(workerStatusReason(w({ status: "ready" }))).toBeNull();
    expect(workerStatusReason(w({ status: "error" }))).toBeNull();
  });
});

describe("workerStatusPill reason wiring (#1208)", () => {
  it("carries the reason through onto the pill spec", () => {
    const pill = workerStatusPill(w({ status: "missing_secret", missing_secrets: ["X"] }));
    expect(pill.reason).toBe("Missing secret: X");
  });

  it("omits reason for healthy workers", () => {
    expect(workerStatusPill(w({ status: "healthy" })).reason).toBeUndefined();
  });
});

describe("workerStatusKey", () => {
  it("derives the status-tag key", () => {
    expect(workerStatusKey(w({ status: "error" }))).toBe("failing");
    expect(workerStatusKey(w({ status: "missing_secret" }))).toBe("needs-attention");
    expect(workerStatusKey(w({ status: "ready" }))).toBe("healthy");
  });
});

describe("workerStageKey", () => {
  it("honors an explicit stage", () => {
    expect(workerStageKey(w({ stage: "draft" }))).toBe("draft");
    expect(workerStageKey(w({ stage: "live" }))).toBe("live");
  });
  it("defaults stock/example/system workers to live", () => {
    expect(workerStageKey(w({ is_example: true }))).toBe("live");
    expect(workerStageKey(w({ system: true }))).toBe("live");
  });
  it("defaults a plain new worker to draft", () => {
    expect(workerStageKey(w({}))).toBe("draft");
  });
});

describe("workerStageLabel", () => {
  it("returns the capitalized stage label matching the per-card badge", () => {
    expect(workerStageLabel(w({ stage: "draft" }))).toBe("Draft");
    expect(workerStageLabel(w({ stage: "live" }))).toBe("Live");
    expect(workerStageLabel(w({ is_example: true }))).toBe("Live");
    expect(workerStageLabel(w({}))).toBe("Draft");
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

describe("orderedSourceFiles (Source sub-tabs)", () => {
  it("orders canonical files first, then extras, dropping no-content files", () => {
    const files = [
      { path: "run.py", content: "x" },
      { path: "lib/helper.py", content: "y" },
      { path: "worker.yml", content: "z" },
      { path: "icon.png", content: null }, // binary / no content → dropped
      { path: "SKILL.md", content: "s" },
    ];
    expect(orderedSourceFiles(files).map((f) => f.path)).toEqual([
      "worker.yml",
      "SKILL.md",
      "run.py",
      "lib/helper.py",
    ]);
  });
  it("returns [] when nothing has content", () => {
    expect(orderedSourceFiles([{ path: "a.bin", content: null }])).toEqual([]);
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
