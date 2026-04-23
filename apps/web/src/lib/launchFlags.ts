/**
 * Landing / launch-day feature flags.
 *
 * `DEPLOY_ENABLED` gates the public Deploy flow. On production (floom.dev)
 * this is currently `false` (waitlist-only). On `preview.floom.dev` — and
 * any build where the env opts in — it's `true` and the landing surface
 * reverts to the original Deploy-forward CTAs.
 *
 * Source of truth for the flag lives in build-time env
 * (`VITE_DEPLOY_ENABLED`). We evaluate it once here so every component
 * imports the resolved boolean rather than re-reading `import.meta.env`.
 *
 * Coordinate: agent 9 owns the canonical implementation + waitlist modal.
 * If / when that lands, this file should re-export their flag + modal
 * instead of holding its own copy. See TODO comments in LandingV17Page
 * for the integration points.
 */

type Env = { VITE_DEPLOY_ENABLED?: string };

function readFlag(): string {
  // Vite inlines `import.meta.env.*` at build time. Cast keeps this helper
  // typed without dragging the whole ImportMetaEnv surface in.
  const env = (import.meta as { env?: Env }).env ?? {};
  return env.VITE_DEPLOY_ENABLED ?? '';
}

const rawFlag = readFlag();

export const DEPLOY_ENABLED: boolean =
  rawFlag === 'true' || rawFlag === '1' || rawFlag === 'yes';

/**
 * Convenience: most CTA code flips between a Deploy-forward label and a
 * Waitlist label. Rather than scatter ternaries everywhere, callers can
 * destructure this helper.
 */
export function deployOrWaitlistCopy<T>(opts: { deploy: T; waitlist: T }): T {
  return DEPLOY_ENABLED ? opts.deploy : opts.waitlist;
}
