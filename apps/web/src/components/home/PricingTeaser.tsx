/**
 * PricingTeaser — v17 landing · compact pricing band.
 *
 * 2026-04-24 restructure: compressed from a 549px-tall full card with 3
 * limit cells (5 runs/day, Unlimited with BYOK, Self-host free) to a
 * two-line marketing band. The old card duplicated information that
 * already lives on /pricing and that the SelfHost band above already
 * surfaces. On a landing page the pricing teaser only needs to promise
 * "free" and point at the full page — anyone who cares about the exact
 * limits clicks through. Federico audit: "compress to a 2-line band —
 * 'Free during launch. Self-host MIT-licensed. See pricing →'".
 *
 * The band keeps the section eyebrow ("Pricing") and a single link so
 * the page retains a pricing beat, but it no longer eats ~550px of
 * vertical space.
 *
 * 2026-04-24: dropped "MIT-licensed" from the headline. Per MEMORY.md:
 * "Never write 'Open source. MIT licensed.' or similar robotic license
 * declarations in human-facing copy." License info lives in the repo
 * and /docs — not in marketing hero copy.
 */
import { Link } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { SectionEyebrow } from './SectionEyebrow';

const OUTER_STYLE: CSSProperties = {
  background: 'var(--studio)',
  borderTop: '1px solid var(--line)',
  borderBottom: '1px solid var(--line)',
  padding: '36px 28px',
  textAlign: 'center',
};

const INNER_STYLE: CSSProperties = {
  maxWidth: 720,
  margin: '0 auto',
};

const HEADLINE_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 22,
  lineHeight: 1.25,
  letterSpacing: '-0.015em',
  margin: '10px 0 6px',
  color: 'var(--ink)',
};

const SUB_STYLE: CSSProperties = {
  fontSize: 14,
  color: 'var(--muted)',
  margin: '0 0 4px',
  lineHeight: 1.55,
};

const LINK_STYLE: CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 600,
  textDecoration: 'none',
};

export function PricingTeaser() {
  return (
    <section data-testid="pricing-teaser" style={OUTER_STYLE}>
      <div style={INNER_STYLE}>
        <SectionEyebrow>Pricing</SectionEyebrow>
        <h2 style={HEADLINE_STYLE}>Free during launch. Self-host anytime.</h2>
        <p style={SUB_STYLE}>
          <Link to="/pricing" data-testid="pricing-teaser-link" style={LINK_STYLE}>
            See the full pricing page &rarr;
          </Link>
        </p>
      </div>
    </section>
  );
}
