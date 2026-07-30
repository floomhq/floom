import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refetchConnectionReads } from "@/lib/query/connection-status";

// #1209/#1206: the connections/worker-detail/overview reads are served from a
// shared, persisted (localStorage) TanStack Query cache with a 30s staleTime
// and refetchOnMount:false (see components/providers/QueryProvider.tsx). Any
// surface that renders that cache can go stale right after a connection
// completes unless the completion point refetches it. There are two live
// completion points that route the user back into the app:
//   1. /connections/redirect's poll loop (browse/connect flow, return_to can
//      be a worker detail page: the exact #1209 repro path)
//   2. /connections/callback (the OAuth provider's actual redirect_uri)
// Both must refetch the same three query roots before navigating away, so
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

describe("connection status cache refresh", () => {
  it("refetches inactive queries even when refetchOnMount is disabled", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
          refetchOnMount: false,
        },
      },
    });
    const fetches = { connections: 0, detail: 0, overview: 0 };

    await Promise.all([
      queryClient.fetchQuery({
        queryKey: ["connections", "list"],
        queryFn: async () => ({ revision: ++fetches.connections }),
      }),
      queryClient.fetchQuery({
        queryKey: ["worker-detail", "worker-1"],
        queryFn: async () => ({ revision: ++fetches.detail }),
      }),
      queryClient.fetchQuery({
        queryKey: ["system", "overview"],
        queryFn: async () => ({ revision: ++fetches.overview }),
      }),
    ]);

    expect(queryClient.getQueryCache().getAll().every((query) => !query.isActive())).toBe(true);

    await refetchConnectionReads(queryClient);

    expect(fetches).toEqual({ connections: 2, detail: 2, overview: 2 });
    expect(queryClient.getQueryData(["connections", "list"])).toEqual({ revision: 2 });
    expect(queryClient.getQueryData(["worker-detail", "worker-1"])).toEqual({ revision: 2 });
    expect(queryClient.getQueryData(["system", "overview"])).toEqual({ revision: 2 });
  });
});

describe("connections/redirect refetches stale connection reads on connect", () => {
  const src = read("app/connections/redirect/page.tsx");

  it("imports useQueryClient and reads it in the component", () => {
    expect(src).toContain('import { useQueryClient } from "@tanstack/react-query"');
    expect(src).toContain("const queryClient = useQueryClient();");
  });

  it("uses the shared all-query refetch when the poll finds an active connection", () => {
    expect(src).toContain("void refetchConnectionReads(queryClient);");
  });

  it("starts the refetch BEFORE navigating back (returnTo can be a worker detail page)", () => {
    const activeBlock = src.slice(src.indexOf("if (active) {"), src.indexOf("} catch { /* ignore */ }"));
    const refetchIdx = activeBlock.indexOf("void refetchConnectionReads(queryClient)");
    const replaceIdx = activeBlock.indexOf("router.replace(returnTo)");
    expect(refetchIdx).toBeGreaterThan(-1);
    expect(replaceIdx).toBeGreaterThan(-1);
    expect(refetchIdx).toBeLessThan(replaceIdx);
  });

  it("includes queryClient in the startPolling callback dependencies", () => {
    expect(src).toContain(
      "}, [slug, returnTo, router, connectionId, pollTimeoutMs, queryClient]);"
    );
  });
});

describe("connections/callback refetches stale connection reads on the OAuth return leg", () => {
  const src = read("app/connections/callback/page.tsx");

  it("imports useQueryClient and reads it in the component", () => {
    expect(src).toContain('import { useQueryClient } from "@tanstack/react-query"');
    expect(src).toContain("const queryClient = useQueryClient();");
  });

  it("uses the shared all-query refetch helper", () => {
    expect(src).toContain('import { refetchConnectionReads } from "@/lib/query/connection-status"');
    expect(src.match(/void refetchConnectionReads\(queryClient\);/g)).toHaveLength(2);
  });

  it("calls the helper before router.replace in both the direct connected=1 branch and the fetch-then-navigate branch", () => {
    const calls = [...src.matchAll(/refetchConnectionReads\(queryClient\);\s*\n\s*(const qs|router\.replace)/g)];
    expect(calls.length).toBe(2);
  });

  it("does NOT refetch before window.close() in a popup (that window has no bearing on the opener's cache)", () => {
    const popupBranch = src.slice(src.indexOf('if (window.opener) {\n        window.close();'), src.indexOf("} else {\n        void refetchConnectionReads"));
    expect(popupBranch).not.toContain("refetchConnectionReads");
  });
});
