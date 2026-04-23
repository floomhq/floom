import { useSession } from '../hooks/useSession';

/**
 * Landing / launch-day feature flags.
 *
 * `DEPLOY_ENABLED` gates static marketing sections that key off the build-time
 * Vite env only (see LandingV17Page showcase + final CTA). Evaluated once at
 * module load so tree-shaking and SSR stay predictable.
 *
 * For runtime chrome (TopBar, docs banners, etc.) use `readDeployEnabled()` or
 * `useMemo(() => readDeployEnabled(), [])` so `window.__FLOOM__.deployEnabled`
 * can override the build.
 */
type Env = { VITE_DEPLOY_ENABLED?: string };

function readViteFlagString(): string {
  const env = (import.meta as { env?: Env }).env ?? {};
  return env.VITE_DEPLOY_ENABLED ?? '';
}

const rawViteFlag = readViteFlagString();

export const DEPLOY_ENABLED: boolean =
  rawViteFlag === 'true' ||
  rawViteFlag === '1' ||
  rawViteFlag === 'yes';

export function deployOrWaitlistCopy<T>(opts: { deploy: T; waitlist: T }): T {
  return DEPLOY_ENABLED ? opts.deploy : opts.waitlist;
}

/**
 * Client-side publish/deploy hint: `window.__FLOOM__.deployEnabled` when set,
 * otherwise build-time `VITE_DEPLOY_ENABLED === 'true'` (strict — matches the
 * former `flags.ts` env read, distinct from `DEPLOY_ENABLED`'s 1/yes aliases).
 *
 * Prefer `useMemo(() => readDeployEnabled(), [])` in components that should
 * match this hint without waiting for `/api/session/me`.
 */
export function readDeployEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const w = window as Window & { __FLOOM__?: { deployEnabled?: boolean } };
    if (typeof w.__FLOOM__?.deployEnabled === 'boolean') {
      return w.__FLOOM__.deployEnabled;
    }
  }
  const env = (import.meta as { env?: Env }).env;
  return env?.VITE_DEPLOY_ENABLED === 'true';
}

/**
 * Launch feature flag from GET /api/session/me (`deploy_enabled`).
 *
 * Semantics (unchanged from former `hooks/useSession`):
 *   - `true`  → full Deploy / Publish CTAs
 *   - `false` → waitlist mode
 *   - `null`  → session not yet loaded (or no payload yet); avoid flicker
 */
export function useDeployEnabled(): boolean | null {
  const { data, loading, error } = useSession();
  if (loading && !data) return null;
  if (error) return false;
  if (!data) return null;
  return data.deploy_enabled === true;
}
