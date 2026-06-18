import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADVANCED_DETAIL_TABS,
  BASE_DETAIL_TABS,
  getPinnedTabs,
  savePinnedTabs,
} from "@/lib/workers/pinned-tabs";
import type { WorkerDetailTab } from "@/lib/workers/tabs";

const LS_KEY = "floom.workerDetail.pinnedTabs";

// Minimal in-memory localStorage so the helper's persistence is testable in the
// default node env (no jsdom QueryClient harness needed).
function installLocalStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pinned-tabs tab sets", () => {
  it("primary tabs are Overview, Runs and Setup (round-09)", () => {
    expect([...BASE_DETAIL_TABS]).toEqual(["Overview", "Runs", "Setup"]);
  });

  it("advanced (pinnable) tabs are Source, Versions, Brain, Tools in canonical order", () => {
    expect(ADVANCED_DETAIL_TABS).toEqual(["Source", "Versions", "Brain", "Tools"]);
  });
});

describe("getPinnedTabs / savePinnedTabs", () => {
  it("round-trips a pinned set under the stable localStorage key", () => {
    const store = installLocalStorage();
    savePinnedTabs(new Set<WorkerDetailTab>(["Source"]));
    expect(store[LS_KEY]).toBe(JSON.stringify(["Source"]));
    expect([...getPinnedTabs()]).toEqual(["Source"]);
  });

  it("persists in canonical order regardless of insertion order", () => {
    const store = installLocalStorage();
    savePinnedTabs(new Set<WorkerDetailTab>(["Brain", "Source"]));
    expect(store[LS_KEY]).toBe(JSON.stringify(["Source", "Brain"]));
  });

  it("ignores unknown / base tabs in stored data (no poisoned bar)", () => {
    const store = installLocalStorage();
    store[LS_KEY] = JSON.stringify(["Overview", "Bogus", "Source"]);
    expect([...getPinnedTabs()]).toEqual(["Source"]);
  });

  it("returns an empty set on malformed JSON", () => {
    const store = installLocalStorage();
    store[LS_KEY] = "{not json";
    expect(getPinnedTabs().size).toBe(0);
  });

  it("returns an empty set with no window (SSR)", () => {
    // No window stubbed → SSR guard returns empty.
    expect(getPinnedTabs().size).toBe(0);
  });
});
