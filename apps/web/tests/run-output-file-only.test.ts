import { describe, expect, it } from "vitest";

import { isFileOnlyOutputField } from "@/app/runs/RunsCollection";

describe("run output file-only fields", () => {
  it("detects file outputs already represented by artifacts", () => {
    expect(
      isFileOnlyOutputField(
        { name: "bundle", label: "Worker bundle", type: "file", value: "out/bundle.json" },
        [
          {
            id: "artifact-1",
            run_id: "run-1",
            name: "bundle.json",
            path: "out/bundle.json",
            relative_path: "out/bundle.json",
            created_at: "2026-06-26T00:00:00Z",
          },
        ],
      ),
    ).toBe(true);
  });

  it("keeps human-readable outputs visible", () => {
    expect(
      isFileOnlyOutputField(
        { name: "summary", label: "Summary", type: "markdown", value: "## Worker created" },
        [],
      ),
    ).toBe(false);
  });
});
