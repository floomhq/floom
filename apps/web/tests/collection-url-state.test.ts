import { describe, it, expect } from "vitest";
import {
  parseCollectionState,
  serializeCollectionState,
  toggleTag,
  clearTags,
  noTagsActive,
  emptyState,
} from "@/lib/collection/url-state";

describe("parseCollectionState", () => {
  it("returns defaults for empty params", () => {
    const s = parseCollectionState(new URLSearchParams(), "grid");
    expect(s).toEqual({ sel: null, tab: null, view: "grid", q: "", tags: {} });
  });

  it("parses sel/tab/view/q", () => {
    const s = parseCollectionState(
      new URLSearchParams("sel=w1&tab=Source&view=grid&q=weekly"),
    );
    expect(s.sel).toBe("w1");
    expect(s.tab).toBe("Source");
    expect(s.view).toBe("grid");
    expect(s.q).toBe("weekly");
  });

  it("falls back to default view for an invalid view value", () => {
    expect(parseCollectionState(new URLSearchParams("view=mosaic"), "list").view).toBe("list");
  });

  it("parses repeatable tag params into families, deduped", () => {
    const s = parseCollectionState(
      new URLSearchParams("tag=status:running&tag=status:failed&tag=content:dach&tag=status:running"),
    );
    expect(s.tags.status).toEqual(["running", "failed"]);
    expect(s.tags.content).toEqual(["dach"]);
  });

  it("ignores unknown families and malformed tags", () => {
    const s = parseCollectionState(
      new URLSearchParams("tag=bogus:x&tag=status&tag=:y&tag=content:ok"),
    );
    expect(s.tags).toEqual({ content: ["ok"] });
  });
});

describe("serializeCollectionState", () => {
  it("omits defaults (clean URL)", () => {
    expect(serializeCollectionState(emptyState("list"), "list").toString()).toBe("");
  });

  it("omits tab when nothing is selected", () => {
    const s = { ...emptyState(), tab: "Source" };
    expect(serializeCollectionState(s).toString()).toBe("");
  });

  it("round-trips a fully populated state deterministically", () => {
    const s = {
      sel: "w1",
      tab: "Source",
      view: "grid" as const,
      q: "abc",
      tags: { content: ["dach", "ops"], status: ["running"] },
    };
    const url = serializeCollectionState(s, "list");
    // family order: status before content
    expect(url.getAll("tag")).toEqual(["status:running", "content:dach", "content:ops"]);
    expect(parseCollectionState(url, "list")).toEqual(s);
  });
});

describe("toggleTag / clearTags / noTagsActive", () => {
  it("adds then removes a value, pruning empty families", () => {
    let s = emptyState();
    s = toggleTag(s, "status", "running");
    expect(s.tags.status).toEqual(["running"]);
    s = toggleTag(s, "status", "running");
    expect(s.tags.status).toBeUndefined();
    expect(noTagsActive(s)).toBe(true);
  });

  it("clearTags resets all families", () => {
    let s = toggleTag(emptyState(), "content", "dach");
    s = toggleTag(s, "status", "failed");
    expect(noTagsActive(s)).toBe(false);
    s = clearTags(s);
    expect(s.tags).toEqual({});
    expect(noTagsActive(s)).toBe(true);
  });

  it("does not mutate the input state", () => {
    const s = emptyState();
    toggleTag(s, "status", "x");
    expect(s.tags).toEqual({});
  });
});
