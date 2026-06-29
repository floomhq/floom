import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const RUN_PAGE = resolve(ROOT, "app/run/[id]/page.tsx");

function runHandlerSource(): string {
  const src = readFileSync(RUN_PAGE, "utf8");
  return src.slice(src.indexOf("async function handleRun"), src.indexOf("  // ---- Render states ----"));
}

describe("run page cache freshness", () => {
  it("clears stale run history only after a manual run is created", () => {
    const handleRun = runHandlerSource();

    expect(handleRun).toContain("api.workers.run(worker.id, inputs)");
    expect(handleRun).toContain('queryClient.removeQueries({ queryKey: ["runs"] })');
    expect(handleRun.indexOf("api.workers.run(worker.id, inputs)")).toBeLessThan(
      handleRun.indexOf('queryClient.removeQueries({ queryKey: ["runs"] })'),
    );
  });

  it("refreshes worker and overview state after manual runs", () => {
    const handleRun = runHandlerSource();

    expect(handleRun).toContain('queryClient.invalidateQueries({ queryKey: ["workers"] })');
    expect(handleRun).toContain('queryClient.invalidateQueries({ queryKey: ["system", "overview"] })');
  });
});
