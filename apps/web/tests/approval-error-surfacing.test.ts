import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("approval fetch and decision surfacing", () => {
  it("shows a visible run-detail approval load error instead of swallowing it", () => {
    const page = source("app/runs/[id]/page.tsx");

    expect(page).toContain("approvalLoadError");
    expect(page).toContain("Could not load the approval card.");
    expect(page).toContain("setApprovalLoadError(message)");
    expect(page).not.toContain("catch {\n          // ignore");
  });

  it("keeps standalone approval decisions synchronized with the shared queue", () => {
    const page = source("app/approvals/review/page.tsx");

    expect(page).toContain("notifyApprovalsChanged");
    expect(page).toContain("if (!isSignedLink) void load();");
    expect(page).toContain("Could not load approvals.");
  });

  it("shows main approvals list fetch failures instead of silently failing", () => {
    const page = source("app/approvals/page.tsx");

    expect(page).toContain("loadError");
    expect(page).toContain("Could not load approvals.");
    expect(page).not.toContain("catch {\n      // silently fail");
  });
});
