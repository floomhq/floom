import { describe, it, expect } from "vitest";
import {
  GENERAL_ACCESS_OPTIONS,
  generalAccessLabel,
  shareSummary,
  publicLinkScope,
} from "@/lib/sharing/share-model";

describe("General access (rule #8: no public level)", () => {
  it("offers exactly Private and Workspace, in order", () => {
    expect(GENERAL_ACCESS_OPTIONS.map((o) => o.value)).toEqual(["private", "workspace"]);
  });
  it("never offers a 'public' level", () => {
    expect(GENERAL_ACCESS_OPTIONS.some((o) => String(o.value) === "public")).toBe(false);
  });
});

describe("generalAccessLabel", () => {
  it("labels each stored visibility", () => {
    expect(generalAccessLabel("private")).toBe("Private");
    expect(generalAccessLabel("workspace")).toBe("Workspace");
    expect(generalAccessLabel("specific_people")).toBe("Specific people");
    expect(generalAccessLabel(undefined)).toBe("Private");
  });
});

describe("shareSummary", () => {
  it("always frames sharing as view & duplicate", () => {
    expect(shareSummary("workspace")).toMatch(/view and duplicate/i);
    expect(shareSummary("specific_people")).toMatch(/view and duplicate/i);
    expect(shareSummary("private")).toMatch(/only you/i);
  });
});

describe("publicLinkScope", () => {
  it("describes what an anonymous public link exposes, per asset type", () => {
    expect(publicLinkScope("run")).toMatch(/inputs, steps, tool calls/i);
    expect(publicLinkScope("worker")).toMatch(/inspect its files, and duplicate/i);
    expect(publicLinkScope("brain_pack")).toMatch(/brain pack/i);
    expect(publicLinkScope("brain_file")).toMatch(/this file/i);
    expect(publicLinkScope("approval")).toMatch(/approve, or reject/i);
  });
});
