/**
 * SelfHostSection — dedicated landing band that surfaces Floom's "run
 * your own" story so it's visible without having to dig into the docs.
 *
 * 2026-04-24 launch-week request (Federico): self-host prominence. The
 * OSS repo + Docker image are shipped today; keeping this fact one
 * scroll away from the hero de-risks Floom for commercial evaluators
 * and gives the waitlist some air ("you don't have to wait for us").
 *
 * Palette: single accent (--accent, green). Code block background is
 * the warm dark neutral (#1b1a17) per the CLAUDE.md "no pure black"
 * rule; copy-to-clipboard is a click target, not a styled surface.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { SectionEyebrow } from './SectionEyebrow';
import { track } from '../../lib/posthog';

// Canonical self-host command. Matches the README + docs/ROADMAP + pricing
// copy — don't diverge without updating both surfaces in lockstep. Launch-audit
// 2026-04-24 (P1 #616): homepage said `floomhq/floom :3010` while pricing said
// `floomhq/floom-docker :3000`, pointing users at two different images and
// ports. Canonical form is the README's ghcr.io/floomhq/floom-monorepo:latest.
const DOCKER_CMD = 'docker run -p 3000:3000 ghcr.io/floomhq/floom-monorepo:latest';

export function SelfHostSection() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    // Analytics #599: fire on click (not inside the .then) so we still
    // capture intent even if clipboard permission is denied.
    track('docker_copy_click', { surface: 'self_host_band' });
    navigator.clipboard
      .writeText(DOCKER_CMD)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        // Clipboard API denied (non-HTTPS, iframe sandbox). Fail silent —
        // the command is on-screen for the user to copy manually.
      });
  }

  return (
    <section
      data-testid="self-host-band"
      id="self-host"
      style={{
        padding: '48px 28px',
        maxWidth: 1240,
        margin: '0 auto',
        borderTop: '1px solid var(--line)',
      }}
    >
      <div style={{ maxWidth: 760, margin: '0 auto', textAlign: 'center' }}>
        <SectionEyebrow>Self-host</SectionEyebrow>
        <h3
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 34,
            lineHeight: 1.1,
            letterSpacing: '-0.03em',
            margin: '0 0 10px',
          }}
        >
          Run your own Floom.
        </h3>
        <p
          style={{
            fontSize: 15.5,
            color: 'var(--muted)',
            lineHeight: 1.55,
            margin: '0 auto 22px',
            maxWidth: 560,
          }}
        >
          Open source and Docker-ready. One command and it&rsquo;s yours.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            maxWidth: 520,
            margin: '0 auto 18px',
            background: '#1b1a17',
            border: '1px solid rgba(250,250,248,0.12)',
            borderRadius: 10,
            overflow: 'hidden',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        >
          <code
            data-testid="self-host-code"
            style={{
              flex: 1,
              padding: '14px 16px',
              color: '#fafaf8',
              fontSize: 13.5,
              lineHeight: 1.3,
              textAlign: 'left',
              whiteSpace: 'nowrap',
              overflowX: 'auto',
            }}
          >
            {DOCKER_CMD}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            data-testid="self-host-copy"
            aria-label="Copy Docker command"
            style={{
              padding: '0 16px',
              background: 'transparent',
              color: '#fafaf8',
              border: 'none',
              borderLeft: '1px solid rgba(250,250,248,0.12)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: '0.02em',
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <Link
          to="/docs/self-host"
          data-testid="self-host-docs-link"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13.5,
            fontWeight: 500,
            color: 'var(--accent)',
            textDecoration: 'none',
          }}
        >
          View the self-host docs
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
