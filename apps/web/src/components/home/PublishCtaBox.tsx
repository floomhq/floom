/**
 * PublishCtaBox — v17 landing · dedicated "Publish your app" CTA box.
 *
 * Sits between the Showcase section and the dual creator/biz cards. Per
 * REVISION-2026-04-22.md: accent button + "Read the protocol" secondary
 * + "open source · MIT" mono-tag. Matches landing.html .publish-cta.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useDeployEnabled } from '../../hooks/useSession';
import { WaitlistModal } from '../WaitlistModal';

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
  fontSize: 11,
  color: 'var(--accent)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
  marginBottom: 6,
};

const H3_STYLE: CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
  fontSize: 26,
  lineHeight: 1.15,
  margin: '0 0 6px',
  letterSpacing: '-0.02em',
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

const MONO_NOTE_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  color: 'var(--muted)',
  textAlign: 'center',
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
  padding: '14px 22px',
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
  padding: '11px 18px',
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
};

export function PublishCtaBox() {
  // Gate on the launch feature flag (DEPLOY_ENABLED). Null while the
  // session is still loading: we render the neutral "Publish your app"
  // copy as a placeholder so the box doesn't flicker, and guard the
  // click handler to only open the modal when we know we're in
  // waitlist mode. Treating null-at-click as waitlist-mode would also
  // be acceptable; we pick the "least surprising" behaviour which is
  // "link to /signup" while we don't yet know the server's answer.
  const deployEnabled = useDeployEnabled();
  const [modalOpen, setModalOpen] = useState(false);

  // Waitlist mode: swap the button to a <button> that opens the modal.
  // Keep the secondary "Read the protocol" + MIT note unchanged — they
  // are informational, not deploy-related.
  if (deployEnabled === false) {
    return (
      <>
        <div data-testid="publish-cta-box" className="publish-cta" style={WRAP_STYLE}>
          <div>
            <div style={EYEBROW_STYLE}>For makers</div>
            <h3 style={H3_STYLE}>Publish your own app.</h3>
            <p style={P_STYLE}>
              Paste a GitHub URL or OpenAPI spec. Floom turns it into a
              public page, an MCP server, and a JSON API. We&rsquo;re
              rolling this out slowly — join the waitlist and we&rsquo;ll
              email you when a slot opens.
            </p>
          </div>
          <div style={STACK_STYLE}>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              data-testid="publish-cta-waitlist"
              style={{
                ...BTN_ACCENT,
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              Join waitlist
              <ArrowRight size={16} aria-hidden="true" />
            </button>
            <Link to="/docs" style={BTN_SECONDARY}>
              Read the protocol
            </Link>
            <span className="mono-note" style={MONO_NOTE_STYLE}>
              open source &middot; MIT
            </span>
          </div>
        </div>
        <WaitlistModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          source="hero"
        />
      </>
    );
  }

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
        <Link to="/signup" data-testid="publish-cta-deploy" style={BTN_ACCENT}>
          Publish your app
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
        <Link to="/docs" style={BTN_SECONDARY}>
          Read the protocol
        </Link>
        <span className="mono-note" style={MONO_NOTE_STYLE}>
          open source &middot; MIT
        </span>
      </div>
    </div>
  );
}
