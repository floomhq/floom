import { describe, it, expect } from "vitest";
import { SUPPORTED_APPS, getSupportedApp } from "@/components/connections/connection-data";

// #docusign-catalog: sow-docusign-sender (workspace stmnt-studios) declares a
// `docusign` connection requirement. Before this fix, docusign had no catalog
// entry so it fell through getSupportedApp's generic fallback (title-cased
// slug, no curated icon). This locks in the real display name so the app
// never silently regresses back to "Docusign".
describe("docusign catalog entry", () => {
  it("is present in SUPPORTED_APPS", () => {
    const entry = SUPPORTED_APPS.find((app) => app.slug === "docusign");
    expect(entry).toBeDefined();
    expect(entry?.displayName).toBe("DocuSign");
  });

  it("getSupportedApp resolves the curated display name, not the generic fallback", () => {
    const app = getSupportedApp("docusign");
    expect(app.displayName).toBe("DocuSign");
    expect(app.slug).toBe("docusign");
  });
});
