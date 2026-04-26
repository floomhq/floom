/**
 * PublishCtaBox — v17 landing · dedicated "Publish your app" CTA box.
 *
 * Sits between the Showcase section and the dual creator/biz cards.
 * Closes #614 (Federico 2026-04-23 — "kill the robotic 'open source ·
 * MIT licensed' tag"): the standalone mono footnote under the CTA row
 * was dropped. The core runtime is still MIT; that fact lives in the
 * repo LICENSE and in /docs where people actually care about it, not
 * as a robot-sounding blurb in marketing copy.
 */
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { CSSProperties } from 'react';

const WRAP_STYLE: CSSProperties = {
  background: 'linear-gradient(180deg, var(--card), var(--studio))',
  border: '1px solid var(--line)',
  borderRadius: 18,
  padding: '28px 32px',
  display: 'grid',
  gridTemplateColumns: '1fr auto',
  gap: 24,
  alignItems: 'center',
  maxWidth: 1000,
  margin: '28px auto 0',
};

const EYEBROW_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  color: 'var(--accent)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
  marginBottom: 6,
};

const H3_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 26,
  lineHeight: 1.15,
  margin: '0 0 6px',
  letterSpacing: '-0.025em',
};

const P_STYLE: CSSProperties = {
  fontSize: 14,
  color: 'var(--muted)',
  lineHeight: 1.55,
  margin: 0,
  maxWidth: 520,
};

const STACK_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  alignItems: 'stretch',
};

const BTN_ACCENT: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  background: 'var(--accent)',
  color: '#fff',
  border: '1px solid var(--accent)',
  borderRadius: 12,
  /* Reached 44px+ (issue #588) */
  padding: '15px 22px',
  fontSize: 15,
  fontWeight: 600,
  textDecoration: 'none',
};

const BTN_SECONDARY: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  /* Reached 44px+ (issue #588) */
  padding: '15px 18px',
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
};

export function PublishCtaBox() {
  return (
    <div data-testid="publish-cta-box" className="publish-cta" style={WRAP_STYLE}>
      <div>
        <div style={EYEBROW_STYLE}>For makers</div>
        <h3 style={H3_STYLE}>Publish your own app.</h3>
        <p style={P_STYLE}>
          Paste a GitHub URL or OpenAPI spec. Floom turns it into a public
          page, an MCP server, and a JSON API. Live in ~60 seconds. Free on
          the hosted runtime, or self-host with one Docker command.
        </p>
      </div>
      <div style={STACK_STYLE}>
        <Link to="/signup" style={BTN_ACCENT}>
          Publish your app
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
        <Link to="/docs" style={BTN_SECONDARY}>
          Read the protocol
        </Link>
      </div>
    </div>
  );
}
