// Shared /api/me/runs hook.
//
// Module-level cache + useSyncExternalStore pattern (mirrors useMyApps)
// so RunRail and MeAppsPage read from the same run list without re-fetching
// per route. First subscriber triggers the initial load; manual `refresh()`
// is exposed for after a new run lands.

import { useEffect, useSyncExternalStore } from 'react';
import * as api from '../api/client';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;

type CacheState = {
  runs: MeRunSummary[] | null;
  loading: boolean;
  error: Error | null;
};

const listeners = new Set<() => void>();
let cache: CacheState = { runs: null, loading: false, error: null };

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

export async function refreshMyRuns(): Promise<MeRunSummary[] | null> {
  cache = { ...cache, loading: true, error: null };
  notify();
  try {
    const res = await api.getMyRuns(FETCH_LIMIT);
    cache = { runs: res.runs, loading: false, error: null };
  } catch (err) {
    cache = {
      runs: cache.runs,
      loading: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  notify();
  return cache.runs;
}

export function useMyRuns(): CacheState & {
  refresh: () => Promise<MeRunSummary[] | null>;
} {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!state.runs && !state.loading && !state.error) {
      void refreshMyRuns();
    }
  }, [state.runs, state.loading, state.error]);
  return { ...state, refresh: refreshMyRuns };
}
