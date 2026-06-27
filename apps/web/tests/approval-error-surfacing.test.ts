import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("approval fetch and decision surfacing", () => {
  it("keeps run detail routes on the dedicated run detail surface", () => {
    const page = source("app/runs/[id]/page.tsx");

    expect(page).toContain("<RunDetailPageClient runId={id} initialTab={tab} />");
    expect(page).not.toContain("redirect(");
    expect(page).not.toContain("approvalLoadError");
  });

  it("keeps standalone approval decisions synchronized with the shared queue", () => {
    const page = source("app/approvals/review/page.tsx");

    expect(page).toContain("notifyApprovalsChanged");
    expect(page).toContain("if (!isSignedLink) void load();");
    expect(page).toContain("Could not load approvals.");
  });

  it("shows main approvals list fetch failures instead of silently failing", () => {
    // Migrated to the <Collection> model — surfacing now lives in ApprovalsCollection.
    const page = source("app/approvals/ApprovalsCollection.tsx");

    expect(page).toContain("setError");
    expect(page).toContain("Could not load approvals.");
    expect(page).not.toContain("catch {\n      // silently fail");
  });
});
