/**
 * #1703 — internal `<REDACTED:NAME>` secret-scrubber placeholders must never
 * render in user-facing output (candidate shortlist titles/reasons, .md/.json
 * export). The backend correctly replaces the secret VALUE with a marker; this
 * suite locks the display/export-time stripping of those markers.
 *
 * Also covers the shared display sanitizer (`sanitizeOutputText`) and the deep
 * JSON walker (`sanitizeJsonValue`).
 */
import { describe, it, expect } from "vitest";
import {
  stripInternalPlaceholders,
  sanitizeOutputText,
  sanitizeJsonValue,
  stripCitationTokens,
} from "@/lib/strip-citations";

describe("stripInternalPlaceholders (#1703)", () => {
  it("strips a <REDACTED:NAME> token mid-string and tidies whitespace", () => {
    expect(
      stripInternalPlaceholders("<REDACTED:EXTERNAL_APIFY_PROFILE_SCRAPER_MODE> Stack Entwickler"),
    ).toBe("Stack Entwickler");
  });

  it("strips a token inside a sentence without leaving a double space", () => {
    expect(
      stripInternalPlaceholders("A <REDACTED:EXTERNAL_APIFY_PROFILE_SCRAPER_MODE>-stack developer based in Berlin"),
    ).toBe("A -stack developer based in Berlin");
  });

  it("strips a bare <REDACTED> token", () => {
    expect(stripInternalPlaceholders("value is <REDACTED> now")).toBe("value is now");
  });

  it("strips multiple tokens", () => {
    expect(
      stripInternalPlaceholders("<REDACTED:A> and <REDACTED:B> done"),
    ).toBe("and done");
  });

  it("is idempotent", () => {
    const once = stripInternalPlaceholders("<REDACTED:X> Stack");
    expect(stripInternalPlaceholders(once)).toBe(once);
  });

  // #1752 — secret names allow mixed/lower case (manifest/MCP secrets permit
  // [A-Za-z_]); the marker name char-class must strip them all, not just UPPER.
  it("strips mixed/lower-case secret-name markers (#1752)", () => {
    expect(stripInternalPlaceholders("<REDACTED:apifyToken> Engineer")).toBe("Engineer");
    expect(stripInternalPlaceholders("<REDACTED:my_key> Engineer")).toBe("Engineer");
    expect(stripInternalPlaceholders("<REDACTED:Mixed_Case> Engineer")).toBe("Engineer");
  });

  it("strips lower/mixed-case markers via the combined sanitizer (#1752)", () => {
    expect(sanitizeOutputText("<REDACTED:apifyToken> Full Stack")).toBe("Full Stack");
    expect(sanitizeOutputText("<REDACTED:my_key> Full Stack")).toBe("Full Stack");
    expect(sanitizeOutputText("<REDACTED:Mixed_Case> Full Stack")).toBe("Full Stack");
  });

  it("leaves legitimate angle-bracket text alone", () => {
    expect(stripInternalPlaceholders("if a < b and b > c")).toBe("if a < b and b > c");
    // Not all-caps / not the REDACTED keyword -> untouched.
    expect(stripInternalPlaceholders("<div> content")).toBe("<div> content");
  });

  it("handles empty / nullish", () => {
    expect(stripInternalPlaceholders("")).toBe("");
    // @ts-expect-error runtime guard for non-string
    expect(stripInternalPlaceholders(null)).toBe("");
  });
});

describe("sanitizeOutputText (#1703 + #1700)", () => {
  it("strips both citation tokens and internal placeholders", () => {
    const O = "";
    const S = "";
    const C = "";
    const input = `${O}cite${S}turn0search3${C} <REDACTED:SECRET_X> Full Stack`;
    expect(sanitizeOutputText(input)).toBe("Full Stack");
  });

  it("leaves clean text untouched", () => {
    expect(sanitizeOutputText("Senior Backend Engineer")).toBe("Senior Backend Engineer");
  });
});

describe("sanitizeJsonValue (#1703 json export deep walk)", () => {
  it("strips placeholders from nested string values without mutating input", () => {
    const input = {
      candidates: [
        { name: "Benjamin Glanz", title: "<REDACTED:EXTERNAL_APIFY_PROFILE_SCRAPER_MODE> Stack Entwickler" },
        { name: "Pedro Rodriguez", title: "<REDACTED:EXTERNAL_APIFY_PROFILE_SCRAPER_MODE> Stack Engineer", score: 0.9 },
      ],
      note: null,
      count: 2,
    };
    const out = sanitizeJsonValue(input);
    expect(out.candidates[0].title).toBe("Stack Entwickler");
    expect(out.candidates[1].title).toBe("Stack Engineer");
    expect(out.candidates[1].score).toBe(0.9);
    expect(out.count).toBe(2);
    expect(out.note).toBeNull();
    // input untouched (no mutation)
    expect(input.candidates[0].title).toContain("<REDACTED:");
  });

  it("passes through primitives", () => {
    expect(sanitizeJsonValue(5)).toBe(5);
    expect(sanitizeJsonValue(true)).toBe(true);
    expect(sanitizeJsonValue("clean")).toBe("clean");
  });
});

describe("stripCitationTokens unchanged behaviour", () => {
  it("still only strips citation tokens, not REDACTED markers", () => {
    expect(stripCitationTokens("<REDACTED:X> kept")).toBe("<REDACTED:X> kept");
  });
});
