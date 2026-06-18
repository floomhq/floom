import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { safeAppNext } from "@/lib/safe-next";

const ROOT = resolve(__dirname, "..");

function src(rel: string) {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("#465 OAuth login next sanitization", () => {
  it("rejects backslash, absolute, protocol-relative, and scheme-bearing next values", () => {
    for (const value of [
      "/\\evil.com",
      "https://evil.com/app",
      "//evil.com/app",
      "/app/javascript:alert(1)",
      "",
      undefined,
    ]) {
      expect(safeAppNext(value)).toBe("/app");
    }
  });

  it("login OAuth links sanitize next before building provider URLs", () => {
    const code = src("app/login/page.tsx");
    expect(code).toContain('import { safeAppNext } from "@/lib/safe-next"');
    expect(code).toContain("encodeURIComponent(safeAppNext(next))");
    expect(code).toContain("safeAppNext(sp.next)");
  });
});
