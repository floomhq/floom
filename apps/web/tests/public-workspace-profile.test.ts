import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicWorkspaceProfilePath, isPublicWorkerPermalinkPath } from "@/lib/public-workspace-routes";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

describe("public workspace profile", () => {
  it("fetches the public profile without privileged headers", () => {
    const source = read("lib/server-api.ts");
    expect(source).toContain("fetchPublicWorkspaceProfile");
    expect(source).toContain("`/workspaces/public/${encodeURIComponent(handle)}`");
    expect(source).toContain("includeWorkspace: false, includeSecret: false");
  });

  it("keeps the root dynamic route scoped to handle-style profile paths", () => {
    const source = read("app/[handle]/page.tsx");
    expect(source).toContain("decodeURIComponent(rawHandle)");
    expect(source).toContain('if (!handle.startsWith("@")) notFound();');
    expect(source).toContain("fetchPublicWorkspaceProfile(slug)");
    expect(source).toContain("Public workspace");
    expect(source).toContain("No public assets are listed in this workspace.");
  });

  it("renders handle profile pages outside the app shell", () => {
    const source = read("components/layout/AppShell.tsx");
    expect(source).toContain("isPublicWorkspaceProfilePath(pathname)");
  });

  it("matches only single-segment public workspace profile paths", () => {
    expect(isPublicWorkspaceProfilePath("/@fede-secretary")).toBe(true);
    expect(isPublicWorkspaceProfilePath("/@fede-secretary/")).toBe(true);
    expect(isPublicWorkspaceProfilePath("/@fede-secretary/settings")).toBe(false);
    expect(isPublicWorkspaceProfilePath("/@")).toBe(false);
    expect(isPublicWorkspaceProfilePath("/app/@fede-secretary")).toBe(false);
  });

  // Regression: #2211 shipped the two-segment /@{handle}/{workerSlug} L4
  // permalink page but never taught AppShell's standalone-chrome check about
  // it, so it silently mounted inside the full authenticated dashboard shell
  // (Sidebar/EmilyDock/CommandPalette/DeepLinkRouter/TermsAcceptanceGate) —
  // the confirmed root cause of a client-side $exception hit on real permalink
  // loads (systemic: 2+ accounts, 5 slugs, 48h). isPublicWorkerPermalinkPath is
  // a SEPARATE predicate from isPublicWorkspaceProfilePath on purpose: the
  // latter also drives proxy.ts's noindex marking, and the permalink page is
  // deliberately indexable, so the two must not be folded into one function.
  it("matches only two-segment worker permalink paths", () => {
    expect(isPublicWorkerPermalinkPath("/@fede/meeting-prep")).toBe(true);
    expect(isPublicWorkerPermalinkPath("/@fede/meeting-prep/")).toBe(true);
    expect(isPublicWorkerPermalinkPath("/@openpaper/construction-intel-weekly")).toBe(true);
    expect(isPublicWorkerPermalinkPath("/@fede-secretary")).toBe(false);
    expect(isPublicWorkerPermalinkPath("/@")).toBe(false);
    expect(isPublicWorkerPermalinkPath("/app/@fede/meeting-prep")).toBe(false);
  });

  it("renders worker permalink pages outside the app shell", () => {
    const source = read("components/layout/AppShell.tsx");
    expect(source).toContain("isPublicWorkerPermalinkPath(pathname)");
  });
});
