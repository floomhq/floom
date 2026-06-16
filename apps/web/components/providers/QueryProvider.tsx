"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stale-while-revalidate config (the industry-standard cache-first pattern):
//   - staleTime 30s   → cached data is treated as fresh; navigating back to a
//                       surface within 30s renders instantly with NO refetch
//                       and NO skeleton.
//   - refetchOnMount:false → returning to a tab uses the cache, never re-skeletons.
//   - refetchOnWindowFocus → silently revalidate when the user returns to the tab.
//   - gcTime 10min    → cache is retained well past the staleTime so tab-switching
//                       stays instant across a working session.
// First load (no cache) shows a Floom splash, not a skeleton; subsequent loads are
// cache-first. Background revalidation patches changes in place with no flash.
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        refetchOnMount: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: 1,
      },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // One client per browser session, created lazily so it survives re-renders
  // but is never shared across requests on the server.
  const [client] = useState(makeClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
