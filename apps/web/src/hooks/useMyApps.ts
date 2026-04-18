// v15.2: shared /api/hub/mine hook.
//
// Mirrors the shape of useSession: module-level cache + useSyncExternalStore
// so /me, /me/apps/:slug, and the MeRail all read from the same source without
// refetching per route. First subscriber triggers the initial load; manual
// `refresh()` is exposed for after create / delete actions.

import { useEffect, useSyncExternalStore } from 'react';
import * as api from '../api/client';
import type { CreatorApp } from '../lib/types';

type CacheState = {
  apps: CreatorApp[] | null;
  loading: boolean;
  error: Error | null;
};

const listeners = new Set<() => void>();
let cache: CacheState = { apps: null, loading: false, error: null };

function notify(): void {
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot(): CacheState {
  return cache;
}

export async function refreshMyApps(): Promise<CreatorApp[] | null> {
  cache = { ...cache, loading: true, error: null };
  notify();
  try {
    const res = await api.getMyApps();
    cache = { apps: res.apps, loading: false, error: null };
  } catch (err) {
    cache = {
      apps: cache.apps,
      loading: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  notify();
  return cache.apps;
}

export function useMyApps(): CacheState & {
  refresh: () => Promise<CreatorApp[] | null>;
} {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!state.apps && !state.loading && !state.error) {
      void refreshMyApps();
    }
  }, [state.apps, state.loading, state.error]);
  return { ...state, refresh: refreshMyApps };
}
