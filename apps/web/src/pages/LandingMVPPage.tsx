/**
 * LandingMVPPage — thin wrapper that renders LandingV17Page in `mvp` variant.
 *
 * The `mvp` variant keeps 7 sections and drops the technical/creator-focused
 * ones. See LandingV17Page.tsx for the full section inventory and drop list.
 *
 * Route: `/` on the launch-mvp branch (wired in main.tsx).
 */
import { LandingV17Page } from './LandingV17Page';

export function LandingMVPPage() {
  return <LandingV17Page variant="mvp" />;
}
