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
  it("builds a DuckDuckGo favicon URL for explicit domain inputs", () => {
    // Explicit domain → DuckDuckGo favicon URL.
    expect(companyLogoUrl("acme.com")).toContain("icons.duckduckgo.com");
    expect(companyLogoUrl("acme.com")).toContain("acme.com.ico");
    expect(companyLogoUrl("https://acme.io/about")).toContain("acme.io.ico");
    // Empty → null.
    expect(companyLogoUrl("")).toBeNull();
  });
  it("also returns a favicon URL for plain company-named slugs (DuckDuckGo 404s on miss)", () => {
    // DuckDuckGo returns a real HTTP 404 for unknown domains, so onError fires
    // in the browser and the Avatar component falls back to the generated mark.
    // This means we can safely return a URL for all non-empty slugs — the
    // 404-on-miss path handles non-company names cleanly without any globe placeholder.
    expect(companyLogoUrl("reltix")).toContain("reltix.com.ico");
    expect(companyLogoUrl("Heidi Health")).toContain("heidihealth.com.ico");
    expect(companyLogoUrl("Nova Search")).toContain("novasearch.com.ico");
    // Non-company names also get a URL; they'll 404 → onError → generated mark.
    expect(companyLogoUrl("content-pipeline")).toContain("contentpipeline.com.ico");
    expect(companyLogoUrl("Acme")).toContain("acme.com.ico");
  });
});

describe("prefillWorkspaceName", () => {
  it("title-cases and strips the TLD", () => {
    expect(prefillWorkspaceName("acme.com")).toBe("Acme");
    expect(prefillWorkspaceName("big co")).toBe("Big Co");
    expect(prefillWorkspaceName("")).toBe("");
  });
});
