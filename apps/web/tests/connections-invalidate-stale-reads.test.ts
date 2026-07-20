import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #1209/#1206: the connections/worker-detail/overview reads are served from a
// shared, persisted (localStorage) TanStack Query cache with a 30s staleTime
// and refetchOnMount:false (see components/providers/QueryProvider.tsx). Any
// surface that renders that cache can go stale right after a connection
// completes unless the completion point invalidates it. There are two live
// completion points that route the user back into the app:
//   1. /connections/redirect's poll loop (browse/connect flow, return_to can
//      be a worker detail page: the exact #1209 repro path)
//   2. /connections/callback (the OAuth provider's actual redirect_uri)
// Both must invalidate the same three query roots before navigating away, so
// the destination never renders a stale pre-connection read. Source
// inspection (not a rendered DOM assertion) mirrors the existing pattern for
// this class of test (see run-page-cache-invalidation.test.ts and
// emily-create-from-prompt-invalidation.test.ts) since jsdom + fake timers
// are documented as unreliable for this component's async poll loop
// (connections-redirect-flow-guard.dom.test.tsx).

const ROOT = join(__dirname, "..");

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("connections/redirect invalidates stale connection reads on connect", () => {
  const src = read("app/connections/redirect/page.tsx");

  it("imports useQueryClient and reads it in the component", () => {
    expect(src).toContain('import { useQueryClient } from "@tanstack/react-query"');
    expect(src).toContain("const queryClient = useQueryClient();");
  });

  it("invalidates connections, worker-detail, and overview when the poll finds an active connection", () => {
    expect(src).toContain('queryClient.invalidateQueries({ queryKey: ["connections"] })');
    expect(src).toContain('queryClient.invalidateQueries({ queryKey: ["worker-detail"] })');
    expect(src).toContain('queryClient.invalidateQueries({ queryKey: ["system", "overview"] })');
  });

  it("invalidates BEFORE navigating back (returnTo can be a worker detail page)", () => {
    const activeBlock = src.slice(src.indexOf("if (active) {"), src.indexOf("} catch { /* ignore */ }"));
    const invalidateIdx = activeBlock.indexOf('queryClient.invalidateQueries({ queryKey: ["connections"] })');
    const replaceIdx = activeBlock.indexOf("router.replace(returnTo)");
    expect(invalidateIdx).toBeGreaterThan(-1);
    expect(replaceIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeLessThan(replaceIdx);
  });

  it("includes queryClient in the startPolling callback dependencies", () => {
    expect(src).toContain(
      "}, [slug, returnTo, router, connectionId, pollTimeoutMs, queryClient]);"
    );
  });
});

describe("connections/callback invalidates stale connection reads on the OAuth return leg", () => {
  const src = read("app/connections/callback/page.tsx");

  it("imports useQueryClient and reads it in the component", () => {
    expect(src).toContain('import { useQueryClient } from "@tanstack/react-query"');
    expect(src).toContain("const queryClient = useQueryClient();");
  });

  it("has a shared invalidateConnectionReads helper covering all three query roots", () => {
    expect(src).toContain("function invalidateConnectionReads(");
    const helperBody = src.slice(
      src.indexOf("function invalidateConnectionReads("),
      src.indexOf("function CallbackInner()")
    );
    expect(helperBody).toContain('queryClient.invalidateQueries({ queryKey: ["connections"] })');
    expect(helperBody).toContain('queryClient.invalidateQueries({ queryKey: ["worker-detail"] })');
    expect(helperBody).toContain('queryClient.invalidateQueries({ queryKey: ["system", "overview"] })');
  });

  it("calls the helper before router.replace in both the direct connected=1 branch and the fetch-then-navigate branch", () => {
    const calls = [...src.matchAll(/invalidateConnectionReads\(queryClient\);\s*\n\s*(const qs|router\.replace)/g)];
    expect(calls.length).toBe(2);
  });

  it("does NOT invalidate before window.close() in a popup (that window has no bearing on the opener's cache)", () => {
    const popupBranch = src.slice(src.indexOf('if (window.opener) {\n        window.close();'), src.indexOf("} else {\n        invalidateConnectionReads"));
    expect(popupBranch).not.toContain("invalidateConnectionReads");
  });
});
