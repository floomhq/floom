import { describe, it, expect } from "vitest";
import {
  relativeAge,
  formatVersionRow,
  formatVersionRows,
} from "@/lib/workers/versions";
import { WORKER_DETAIL_TABS } from "@/lib/workers/tabs";
import type { VersionSummary } from "@/lib/types";

const NOW = Date.parse("2026-06-10T12:00:00Z");

function v(partial: Partial<VersionSummary>): VersionSummary {
  return {
    id: "abc1234",
    sha: "abc1234",
    message: "feat: thing",
    author: "Vivek",
    timestamp: "2026-06-10T11:00:00Z",
    asset_type: "worker",
    asset_id: "w1",
    ...partial,
  };
}

describe("relativeAge", () => {
  it("buckets minutes/hours/days/weeks", () => {
    expect(relativeAge("2026-06-10T11:59:40Z", NOW)).toBe("just now");
    expect(relativeAge("2026-06-10T11:30:00Z", NOW)).toBe("30m");
    expect(relativeAge("2026-06-10T09:00:00Z", NOW)).toBe("3h");
    expect(relativeAge("2026-06-08T12:00:00Z", NOW)).toBe("2d");
    expect(relativeAge("2026-05-27T12:00:00Z", NOW)).toBe("2w");
  });
  it("handles missing/invalid", () => {
    expect(relativeAge(undefined, NOW)).toBe("—");
    expect(relativeAge("not-a-date", NOW)).toBe("—");
  });
});

describe("formatVersionRow", () => {
  it("builds `sha · author · age` meta", () => {
    const r = formatVersionRow(v({}), NOW);
    expect(r.message).toBe("feat: thing");
    expect(r.meta).toBe("abc1234 · Vivek · 1h");
  });
  it("truncates sha to 7 chars and falls back to id", () => {
    const r = formatVersionRow(v({ sha: "abcdef1234567", id: "abcdef1" }), NOW);
    expect(r.meta.startsWith("abcdef1 ·")).toBe(true);
  });
  it("marks the current sha", () => {
    expect(formatVersionRow(v({ sha: "abc1234" }), NOW, "abc1234").isCurrent).toBe(true);
    expect(formatVersionRow(v({ sha: "abc1234" }), NOW, "zzz9999").isCurrent).toBe(false);
  });
  it("defaults message and drops empty author", () => {
    const r = formatVersionRow(v({ message: "  ", author: "" }), NOW);
    expect(r.message).toBe("(no message)");
    expect(r.meta).toBe("abc1234 · 1h");
  });
});

describe("formatVersionRows", () => {
  it("treats the newest row as current when no current sha given", () => {
    const rows = formatVersionRows(
      [v({ sha: "new1111" }), v({ sha: "old0000" })],
      NOW
    );
    expect(rows[0].isCurrent).toBe(true);
    expect(rows[1].isCurrent).toBe(false);
  });
});

describe("WORKER_DETAIL_TABS (§4 contract)", () => {
  it("is exactly the minimal five, in order", () => {
    expect([...WORKER_DETAIL_TABS]).toEqual([
      "Overview",
      "Runs",
      "Config",
      "Source",
      "Versions",
    ]);
  });
});
