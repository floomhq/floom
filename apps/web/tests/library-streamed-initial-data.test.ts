import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const libraryPage = readFileSync(join(process.cwd(), "app", "library", "page.tsx"), "utf8");
const brainCollection = readFileSync(join(process.cwd(), "app", "brain", "BrainCollection.tsx"), "utf8");

describe("Library initial data loading", () => {
  it("does not block the server render on the contexts list fetch", () => {
    expect(libraryPage).toContain("initialFoldersPromise");
    expect(libraryPage).toContain("fetchBrainFolders().catch");
    expect(libraryPage).not.toContain("export default async function LibraryPage");
    expect(libraryPage).not.toContain("await fetchBrainFolders");
  });

  it("seeds the contexts query cache from the streamed promise", () => {
    expect(brainCollection).toContain("useStreamedInitialData(qk.contexts, initialFoldersPromise)");
    expect(brainCollection).toContain("initialFoldersPromise?: Promise<ContextSummary[]>");
  });
});
