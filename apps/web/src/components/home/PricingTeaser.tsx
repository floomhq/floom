/**
 * PricingTeaser — v17 landing · single-tier $0 card + 3 limit cells.
 *
 * Replaces the 3-tier (Free/Cloud/Team) teaser per REVISION-2026-04-22.md
 * decision #4: "Paid plans coming post-launch. Free forever for self-host."
 * No dollar placeholders, no Pro/Team labels.
 */
import { Link } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { SectionEyebrow } from './SectionEyebrow';

const OUTER_STYLE: CSSProperties = {
  background: 'var(--studio)',
  borderTop: '1px solid var(--line)',
  borderBottom: '1px solid var(--line)',
  padding: '64px 28px',
};

const INNER_STYLE: CSSProperties = {
  maxWidth: 1180,
  margin: '0 auto',
};

const CARD_STYLE: CSSProperties = {
  maxWidth: 720,
  margin: '0 auto',
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 16,
  padding: '32px 32px 28px',
  textAlign: 'center',
};

const MONO_TAG_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  color: 'var(--accent)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
  marginBottom: 4,
};

const AMT_STYLE: CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontSize: 56,
  lineHeight: 1,
  letterSpacing: '-0.025em',
  margin: '4px 0 10px',
};

const SUB_STYLE: CSSProperties = {
  fontSize: 15,
  color: 'var(--muted)',
  margin: '0 0 18px',
  lineHeight: 1.55,
};

const LIMITS_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 12,
  margin: '18px 0',
  padding: '16px 0',
  borderTop: '1px solid var(--line)',
  borderBottom: '1px solid var(--line)',
};

const CELL_STYLE: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--muted)',
  lineHeight: 1.4,
};

const CELL_STRONG: CSSProperties = {
  display: 'block',
  fontSize: 15,
  color: 'var(--ink)',
  fontWeight: 600,
  marginBottom: 2,
  fontFamily: "'Inter', system-ui, sans-serif",
};

const FOOT_STYLE: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--muted)',
  margin: '6px 0 0',
};

export function PricingTeaser() {
  return (
    <section data-testid="pricing-teaser" style={OUTER_STYLE}>
      <div style={INNER_STYLE}>
        <SectionEyebrow>Pricing</SectionEyebrow>
        <h2
          style={{
            fontFamily: "'DM Serif Display', Georgia, serif",
            fontWeight: 400,
            fontSize: 28,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            textAlign: 'center',
            margin: '0 auto 22px',
            maxWidth: 760,
          }}
        >
          Free for launch. Rate-limited, not paywalled.
        </h2>
        <div style={CARD_STYLE}>
          <div style={MONO_TAG_STYLE}>Launch week</div>
          <div style={AMT_STYLE}>$0</div>
          <p style={SUB_STYLE}>
            Every app on Floom is free. Use our Gemini key until the rate
            limit hits, then paste yours for unlimited. Paid tiers come
            after launch.
          </p>
          <div className="limits" style={LIMITS_STYLE}>
            <div style={CELL_STYLE}>
              <strong style={CELL_STRONG}>5 runs / app / day</strong>
              per IP, on Floom&rsquo;s Gemini key
            </div>
            <div style={CELL_STYLE}>
              <strong style={CELL_STRONG}>Unlimited</strong>
              with your own Gemini or OpenAI key
            </div>
            <div style={CELL_STYLE}>
              <strong style={CELL_STRONG}>Self-host free</strong>
              MIT-licensed, one Docker command
            </div>
          </div>
          <p style={FOOT_STYLE}>
            Paid plans coming post-launch. Free forever for self-host.{' '}
            <Link
              to="/pricing"
              style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}
            >
              See the full pricing page &rarr;
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
