import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(source).toContain('pathname.startsWith("/@")');
  });
});
