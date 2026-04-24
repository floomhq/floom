/**
 * FitBand — "who's it for / who's it not for" honesty band.
 *
 * Federico 2026-04-23 (#543): "let's be upfront about who this is for
 * and who it isn't for. vibecoded weekend apps, internal tools,
 * productivity things — yes. Stripe-scale enterprise wrappers,
 * Zapier-style integration platforms, full chatbots — no."
 *
 * Tone: collaborative and slightly defensive per MEMORY.md message
 * preferences. Not directive, not boastful — a small band that saves
 * both sides time by filtering out visitors in the wrong shape.
 *
 * Placed between ThreeSurfacesDiagram and SelfHostSection, so a
 * visitor reads: "here is the shape (3 surfaces) -> here is the fit
 * (weekend apps / internal tools) -> here is how you run it yourself".
 */
import type { CSSProperties } from 'react';

import { SectionEyebrow } from './SectionEyebrow';

const SECTION_STYLE: CSSProperties = {
  padding: '44px 28px 56px',
  maxWidth: 1040,
  margin: '0 auto',
};

const HEADER_STYLE: CSSProperties = {
  textAlign: 'center',
  marginBottom: 28,
};

const H2_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 30,
  lineHeight: 1.15,
  letterSpacing: '-0.025em',
  margin: '0 auto 8px',
  maxWidth: 720,
  color: 'var(--ink)',
  textWrap: 'balance' as unknown as 'balance',
};

const SUB_STYLE: CSSProperties = {
  fontSize: 15,
  color: 'var(--muted)',
  margin: '0 auto',
  maxWidth: 620,
  lineHeight: 1.55,
};

const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 16,
  maxWidth: 880,
  margin: '0 auto',
};

const CARD_BASE: CSSProperties = {
  borderRadius: 12,
  border: '1px solid var(--line)',
  padding: '22px 22px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const CARD_FIT: CSSProperties = {
  ...CARD_BASE,
  background: 'var(--card)',
  borderColor: 'rgba(4,120,87,0.35)',
};

const CARD_NOT_FIT: CSSProperties = {
  ...CARD_BASE,
  background: 'var(--studio, #f6f5f1)',
};

const CARD_LABEL_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 700,
  lineHeight: 1.2,
};

const CARD_H3_STYLE: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 17,
  fontWeight: 600,
  lineHeight: 1.3,
  margin: 0,
  color: 'var(--ink)',
};

const LIST_STYLE: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const ITEM_STYLE: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--ink)',
  display: 'flex',
  gap: 10,
  alignItems: 'flex-start',
};

const MARK_STYLE_FIT: CSSProperties = {
  flexShrink: 0,
  marginTop: 6,
  width: 6,
  height: 6,
  borderRadius: 999,
  background: 'var(--accent)',
};

const MARK_STYLE_NOT: CSSProperties = {
  flexShrink: 0,
  marginTop: 9,
  width: 10,
  height: 1.5,
  background: 'var(--muted)',
  borderRadius: 999,
};

const FIT_ITEMS = [
  'Vibecoded weekend apps shipped by one person',
  'Internal tools your team pings from Slack',
  'Small productivity apps (scorers, extractors, formatters)',
];

const NOT_FIT_ITEMS = [
  'Stripe-scale enterprise wrappers with bespoke SLAs',
  'Zapier-style integration platforms',
  'Full conversational chatbots',
];

export function FitBand() {
  return (
    <section data-testid="fit-band" style={SECTION_STYLE}>
      <div style={HEADER_STYLE}>
        <SectionEyebrow>Who it&rsquo;s for</SectionEyebrow>
        <h2 style={H2_STYLE}>Honest about the shape.</h2>
        <p style={SUB_STYLE}>
          Floom is shaped for small, useful apps &mdash; the ones you&rsquo;d
          build in a weekend and then actually use. If that&rsquo;s not
          your thing, here&rsquo;s what it isn&rsquo;t.
        </p>
      </div>

      <div className="fit-band-grid" style={GRID_STYLE}>
        <div data-testid="fit-band-for" style={CARD_FIT}>
          <div style={{ ...CARD_LABEL_STYLE, color: 'var(--accent)' }}>
            For
          </div>
          <h3 style={CARD_H3_STYLE}>
            Creators shipping small, useful apps.
          </h3>
          <ul style={LIST_STYLE}>
            {FIT_ITEMS.map((item) => (
              <li key={item} style={ITEM_STYLE}>
                <span aria-hidden="true" style={MARK_STYLE_FIT} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div data-testid="fit-band-not-for" style={CARD_NOT_FIT}>
          <div style={{ ...CARD_LABEL_STYLE, color: 'var(--muted)' }}>
            Not for
          </div>
          <h3 style={CARD_H3_STYLE}>
            Some shapes Floom won&rsquo;t be the right fit for.
          </h3>
          <ul style={LIST_STYLE}>
            {NOT_FIT_ITEMS.map((item) => (
              <li key={item} style={ITEM_STYLE}>
                <span aria-hidden="true" style={MARK_STYLE_NOT} />
                <span style={{ color: 'var(--muted)' }}>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <style>{`
        @media (max-width: 780px) {
          .fit-band-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </section>
  );
}
