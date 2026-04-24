import { getCachedSession, useSession } from '../hooks/useSession';

/**
 * Landing / launch-day feature flags.
 *
 * 2026-04-24 prod/preview split: the single source of truth is the SERVER's
 * DEPLOY_ENABLED env var, exposed via GET /api/session/me. The Docker image
 * for prod (floom.dev) and preview (preview.floom.dev) is the same, so the
 * build-time Vite flag cannot distinguish them — only the server's per-deploy
 * env can. `readDeployEnabled()` therefore reads the cached session payload
 * first, and only falls back to build-time / runtime flags when the session
 * hasn't primed yet (first paint) or when `window.__FLOOM__` overrides it.
 *
 * Default semantics (launch-audit 2026-04-24, P0 #605): publishing is
 * ENABLED unless explicitly disabled. Previously the client flag defaulted
 * to false when unset, so any container that didn't set
 * `VITE_DEPLOY_ENABLED=true` at build time rendered "join the waitlist"
 * copy ten times on the homepage even though the runtime was open. The
 * fix flips the default: waitlist mode is only on when opted into via
 * `VITE_WAITLIST_MODE=true` at build time, `window.__FLOOM__.waitlistMode`
 * at runtime, or the server reporting `deploy_enabled: false`.
 *
 * Static marketing sections that must decide at module load use the legacy
 * `DEPLOY_ENABLED` constant (Vite build-time) — fine for truly static copy,
 * but runtime chrome (TopBar, banners, CTAs) should use `useDeployEnabled()`.
 */
type Env = {
  VITE_DEPLOY_ENABLED?: string;
  VITE_WAITLIST_MODE?: string;
};

function readViteFlagString(key: keyof Env): string {
  const env = (import.meta as { env?: Env }).env ?? {};
  return env[key] ?? '';
}

function isTruthyFlag(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function isFalsyFlag(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === 'false' || v === '0' || v === 'no' || v === 'off';
}

// Build-time resolution: waitlist only when explicitly opted in. See
// readDeployEnabled() for the full resolution chain (runtime overrides +
// session API both win over this constant).
const buildDeployEnabled: boolean = (() => {
  if (isTruthyFlag(readViteFlagString('VITE_WAITLIST_MODE'))) return false;
  const deploy = readViteFlagString('VITE_DEPLOY_ENABLED');
  if (isTruthyFlag(deploy)) return true;
  if (isFalsyFlag(deploy)) return false;
  return true;
})();

export const DEPLOY_ENABLED: boolean = buildDeployEnabled;

export function deployOrWaitlistCopy<T>(opts: { deploy: T; waitlist: T }): T {
  return DEPLOY_ENABLED ? opts.deploy : opts.waitlist;
}

/**
 * Sync read of the deploy flag for code paths that can't use a hook
 * (event handlers, route guards). Order of precedence:
 *   1. `window.__FLOOM__.waitlistMode === true` (explicit waitlist override)
 *   2. `window.__FLOOM__.deployEnabled` (legacy boolean override)
 *   3. Cached `/api/session/me.deploy_enabled` (server-driven — the real flag)
 *   4. Build-time `buildDeployEnabled` (default enabled — see P0 #605)
 *
 * The cached session is primed on boot (see main.tsx `primeSession()`), so
 * after the first async resolve this is accurate for the live runtime.
 */
export function readDeployEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const w = window as Window & {
      __FLOOM__?: { deployEnabled?: boolean; waitlistMode?: boolean };
    };
    if (w.__FLOOM__?.waitlistMode === true) return false;
    if (typeof w.__FLOOM__?.deployEnabled === 'boolean') {
      return w.__FLOOM__.deployEnabled;
    }
  }
  const cached = getCachedSession();
  if (cached && typeof cached.deploy_enabled === 'boolean') {
    return cached.deploy_enabled;
  }
  return buildDeployEnabled;
}

/**
 * Launch feature flag from GET /api/session/me (`deploy_enabled`).
 *
 * Semantics:
 *   - `true`  → full Deploy / Publish CTAs (preview.floom.dev)
 *   - `false` → waitlist mode (floom.dev)
 *   - `null`  → session not yet loaded AND no build/runtime fallback
 *
 * 2026-04-24 (P0 #605): before the session loads, fall back to
 * `readDeployEnabled()` instead of returning null when we have a
 * definitive build-time/runtime answer. This prevents the first paint
 * from flashing waitlist CTAs (old null branch would short-circuit to
 * waitlist-hidden while components waited for the server). Components
 * that truly need to wait still see `null` when there is no runtime
 * override and the session is loading with no cached payload.
 */
export function useDeployEnabled(): boolean | null {
  const { data, loading, error } = useSession();
  if (error) return readDeployEnabled();
  if (!data) {
    if (loading) {
      // No session yet — respect any runtime override or build-time flag.
      // readDeployEnabled() returns a boolean, so we never flash waitlist
      // copy on first paint when the build says "deploy enabled".
      return readDeployEnabled();
    }
    return null;
  }
  return data.deploy_enabled === true;
}
