import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, test } from "vitest";
import { sanitizeRedirect } from "@/lib/redirects";

const ROOT = resolve(__dirname, "..");

function src(rel: string) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("#1188/#1497 redirect sanitization", () => {
  test("safe relative paths pass through unchanged", () => {
    const safe: [string, string][] = [
      ["/overview", "/overview"],
      ["/workers", "/workers"],
      ["/workers/new", "/workers/new"],
      ["/settings/profile", "/settings/profile"],
      ["/overview?tab=runs", "/overview?tab=runs"],
      ["/workers/abc-123/runs", "/workers/abc-123/runs"],
    ];
    for (const [path, expected] of safe) {
      expect(sanitizeRedirect(path)).toBe(expected);
    }
  });

  test("absolute, protocol-relative, backslash, and scheme redirects are rejected", () => {
    const evil = [
      "https://evil.com",
      "http://evil.com/steal",
      "ftp://evil.com",
      "//evil.com",
      "//evil.com/steal",
      "/\\evil.com",
      "/\\\\evil.com",
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "/path/javascript:evil",
      null,
      undefined,
      "",
    ];
    for (const value of evil) {
      expect(sanitizeRedirect(value)).toBe("/overview");
    }
  });

  test("connections can use a connections-specific fallback", () => {
    expect(sanitizeRedirect("/\\evil.com", "/connections")).toBe("/connections");
    expect(sanitizeRedirect("//evil.com", "/connections")).toBe("/connections");
  });

  test("magic link, login, and connection flows all use the shared sanitizer", () => {
    const magic = src("app/auth/magic/[token]/page.tsx");
    const login = src("app/login/page.tsx");
    const redirect = src("app/connections/redirect/page.tsx");
    const connect = src("app/connections/connect/[app]/page.tsx");

    for (const [name, code] of [
      ["magic", magic],
      ["login", login],
      ["connections redirect", redirect],
      ["connections connect", connect],
    ] as const) {
      expect(code, `${name} imports shared sanitizer`).toContain(
        'import { sanitizeRedirect } from "@/lib/redirects"',
      );
    }

    expect(magic).toContain("sanitizeRedirect(result.redirect_to)");
    expect(magic).not.toContain("router.replace(result.redirect_to");
    expect(login).toContain("const next = sanitizeRedirect(rawNext)");
    expect(redirect).toContain('sanitizeRedirect(value, "/connections")');
    expect(connect).toContain('sanitizeRedirect(value, "/connections")');
  });
});
