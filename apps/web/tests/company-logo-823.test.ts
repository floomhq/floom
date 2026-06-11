import { describe, it, expect } from "vitest";
import { guessDomain, companyLogoUrl, prefillWorkspaceName } from "@/lib/workspace/company-logo";

// §5a2 (#823): company field → logo + name prefill.

describe("guessDomain", () => {
  it("uses a dotted input verbatim (stripping protocol/path)", () => {
    expect(guessDomain("acme.com")).toBe("acme.com");
    expect(guessDomain("https://acme.io/about")).toBe("acme.io");
  });
  it("guesses <slug>.com for a plain name", () => {
    expect(guessDomain("Acme")).toBe("acme.com");
    expect(guessDomain("Big Co")).toBe("bigco.com");
  });
  it("returns null for empty", () => {
    expect(guessDomain("   ")).toBeNull();
  });
});

describe("companyLogoUrl", () => {
  it("builds a favicon URL for the derived domain", () => {
    expect(companyLogoUrl("Acme")).toContain("domain=acme.com");
    expect(companyLogoUrl("")).toBeNull();
  });
});

describe("prefillWorkspaceName", () => {
  it("title-cases and strips the TLD", () => {
    expect(prefillWorkspaceName("acme.com")).toBe("Acme");
    expect(prefillWorkspaceName("big co")).toBe("Big Co");
    expect(prefillWorkspaceName("")).toBe("");
  });
});
