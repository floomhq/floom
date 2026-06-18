"use client";

import { useState, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import {
  PERSIST_STORAGE_KEY,
  PERSIST_BUSTER,
  PERSIST_MAX_AGE,
  PERSISTABLE_KEY_PREFIXES,
} from "@/lib/query/persist";
import { getSafeStorage } from "@/lib/safe-storage";

// Stale-while-revalidate config (the industry-standard cache-first pattern):
//   - staleTime 30s   → cached data is treated as fresh; navigating back to a
//                       surface within 30s renders instantly with NO refetch
//                       and NO skeleton.
//   - refetchOnMount:false → returning to a tab uses the cache, never re-skeletons.
//   - refetchOnWindowFocus → silently revalidate when the user returns to the tab.
//   - gcTime = PERSIST_MAX_AGE → MUST be >= the persister maxAge, or react-query
//                       garbage-collects entries before they can be restored
//                       from localStorage on the next reload.
// First load (no cache) shows a Floom splash, not a skeleton; subsequent loads
// (including full page reloads) are cache-first via the persisted localStorage
// cache. Background revalidation patches changes in place with no flash.
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: PERSIST_MAX_AGE,
        refetchOnMount: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: 1,
      },
    },
  });
}

// Only build the persister on the client (localStorage is undefined during SSR
// and the provider is already "use client"). On the server we pass no persister
// and PersistQueryClientProvider behaves like a plain QueryClientProvider.
function makePersister() {
  const storage = getSafeStorage("local");
  if (!storage) return undefined;
  return createSyncStoragePersister({
    storage,
    key: PERSIST_STORAGE_KEY,
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // One client + persister per browser session, created lazily so they survive
  // re-renders but are never shared across requests on the server.
  const [client] = useState(makeClient);
  const [persister] = useState(makePersister);

  // SSR / no-localStorage fallback: a no-op persister keeps the provider API
  // uniform; nothing is read or written because this branch only runs without
  // a window.
  const activePersister = persister ?? {
    persistClient: async () => {},
    restoreClient: async () => undefined,
    removeClient: async () => {},
  };

  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister: activePersister,
        // Change PERSIST_BUSTER on any deploy that alters a persisted data shape
        // so the old localStorage cache is discarded instead of hydrating stale.
        buster: PERSIST_BUSTER,
        maxAge: PERSIST_MAX_AGE,
        dehydrateOptions: {
          // Only persist the safe, known list/overview surfaces — and only when
          // they actually hold data. Everything else stays in-memory only.
          shouldDehydrateQuery: (query) => {
            if (query.state.status !== "success") return false;
            const root = query.queryKey[0];
            return (
              typeof root === "string" &&
              (PERSISTABLE_KEY_PREFIXES as readonly string[]).includes(root)
            );
          },
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
