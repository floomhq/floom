/**
 * HeroDemoPlaceholder — v17 landing · temporary placeholder for the
 * interactive hero demo component that will ship in a follow-up PR.
 *
 * The real spec is at /var/www/wireframes-floom/v17/HERO-DEMO-SPEC.md
 * and the wireframe at /var/www/wireframes-floom/v17/landing-hero-demo.html
 * (Variant A, split hero).
 *
 * This file intentionally stays minimal: the full component needs
 * typewriter effects, state machine, terminal chrome, and auto-advance
 * timing that belongs in its own PR. The placeholder exists so the
 * landing layout can be finalised and shipped without waiting on the
 * animation work.
 */
import type { CSSProperties } from 'react';

const WRAP_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px dashed var(--line-hover, #c4c1b8)',
  borderRadius: 14,
  padding: '20px 20px',
  textAlign: 'center',
  maxWidth: 920,
  margin: '18px auto 0',
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  color: 'var(--muted)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
  marginBottom: 6,
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "'Inter', system-ui, sans-serif",
  fontSize: 14,
  color: 'var(--ink)',
  fontWeight: 600,
  margin: '0 0 4px',
};

const SUB_STYLE: CSSProperties = {
  fontSize: 12.5,
  color: 'var(--muted)',
  margin: 0,
  lineHeight: 1.5,
};

const LINK_STYLE: CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 600,
  textDecoration: 'none',
};

export function HeroDemoPlaceholder() {
  return (
    <div data-testid="hero-demo-placeholder" style={WRAP_STYLE}>
      <div style={LABEL_STYLE}>Hero demo · placeholder</div>
      <p style={TITLE_STYLE}>Hero demo — React component shipping separately.</p>
      <p style={SUB_STYLE}>
        Interactive 3-state build &rarr; deploy &rarr; run animation. Spec:{' '}
        <a
          href="https://wireframes.floom.dev/v17/landing-hero-demo.html"
          target="_blank"
          rel="noreferrer"
          style={LINK_STYLE}
        >
          landing-hero-demo.html
        </a>
        {' · '}
        <a
          href="https://wireframes.floom.dev/v17/HERO-DEMO-SPEC.md"
          target="_blank"
          rel="noreferrer"
          style={LINK_STYLE}
        >
          HERO-DEMO-SPEC.md
        </a>
      </p>
    </div>
  );
}
