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
  it("returns a DuckDuckGo favicon URL only for dot-qualified domain inputs", () => {
    // Dot-qualified input (real domain) → DuckDuckGo favicon URL.
    expect(companyLogoUrl("acme.com")).toContain("icons.duckduckgo.com");
    expect(companyLogoUrl("acme.com")).toContain("acme.com.ico");
    expect(companyLogoUrl("https://acme.io/about")).toContain("acme.io.ico");
    // Empty → null.
    expect(companyLogoUrl("")).toBeNull();
  });
  it("returns null for plain workspace names — no slug guessing", () => {
    // Plain names (no dot) must return null. The workspace mark renders the
    // clean generated mark. Slug guessing ("Nova Search" → novasearch.com) is
    // forbidden because favicon services return generic placeholder icons for
    // unknown domains, which look like a broken logo (gray globe/DDG icon).
    expect(companyLogoUrl("Nova Search")).toBeNull();
    expect(companyLogoUrl("content-pipeline")).toBeNull();
    expect(companyLogoUrl("Floom Admin")).toBeNull();
    expect(companyLogoUrl("Acme")).toBeNull();
    expect(companyLogoUrl("reltix")).toBeNull();
    expect(companyLogoUrl("Heidi Health")).toBeNull();
    expect(companyLogoUrl("   ")).toBeNull();
  });
});

describe("prefillWorkspaceName", () => {
  it("title-cases and strips the TLD", () => {
    expect(prefillWorkspaceName("acme.com")).toBe("Acme");
    expect(prefillWorkspaceName("big co")).toBe("Big Co");
    expect(prefillWorkspaceName("")).toBe("");
  });
});
