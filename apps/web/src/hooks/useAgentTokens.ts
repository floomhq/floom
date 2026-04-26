// v23 PR-A.1 fix: shared agent-tokens hook.
//
// Mirrors useMyApps + useSecrets — module-level cache + useSyncExternalStore
// so any component (TopBar dropdown, CopyForClaudeButton popover, /me/agent-keys
// page) reads the same source without refetching per route.
//
// First subscriber triggers the initial load; manual `refresh()` is exposed
// for after create / revoke actions on /me/agent-keys.
//
// Vocabulary lock: "agent token" / "Agent tokens" — never "API key" in
// user-visible copy. The underlying Better Auth endpoint is still
// `/auth/api-key/list`; that's a backend rename FLAG #6 for v1.1.

import { useEffect, useSyncExternalStore } from 'react';
import * as api from '../api/client';
import type { ApiKeyRecord } from '../api/client';

type CacheState = {
  tokens: ApiKeyRecord[] | null;
  loading: boolean;
  error: Error | null;
};

const listeners = new Set<() => void>();
let cache: CacheState = { tokens: null, loading: false, error: null };

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

export async function refreshAgentTokens(): Promise<ApiKeyRecord[] | null> {
  cache = { ...cache, loading: true, error: null };
  notify();
  try {
    const tokens = await api.listApiKeys();
    cache = { tokens, loading: false, error: null };
  } catch (err) {
    cache = {
      tokens: cache.tokens,
      loading: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  notify();
  return cache.tokens;
}

export function useAgentTokens(
  options: { enabled?: boolean } = {},
): CacheState & {
  refresh: () => Promise<ApiKeyRecord[] | null>;
} {
  // `enabled` defaults to true so /me/agent-keys (the canonical caller)
  // gets the eager fetch behaviour it expects. Pass `enabled: false` from
  // anon-visible chrome (TopBar's CopyForClaudeButton) to keep the hook
  // mounted for layout stability without firing /auth/api-key/list when
  // there's no session — the endpoint 401s for anon and we'd just be
  // burning a request per popover render.
  const { enabled = true } = options;
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (!enabled) return;
    if (!state.tokens && !state.loading && !state.error) {
      void refreshAgentTokens();
    }
  }, [enabled, state.tokens, state.loading, state.error]);
  return { ...state, refresh: refreshAgentTokens };
}
