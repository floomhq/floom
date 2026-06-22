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
  it("builds a favicon URL only for dot-qualified domain inputs", () => {
    // Explicit domain → favicon URL (real company logo likely exists).
    expect(companyLogoUrl("acme.com")).toContain("domain=acme.com");
    expect(companyLogoUrl("https://acme.io/about")).toContain("domain=acme.io");
    // Empty → null.
    expect(companyLogoUrl("")).toBeNull();
  });
  it("returns null for plain slugs without a dot (personal/non-company names)", () => {
    // These workspace names would only produce a generic globe favicon from the
    // favicon service — return null so the caller falls back to the gradient squircle.
    expect(companyLogoUrl("depontefede")).toBeNull();
    expect(companyLogoUrl("fede-production")).toBeNull();
    expect(companyLogoUrl("content-pipeline")).toBeNull();
    expect(companyLogoUrl("Acme")).toBeNull();
    expect(companyLogoUrl("My Workspace")).toBeNull();
  });
});

describe("prefillWorkspaceName", () => {
  it("title-cases and strips the TLD", () => {
    expect(prefillWorkspaceName("acme.com")).toBe("Acme");
    expect(prefillWorkspaceName("big co")).toBe("Big Co");
    expect(prefillWorkspaceName("")).toBe("");
  });
});
