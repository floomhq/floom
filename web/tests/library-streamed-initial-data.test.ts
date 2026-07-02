import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const libraryPage = readFileSync(join(process.cwd(), "app", "library", "page.tsx"), "utf8");
const brainCollection = readFileSync(join(process.cwd(), "app", "brain", "BrainCollection.tsx"), "utf8");
const serverApi = readFileSync(join(process.cwd(), "lib", "server-api.ts"), "utf8");
const clientApi = readFileSync(join(process.cwd(), "lib", "api.ts"), "utf8");

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

  it("bounds the server-side contexts seed fetch so route loading cannot hang forever", () => {
    expect(serverApi).toContain("export async function fetchBrainFolders()");
    expect(serverApi).toContain("new AbortController()");
    expect(serverApi).toContain("controller.abort()");
    expect(serverApi).toContain("signal: controller.signal");
  });

  it("bounds the client-side contexts list fetch so the Library can enter error state", () => {
    expect(clientApi).toContain("contexts: {");
    expect(clientApi).toContain("list: async () =>");
    expect(clientApi).toContain("controller.abort()");
    expect(clientApi).toContain("signal: controller.signal");
  });
});
