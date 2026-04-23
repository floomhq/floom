// W4-minimal: shared session hook.
//
// Wraps GET /api/session/me in a tiny module-level cache so every page
// renders with a consistent view of the current user. The cache is
// invalidated on explicit refresh (after login/logout/switch).
//
// OSS mode: the response always returns the synthetic local user with
// `is_local: true`. The UI treats this as "logged out" for gating purposes
// (login/signup/me still redirect), but lets the local user browse the
// store and run apps.
//
// Cloud mode: the response returns the real Better Auth user when a
// session cookie is present; otherwise falls back to the local user and
// the UI shows the "sign in" call-to-action.

import { useEffect, useState, useSyncExternalStore } from 'react';
import * as api from '../api/client';
import type { SessionMePayload } from '../lib/types';

type CacheState = {
  data: SessionMePayload | null;
  loading: boolean;
  error: string | null;
};

const listeners = new Set<() => void>();
let cache: CacheState = { data: null, loading: false, error: null };

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

export async function refreshSession(): Promise<SessionMePayload | null> {
  cache = { ...cache, loading: true, error: null };
  notify();
  try {
    const data = await api.getSessionMe();
    cache = { data, loading: false, error: null };
  } catch (err) {
    cache = {
      data: null,
      loading: false,
      error: (err as Error).message || 'Failed to load session',
    };
  }
  notify();
  return cache.data;
}

/**
 * Read the current session state. Triggers a fetch on first mount so
 * pages that don't explicitly call refreshSession still get a value.
 */
export function useSession(): CacheState & {
  isAuthenticated: boolean;
  refresh: () => Promise<SessionMePayload | null>;
} {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!state.data && !state.loading && !state.error) {
      void refreshSession();
    }
  }, [state.data, state.loading, state.error]);

  const isAuthenticated = !!state.data && !state.data.user.is_local;
  return { ...state, isAuthenticated, refresh: refreshSession };
}

/**
 * Imperatively read the current cached session (no subscribe). Used by
 * routes that need to gate synchronously inside an event handler.
 */
export function getCachedSession(): SessionMePayload | null {
  return cache.data;
}

/**
 * Launch-2026-04-27 feature flag. Returns the server's `deploy_enabled`
 * bit (from GET /api/session/me). Semantics:
 *   - `true`  → full Deploy flow is available. Render the original
 *                "Deploy" / "Publish" CTAs.
 *   - `false` → waitlist mode. Every Deploy CTA swaps to "Join waitlist".
 *   - `null`  → session not yet loaded. Call sites should treat this as
 *                "show nothing deploy-related" or a neutral placeholder
 *                to avoid flickering from deploy-UI to waitlist-UI.
 *
 * We deliberately default to the *safe* state (waitlist) when the
 * server response is malformed or missing the field, so a stale client
 * bundle on an updated server never accidentally exposes the deploy UI.
 */
export function useDeployEnabled(): boolean | null {
  const { data, loading, error } = useSession();
  if (loading && !data) return null;
  if (error) return false;
  if (!data) return null;
  return data.deploy_enabled === true;
}

/**
 * Clear the cached session. Called on logout.
 */
export function clearSession(): void {
  cache = { data: null, loading: false, error: null };
  notify();
}

// Prime the cache on first import so the initial render of every page
// already has data. This runs exactly once per SPA boot.
let primed = false;
export function primeSession(): void {
  if (primed) return;
  primed = true;
  void refreshSession();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function _debugSetCache(_next: CacheState): void {
  cache = _next;
  notify();
}

// Export the useState import so tree-shakers don't complain about unused
// imports if the hook is only called at call sites.
export { useState };
