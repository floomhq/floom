/**
 * Magic-link page contract.
 *
 * Cloud GET /auth/magic/:token is a redirect endpoint, so the page must use a
 * full browser navigation through the same-origin proxy. It must not fetch JSON
 * or navigate to a backend-provided URL from client code.
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

function testPageUsesSameOriginProxyNavigation(): void {
  const code = src("app/auth/magic/[token]/page.tsx");
  assert(
    code.includes("window.location.assign") && code.includes("/api/proxy/auth/magic/"),
    "page.tsx must navigate through /api/proxy/auth/magic/:token",
  );
}

function testPageDoesNotFetchRedirectEndpointAsJson(): void {
  const code = src("app/auth/magic/[token]/page.tsx");
  assert(
    !code.includes("consumeMagicLink") && !code.includes("fetchJson"),
    "page.tsx must not fetch the redirect endpoint as JSON",
  );
}

function testPageDoesNotUseBackendRedirectUrlInClientCode(): void {
  const code = src("app/auth/magic/[token]/page.tsx");
  assert(
    !code.includes("redirect_to") && !code.includes("router.replace"),
    "page.tsx must not accept a client-side redirect target from the backend",
  );
}

const tests: [string, () => void][] = [
  ["magic-link page navigates through same-origin proxy", testPageUsesSameOriginProxyNavigation],
  ["magic-link page does not fetch redirect endpoint as JSON", testPageDoesNotFetchRedirectEndpointAsJson],
  ["magic-link page does not use backend redirect target in client code", testPageDoesNotUseBackendRedirectUrlInClientCode],
];

describe("magic-link page redirect contract", () => {
  for (const [name, fn] of tests) {
    test(name, () => {
      expect(() => fn()).not.toThrow();
    });
  }
});
