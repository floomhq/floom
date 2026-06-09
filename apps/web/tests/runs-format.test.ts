import { describe, it, expect } from "vitest";
import {
  formatDuration,
  triggerKey,
  formatTrigger,
  runStatusPill,
  dayLabel,
} from "@/lib/runs/format";

describe("formatDuration", () => {
  it("formats ms / s / m+s and missing", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(384)).toBe("384ms");
    expect(formatDuration(16600)).toBe("16.6s");
    expect(formatDuration(150000)).toBe("2m 30s");
  });
});

describe("triggerKey / formatTrigger", () => {
  it("normalizes trigger sources", () => {
    expect(triggerKey(undefined)).toBe("manual");
    expect(triggerKey("cron")).toBe("scheduled");
    expect(triggerKey("schedule")).toBe("scheduled");
    expect(triggerKey("webhook")).toBe("webhook");
    expect(formatTrigger("cron")).toBe("Scheduled");
    expect(formatTrigger("manual")).toBe("Manual");
  });
});

describe("runStatusPill", () => {
  it("maps run statuses to tones", () => {
    expect(runStatusPill("completed").tone).toBe("ok");
    expect(runStatusPill("failed").tone).toBe("err");
    expect(runStatusPill("running").tone).toBe("run");
    expect(runStatusPill("queued").tone).toBe("idle");
    expect(runStatusPill("pending_approval").tone).toBe("warn");
  });
});

describe("dayLabel", () => {
  const now = Date.parse("2026-06-09T12:00:00Z");
  it("labels today / yesterday / weekday / date", () => {
    expect(dayLabel("2026-06-09T08:00:00Z", now)).toBe("Today");
    expect(dayLabel("2026-06-08T23:00:00Z", now)).toBe("Yesterday");
    expect(dayLabel(undefined, now)).toBe("Unknown date");
    // 8 days ago → month/day form
    expect(dayLabel("2026-06-01T08:00:00Z", now)).toMatch(/Jun/);
  });
});
