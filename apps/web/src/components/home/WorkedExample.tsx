/**
 * WorkedExample — one concrete run of a Floom app, shown slowly.
 *
 * Federico 2026-04-23 (#541): "the hero USE tab flashes a score — but the
 * value is hidden if you skip the demo. Dedicate a mid-page band so a
 * visitor who scrolls past the hero still sees one full worked example
 * before they leave."
 *
 * The example is Lead Scorer scoring stripe.com -> 87/100 "Strong fit".
 * Input on the left, a light arrow, output on the right. No animation,
 * no screenshot, no bespoke asset — just the raw input/output of a real
 * app in the featured trio, so the band reads as "here is one thing
 * Floom actually does" rather than a marketing gimmick.
 */
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

import { SectionEyebrow } from './SectionEyebrow';

const SECTION_STYLE: CSSProperties = {
  padding: '56px 28px',
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
  fontSize: 34,
  lineHeight: 1.1,
  letterSpacing: '-0.03em',
  margin: '0 auto 10px',
  maxWidth: 760,
  color: 'var(--ink)',
  textWrap: 'balance' as unknown as 'balance',
};

const SUB_STYLE: CSSProperties = {
  fontSize: 15.5,
  color: 'var(--muted)',
  margin: '0 auto',
  maxWidth: 620,
  lineHeight: 1.55,
};

const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 40px 1fr',
  gap: 16,
  alignItems: 'stretch',
  maxWidth: 900,
  margin: '0 auto',
};

const CARD_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  padding: '20px 22px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const CARD_LABEL_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--muted)',
};

const MONO_BLOCK_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--ink)',
  background: 'var(--studio, #f6f5f1)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '12px 14px',
  whiteSpace: 'pre-wrap' as const,
  overflowX: 'auto',
};

const SCORE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  marginTop: 2,
};

const SCORE_NUM_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 44,
  lineHeight: 1,
  letterSpacing: '-0.03em',
  color: 'var(--accent)',
};

const SCORE_SUFFIX_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  color: 'var(--muted)',
};

const VERDICT_STYLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--ink)',
  lineHeight: 1.4,
};

const ARROW_WRAP_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--muted)',
};

const FOOT_STYLE: CSSProperties = {
  textAlign: 'center',
  marginTop: 24,
  fontSize: 13.5,
  color: 'var(--muted)',
};

const FOOT_LINK_STYLE: CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 600,
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const INPUT_JSON = `{
  "company_url": "stripe.com",
  "icp": "B2B SaaS, 50-500 employees, US"
}`;

export function WorkedExample() {
  return (
    <section data-testid="worked-example" style={SECTION_STYLE}>
      <div style={HEADER_STYLE}>
        <SectionEyebrow>Here&rsquo;s an example</SectionEyebrow>
        <h2 style={H2_STYLE}>
          Lead Scorer, running on Floom. Paste a company, get a fit score.
        </h2>
        <p style={SUB_STYLE}>
          One of the three live apps on floom.dev. JSON in, JSON out, a
          public page anyone can share, and an MCP endpoint Claude can
          call. Same runtime, three surfaces.
        </p>
      </div>

      <div className="worked-example-grid" style={GRID_STYLE}>
        <div style={CARD_STYLE}>
          <div style={CARD_LABEL_STYLE}>Input &middot; JSON</div>
          <pre style={MONO_BLOCK_STYLE}>{INPUT_JSON}</pre>
        </div>

        <div style={ARROW_WRAP_STYLE} aria-hidden="true">
          <ArrowRight size={22} strokeWidth={1.75} />
        </div>

        <div style={CARD_STYLE}>
          <div style={CARD_LABEL_STYLE}>Output &middot; ~3s</div>
          <div style={SCORE_ROW_STYLE}>
            <span style={SCORE_NUM_STYLE}>87</span>
            <span style={SCORE_SUFFIX_STYLE}>/ 100</span>
          </div>
          <div style={VERDICT_STYLE}>Strong fit.</div>
          <p
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              lineHeight: 1.55,
              margin: 0,
            }}
          >
            Matches the ICP on vertical, size band, and geography. Public
            payment infrastructure, B2B-heavy revenue mix.
          </p>
        </div>
      </div>

      <div style={FOOT_STYLE}>
        <Link
          to="/apps/lead-scorer"
          data-testid="worked-example-link"
          style={FOOT_LINK_STYLE}
        >
          Run it yourself <ArrowRight size={13} aria-hidden="true" />
        </Link>
      </div>

      <style>{`
        @media (max-width: 780px) {
          .worked-example-grid {
            grid-template-columns: 1fr !important;
            gap: 12px !important;
          }
          .worked-example-grid > div[aria-hidden="true"] {
            transform: rotate(90deg);
            justify-self: center;
          }
        }
      `}</style>
    </section>
  );
}
