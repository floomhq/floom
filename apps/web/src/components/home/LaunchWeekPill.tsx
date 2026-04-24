/**
 * LaunchWeekPill — small "Launch week · 27 April 2026" chip used on the
 * landing hero.
 *
 * Mirrors the pill already shipped on PricingPage (src/pages/PricingPage.tsx
 * — EYEBROW constant) so the launch-week beat reads identically across the
 * two most-visited public surfaces: a mono uppercase micro-label with a
 * small green accent dot at the leading edge.
 *
 * Closes #544.
 */
import type { CSSProperties } from 'react';

const PILL_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--accent)',
  textTransform: 'uppercase',
  letterSpacing: '0.10em',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderRadius: 999,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  lineHeight: 1.2,
};

const DOT_STYLE: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 999,
  background: 'var(--accent)',
  boxShadow: '0 0 0 3px rgba(4,120,87,0.15)',
  flexShrink: 0,
};

export function LaunchWeekPill() {
  return (
    <div data-testid="launch-week-pill" style={PILL_STYLE}>
      <span aria-hidden="true" style={DOT_STYLE} />
      Launch week &middot; 27 April 2026
    </div>
  );
}
