import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("cloud cli-auth endpoint seam", () => {
  it("uses the cloud server route instead of the generic proxy path", () => {
    const source = readFileSync("app/cli-auth/page.tsx", "utf8");
    expect(source).toContain('endpointBase="/app/api/cli-auth"');
    expect(source).toContain('loginPath="/app/login"');
    expect(source).not.toContain("/app/api/proxy/auth/cli");
  });
});
