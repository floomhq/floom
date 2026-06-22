import { describe, it, expect } from "vitest";
import {
  parseCron,
  validateCron,
  nextRun,
  formatNextRun,
} from "@/lib/cron-next-run";

// #1678: the schedule trigger editor needs a real, timezone-aware "Next run"
// preview and validation. These prove the engine behind both.

describe("validateCron", () => {
  it("accepts the standard 5-field presets CronBuilder produces", () => {
    expect(validateCron("* * * * *")).toBeNull();      // every minute
    expect(validateCron("0 9 * * *")).toBeNull();      // daily 09:00
    expect(validateCron("0 9 * * 1-5")).toBeNull();    // weekdays
    expect(validateCron("30 8 * * 1,3,5")).toBeNull(); // Mon/Wed/Fri
    expect(validateCron("0 0 1 * *")).toBeNull();      // monthly day 1
    expect(validateCron("*/15 * * * *")).toBeNull();   // every 15 min
  });

  it("accepts day and month names", () => {
    expect(validateCron("0 9 * * MON")).toBeNull();
    expect(validateCron("0 9 1 JAN *")).toBeNull();
  });

  it("rejects malformed expressions with a plain-language message", () => {
    expect(validateCron("")).toMatch(/enter/i);
    expect(validateCron("0 9 * *")).toMatch(/5 fields/i);     // too few
    expect(validateCron("0 9 * * * *")).toMatch(/5 fields/i); // too many
    expect(validateCron("99 9 * * *")).toMatch(/invalid/i);   // minute out of range
    expect(validateCron("0 25 * * *")).toMatch(/invalid/i);   // hour out of range
    expect(validateCron("0 9 * * 8")).toMatch(/invalid/i);    // dow out of range (max 7)
    expect(validateCron("0 9 * * abc")).toMatch(/invalid/i);  // garbage token
  });
});

describe("parseCron", () => {
  it("folds day-of-week 7 to 0 (both are Sunday)", () => {
    const p = parseCron("0 9 * * 7")!;
    expect(p.dow.has(0)).toBe(true);
    expect(p.dow.has(7)).toBe(false);
  });

  it("expands ranges and steps into explicit sets", () => {
    const p = parseCron("0 9 * * 1-5")!;
    expect([...p.dow].sort()).toEqual([1, 2, 3, 4, 5]);
    const q = parseCron("*/15 * * * *")!;
    expect([...q.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });
});

describe("nextRun", () => {
  it("computes the next daily run in the given timezone", () => {
    // Daily at 09:00. From 2026-06-22T06:00Z, in UTC, next is same-day 09:00Z.
    const from = new Date("2026-06-22T06:00:00Z");
    const when = nextRun("0 9 * * *", "UTC", from)!;
    expect(when.toISOString()).toBe("2026-06-22T09:00:00.000Z");
  });

  it("rolls to the next day when today's time already passed", () => {
    const from = new Date("2026-06-22T10:00:00Z"); // past 09:00
    const when = nextRun("0 9 * * *", "UTC", from)!;
    expect(when.toISOString()).toBe("2026-06-23T09:00:00.000Z");
  });

  it("respects the timezone offset (Europe/Berlin is UTC+2 in June)", () => {
    // 09:00 Berlin == 07:00 UTC in summer (CEST).
    const from = new Date("2026-06-22T00:00:00Z");
    const when = nextRun("0 9 * * *", "Europe/Berlin", from)!;
    expect(when.toISOString()).toBe("2026-06-22T07:00:00.000Z");
  });

  it("finds the next matching weekday", () => {
    // 2026-06-22 is a Monday. Weekly on Friday (5) at 09:00 UTC -> 2026-06-26.
    const from = new Date("2026-06-22T00:00:00Z");
    const when = nextRun("0 9 * * 5", "UTC", from)!;
    expect(when.getUTCDay()).toBe(5);
    expect(when.toISOString()).toBe("2026-06-26T09:00:00.000Z");
  });

  it("returns null for an invalid expression", () => {
    expect(nextRun("nonsense", "UTC")).toBeNull();
    expect(nextRun("0 9 * *", "UTC")).toBeNull();
  });
});

describe("formatNextRun", () => {
  it("renders a short human label in the target timezone", () => {
    const date = new Date("2026-06-22T07:00:00Z"); // 09:00 Berlin
    const label = formatNextRun(date, "Europe/Berlin");
    expect(label).toContain("9:00");
    expect(label).toMatch(/Jun/);
  });
});
