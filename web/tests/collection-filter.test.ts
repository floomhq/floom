import { describe, it, expect } from "vitest";
import { filterItems, matchesTags, matchesSearch } from "@/lib/collection/filter";
import { emptyState } from "@/lib/collection/url-state";
import type { CollectionState } from "@/lib/collection/types";

interface Item {
  id: string;
  name: string;
  status: string;
  content: string[];
}

const ITEMS: Item[] = [
  { id: "1", name: "Weekly Update", status: "ok", content: ["operations"] },
  { id: "2", name: "DACH Compliance", status: "failing", content: ["dach", "operations"] },
  { id: "3", name: "Gmail Intake", status: "ok", content: ["recruiting"] },
];

const acc = {
  searchOf: (i: Item) => i.name,
  tagsOf: (i: Item) => ({ status: [i.status], content: i.content }),
};

function withTags(tags: CollectionState["tags"], q = ""): CollectionState {
  return { ...emptyState(), q, tags };
}

describe("matchesSearch", () => {
  it("empty query matches everything", () => {
    expect(matchesSearch("", "anything")).toBe(true);
    expect(matchesSearch("   ", "anything")).toBe(true);
  });
  it("is case-insensitive substring", () => {
    expect(matchesSearch("week", "Weekly Update")).toBe(true);
    expect(matchesSearch("ZZ", "Weekly Update")).toBe(false);
  });
});

describe("matchesTags", () => {
  it("no active families matches everything", () => {
    expect(matchesTags({}, { status: ["ok"] })).toBe(true);
  });
  it("OR within a family", () => {
    expect(matchesTags({ status: ["ok", "failing"] }, { status: ["failing"] })).toBe(true);
  });
  it("AND across families", () => {
    expect(matchesTags({ status: ["ok"], content: ["dach"] }, { status: ["ok"], content: ["operations"] })).toBe(false);
    expect(matchesTags({ status: ["ok"], content: ["operations"] }, { status: ["ok"], content: ["operations"] })).toBe(true);
  });
  it("empty active value arrays do not filter", () => {
    expect(matchesTags({ status: [] }, { status: ["whatever"] })).toBe(true);
  });
});

describe("filterItems", () => {
  it("returns all items when nothing is active (default = all selected)", () => {
    expect(filterItems(ITEMS, emptyState(), acc)).toHaveLength(3);
  });

  it("filters by a single status tag", () => {
    const out = filterItems(ITEMS, withTags({ status: ["ok"] }), acc);
    expect(out.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("multi-select content tags (OR)", () => {
    const out = filterItems(ITEMS, withTags({ content: ["dach", "recruiting"] }), acc);
    expect(out.map((i) => i.id)).toEqual(["2", "3"]);
  });

  it("ANDs tags across families", () => {
    const out = filterItems(ITEMS, withTags({ status: ["ok"], content: ["operations"] }), acc);
    expect(out.map((i) => i.id)).toEqual(["1"]);
  });

  it("ANDs search with tags", () => {
    const out = filterItems(ITEMS, withTags({ content: ["operations"] }, "dach"), acc);
    expect(out.map((i) => i.id)).toEqual(["2"]);
  });
});
