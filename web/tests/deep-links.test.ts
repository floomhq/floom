import { describe, it, expect } from "vitest";
import { pageForHash, deepLinkTarget } from "@/lib/deep-links";

describe("pageForHash", () => {
  it("maps each known page keyword to its route", () => {
    expect(pageForHash("#overview")).toBe("/overview");
    expect(pageForHash("#workers")).toBe("/workers");
    // R9: /brain renamed to /library; #brain and #library both map to /library
    expect(pageForHash("#brain")).toBe("/library");
    expect(pageForHash("#library")).toBe("/library");
    expect(pageForHash("#runs")).toBe("/runs");
    expect(pageForHash("#approvals")).toBe("/approvals");
    expect(pageForHash("#connections")).toBe("/connections");
    expect(pageForHash("#settings")).toBe("/settings");
  });

  it("tolerates a missing leading #", () => {
    expect(pageForHash("workers")).toBe("/workers");
  });

  it("ignores sub-paths and query suffixes (Emily anchors)", () => {
    expect(pageForHash("#workers/123")).toBe("/workers");
    expect(pageForHash("#runs?tag=failed")).toBe("/runs");
    expect(pageForHash("#workers:sel")).toBe("/workers");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(pageForHash("#Workers")).toBe("/workers");
    expect(pageForHash("  #RUNS ")).toBe("/runs");
  });

  it("returns null for unknown or empty hashes", () => {
    expect(pageForHash("")).toBeNull();
    expect(pageForHash("#")).toBeNull();
    expect(pageForHash(null)).toBeNull();
    expect(pageForHash(undefined)).toBeNull();
    expect(pageForHash("#slack-oauth-state")).toBeNull(); // SlackConnect hash state
  });
});

describe("deepLinkTarget", () => {
  it("returns the route when the hash points elsewhere", () => {
    expect(deepLinkTarget("/overview", "#workers")).toBe("/workers");
    expect(deepLinkTarget("/", "#runs")).toBe("/runs");
  });

  it("returns null when already on the target page", () => {
    expect(deepLinkTarget("/workers", "#workers")).toBeNull();
    expect(deepLinkTarget("/workers/abc", "#workers")).toBeNull();
  });

  it("returns null for unrecognized hashes", () => {
    expect(deepLinkTarget("/overview", "#nope")).toBeNull();
    expect(deepLinkTarget("/overview", "")).toBeNull();
  });
});
