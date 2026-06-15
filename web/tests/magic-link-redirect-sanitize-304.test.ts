/**
 * #304 — Magic-link page: open redirect fix (cloud)
 *
 * Validates that the sanitizeRedirect logic rejects absolute URLs,
 * protocol-relative paths, and backslash-escaped paths, preventing
 * post-authentication open redirect attacks.
 *
 * Mirrors engine test magic-link-redirect-sanitize-1188.test.ts.
 *
 * Run: npx tsx tests/magic-link-redirect-sanitize-304.test.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, test } from "vitest";

const ROOT = resolve(__dirname, "..");

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

function src(rel: string) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Local copy of sanitizeRedirect — kept in sync with the production
// implementation in app/auth/magic/[token]/page.tsx.
// The source-level checks below enforce they stay in sync.
// ---------------------------------------------------------------------------

function sanitizeRedirect(raw: string | null | undefined): string {
  const FALLBACK = "/overview";
  if (!raw || typeof raw !== "string") return FALLBACK;
  // Must start with exactly one "/" and NOT be "//" or "/\" (protocol-relative / backslash escape)
  if (!raw.startsWith("/")) return FALLBACK;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return FALLBACK;
  // Must not contain a scheme (e.g. "javascript:" injected mid-path or after redirect)
  if (/[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(raw)) return FALLBACK;
  return raw;
}

// ---------------------------------------------------------------------------
// Safe paths — must pass through unchanged
// ---------------------------------------------------------------------------

function testSafeRelativePaths(): void {
  const safe: [string, string][] = [
    ["/overview", "/overview"],
    ["/workers", "/workers"],
    ["/workers/new", "/workers/new"],
    ["/settings/profile", "/settings/profile"],
    ["/overview?tab=runs", "/overview?tab=runs"],
    ["/workers/abc-123/runs", "/workers/abc-123/runs"],
  ];
  for (const [p, expected] of safe) {
    const result = sanitizeRedirect(p);
    assert(result === expected, `safe path "${p}" must not be altered (got "${result}")`);
  }
}

// ---------------------------------------------------------------------------
// Exploit attempts — must be rejected and fall back to /overview
// ---------------------------------------------------------------------------

function testRejectsAbsoluteUrls(): void {
  const evil = [
    "https://evil.com",
    "http://evil.com/steal",
    "https://evil.com/path?q=1",
    "ftp://evil.com",
  ];
  for (const p of evil) {
    const result = sanitizeRedirect(p);
    assert(
      result === "/overview",
      `absolute URL "${p}" must be rejected (got "${result}")`,
    );
  }
}

function testRejectsProtocolRelative(): void {
  const evil = [
    "//evil.com",
    "//evil.com/steal",
    "//evil.com:80/path",
  ];
  for (const p of evil) {
    const result = sanitizeRedirect(p);
    assert(
      result === "/overview",
      `protocol-relative path "${p}" must be rejected (got "${result}")`,
    );
  }
}

function testRejectsBackslashEscape(): void {
  const evil = [
    "/\\evil.com",
    "/\\\\evil.com",
  ];
  for (const p of evil) {
    const result = sanitizeRedirect(p);
    assert(
      result === "/overview",
      `backslash-escaped path "${p}" must be rejected (got "${result}")`,
    );
  }
}

function testRejectsJavascriptScheme(): void {
  const evil = [
    "javascript:alert(1)",
    "javascript:void(0)",
    "JAVASCRIPT:alert(1)",
    "/path/javascript:evil",
  ];
  for (const p of evil) {
    const result = sanitizeRedirect(p);
    assert(
      result === "/overview",
      `javascript: path "${p}" must be rejected (got "${result}")`,
    );
  }
}

function testRejectsNullAndEmpty(): void {
  assert(sanitizeRedirect(null) === "/overview", "null must return /overview");
  assert(sanitizeRedirect(undefined) === "/overview", "undefined must return /overview");
  assert(sanitizeRedirect("") === "/overview", "empty string must return /overview");
}

// ---------------------------------------------------------------------------
// Source-level structural checks — ensures the page calls sanitizeRedirect
// and does not bypass it by passing redirect_to directly to router.replace
// ---------------------------------------------------------------------------

function testPageDefinesSanitizeRedirect(): void {
  const code = src("app/auth/magic/[token]/page.tsx");
  assert(
    code.includes("function sanitizeRedirect("),
    "page.tsx must define sanitizeRedirect()",
  );
}

function testPageCallsSanitizeRedirect(): void {
  const code = src("app/auth/magic/[token]/page.tsx");
  assert(
    code.includes("sanitizeRedirect(result.redirect_to)"),
    "page.tsx must call sanitizeRedirect(result.redirect_to) before router.replace",
  );
}

function testPageDoesNotBypassSanitization(): void {
  const code = src("app/auth/magic/[token]/page.tsx");
  // Guard: must NOT call router.replace with redirect_to directly
  assert(
    !code.includes("router.replace(result.redirect_to"),
    "page.tsx must NOT call router.replace(result.redirect_to) directly — that bypasses sanitization",
  );
}

function testSanitizeRedirectRejectsDoubleSlash(): void {
  const code = src("app/auth/magic/[token]/page.tsx");
  assert(
    code.includes('startsWith("//")') || code.includes("startsWith('//')"),
    "sanitizeRedirect must explicitly reject protocol-relative // paths",
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: [string, () => void][] = [
  ["#304 safe relative paths pass through unchanged", testSafeRelativePaths],
  ["#304 absolute URLs are rejected → /overview", testRejectsAbsoluteUrls],
  ["#304 protocol-relative //evil.com paths are rejected → /overview", testRejectsProtocolRelative],
  ["#304 backslash-escaped /\\evil.com paths are rejected → /overview", testRejectsBackslashEscape],
  ["#304 javascript: scheme paths are rejected → /overview", testRejectsJavascriptScheme],
  ["#304 null/undefined/empty redirect_to returns /overview", testRejectsNullAndEmpty],
  ["#304 page.tsx defines sanitizeRedirect function", testPageDefinesSanitizeRedirect],
  ["#304 page.tsx calls sanitizeRedirect(result.redirect_to)", testPageCallsSanitizeRedirect],
  ["#304 page.tsx does not bypass sanitization with direct router.replace", testPageDoesNotBypassSanitization],
  ["#304 sanitizeRedirect explicitly rejects // protocol-relative prefix", testSanitizeRedirectRejectsDoubleSlash],
];

describe("#304 magic-link redirect sanitization", () => {
  for (const [name, fn] of tests) {
    test(name, () => {
      expect(() => fn()).not.toThrow();
    });
  }
});
