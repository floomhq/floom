import { describe, it, expect } from "vitest";
import { isImageFile, traceSteps } from "@/lib/runs/trace";
import { RUN_DETAIL_TABS } from "@/lib/runs/tabs";
import type { TranscriptRow } from "@/lib/types";

describe("isImageFile", () => {
  it("matches image extensions case-insensitively", () => {
    for (const n of ["chart.png", "a.JPEG", "x.jpg", "y.gif", "z.webp", "v.svg"]) {
      expect(isImageFile(n)).toBe(true);
    }
  });
  it("rejects non-images and empties", () => {
    for (const n of ["report.csv", "data.json", "notes.md", "", undefined, null]) {
      expect(isImageFile(n)).toBe(false);
    }
  });
});

describe("traceSteps", () => {
  it("labels by role, then type, then name, then index", () => {
    const rows: TranscriptRow[] = [
      { role: "assistant", content: "hi" },
      { type: "tool", content: "x" },
      { name: "fetch", content: "y" },
      { content: "z" },
    ];
    expect(traceSteps(rows).map((s) => s.label)).toEqual([
      "assistant",
      "tool",
      "fetch",
      "Step 4",
    ]);
  });
  it("summarizes object content as JSON and truncates", () => {
    const rows: TranscriptRow[] = [{ role: "tool", content: { a: 1 } }];
    expect(traceSteps(rows)[0].content).toBe('{"a":1}');
  });
  it("falls back to arguments when content is absent", () => {
    const rows: TranscriptRow[] = [{ name: "fetch", arguments: { url: "x" } }];
    expect(traceSteps(rows)[0].content).toBe('{"url":"x"}');
  });
  it("returns [] for undefined", () => {
    expect(traceSteps(undefined)).toEqual([]);
  });
});

describe("RUN_DETAIL_TABS (§4 contract)", () => {
  it("is exactly Output · Logs · Inputs (Raw is a Preview/Raw toggle, not a tab)", () => {
    expect([...RUN_DETAIL_TABS]).toEqual(["Output", "Logs", "Inputs"]);
  });
});
