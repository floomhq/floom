/**
 * ManifestoBand — vision section under the hero.
 *
 * Federico 2026-04-24: "we need to say clearly we are building infra for
 * agentic work. more big vision talk, rn it feels like a tool".
 *
 * Direction A, Option 2 (hybrid): the benefit-forward hero stays put
 * ("Ship AI apps fast." — 2026-04-21 positioning lock), and we ADD this
 * vision band immediately below it. The H1 sells the wedge in two words;
 * this band explains what Floom actually is and why it exists. The two
 * work together — one tactical, one philosophical.
 *
 * Rendered on `/` only (LandingV17Page) between <HeroDemo>/<DeployYourOwnTile>
 * and <TryTheseApps>.
 *
 * Visual rules (per MEMORY.md):
 *   - No pure black / `bg-black` / `bg-zinc-950`. Uses warm dark neutral
 *     `#1b1a17` so the band feels substantial without reading "terminal".
 *   - Display font for the H2 matches the PR #530 sweep (Inter 800, tight
 *     tracking via `var(--font-display)`).
 *   - Full-width band; content recentered in a 980px max-width column.
 */
import type { CSSProperties } from 'react';

import { SectionEyebrow } from '../home/SectionEyebrow';

export function ManifestoBand() {
  return (
    <section
      data-testid="manifesto-band"
      className="manifesto-band"
      style={SECTION_STYLE}
    >
      <div style={INNER_STYLE}>
        <div style={{ textAlign: 'center' }}>
          <SectionEyebrow tone="accent" testid="manifesto-eyebrow">
            The vision
          </SectionEyebrow>
        </div>

        <h2 data-testid="manifesto-h2" className="manifesto-h2" style={H2_STYLE}>
          Infrastructure for <span style={ACCENT_SPAN}>agentic work.</span>
        </h2>

        <p data-testid="manifesto-sub" className="manifesto-sub" style={SUB_STYLE}>
          The protocol + runtime agents run on. Open source.
        </p>

        <p data-testid="manifesto-body" className="manifesto-body" style={BODY_STYLE}>
          Agents don&rsquo;t just chat &mdash; they do work. That work needs real
          infrastructure: auth, runs, rate limits, audit. Floom is the
          runtime for the agent era.
        </p>
      </div>

      <style>{`
        @media (max-width: 780px) {
          .manifesto-band { padding: 52px 20px !important; }
          .manifesto-h2 { font-size: 40px !important; }
          .manifesto-sub { font-size: 16px !important; }
          .manifesto-body { font-size: 15px !important; }
        }
        @media (max-width: 480px) {
          .manifesto-band { padding: 44px 18px !important; }
          .manifesto-h2 { font-size: 32px !important; line-height: 1.08 !important; }
          .manifesto-sub { font-size: 15px !important; }
        }
      `}</style>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Warm dark neutral (NEVER pure black — MEMORY.md terminal-never-black
// rule). #1b1a17 gives the band weight without tipping into the "terminal
// panel" aesthetic that has been flagged before.
const SECTION_STYLE: CSSProperties = {
  background: '#1b1a17',
  color: '#f5f2ec',
  padding: '72px 28px',
  borderTop: '1px solid rgba(255,255,255,0.06)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

const INNER_STYLE: CSSProperties = {
  maxWidth: 980,
  margin: '0 auto',
  textAlign: 'center',
};

const H2_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 56,
  lineHeight: 1.05,
  letterSpacing: '-0.025em',
  margin: '0 auto 14px',
  maxWidth: 820,
  color: '#f5f2ec',
  textWrap: 'balance' as unknown as 'balance',
};

// Accent span: the green brand accent on the punch phrase. Mirrors the
// hero H1's "fast." highlight pattern so the two blocks feel related.
const ACCENT_SPAN: CSSProperties = {
  color: 'var(--accent, #34d399)',
};

const SUB_STYLE: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 19,
  lineHeight: 1.45,
  fontWeight: 500,
  color: 'rgba(245,242,236,0.88)',
  maxWidth: 640,
  margin: '0 auto 22px',
};

const BODY_STYLE: CSSProperties = {
  fontFamily: 'var(--font-sans)',
  fontSize: 16,
  lineHeight: 1.6,
  fontWeight: 400,
  color: 'rgba(245,242,236,0.7)',
  maxWidth: 680,
  margin: '0 auto',
};
