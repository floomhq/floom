/**
 * DualAudiences — v17 landing · two-column creator / biz cards.
 *
 * Source: /var/www/wireframes-floom/v17/landing.html .dual block.
 * Addresses the v17 delta: live preview only showed one audience card
 * (vibecoders). The wireframe locks TWO audiences: makers + teams.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { SectionEyebrow } from './SectionEyebrow';
import { useDeployEnabled } from '../../lib/flags';
import { WaitlistModal } from '../WaitlistModal';

interface Bullet {
  text: string;
}

interface AudienceCardProps {
  eyebrow: string;
  title: string;
  lede: string;
  bullets: Bullet[];
  /**
   * Primary CTA. When `onClick` is set, the primary slot renders as a
   * <button> (used by the waitlist override). Otherwise it renders a
   * <Link> to the `to` path. `to` is still passed so the button can
   * fall back to routing if, e.g. the caller wants both. Only one of
   * (onClick, to) is acted on per render.
   */
  primary: {
    label: string;
    to: string;
    kind: 'ink' | 'accent';
    onClick?: () => void;
    testid?: string;
  };
  secondary: { label: string; to: string };
}

const DUAL_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: 16,
  maxWidth: 1180,
  margin: '0 auto',
};

const COL_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 16,
  padding: '32px 28px',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const EYEBROW_STYLE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  color: 'var(--accent)',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

const H3_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 26,
  lineHeight: 1.1,
  margin: 0,
  letterSpacing: '-0.02em',
};

const P_STYLE: CSSProperties = {
  fontSize: 14,
  color: 'var(--muted)',
  lineHeight: 1.55,
  margin: 0,
};

const UL_STYLE: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '8px 0 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const LI_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  fontSize: 13.5,
  color: 'var(--ink)',
};

const CTA_ROW_STYLE: CSSProperties = {
  marginTop: 'auto',
  paddingTop: 14,
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const btnStyle = (kind: 'ink' | 'accent' | 'secondary'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  borderRadius: 10,
  padding: '11px 17px',
  fontSize: 13.5,
  fontWeight: 600,
  textDecoration: 'none',
  border: '1px solid',
  background:
    kind === 'ink' ? 'var(--ink)' : kind === 'accent' ? 'var(--accent)' : 'var(--card)',
  color: kind === 'secondary' ? 'var(--ink)' : '#fff',
  borderColor: kind === 'ink' ? 'var(--ink)' : kind === 'accent' ? 'var(--accent)' : 'var(--line)',
});

function AudienceCard({ eyebrow, title, lede, bullets, primary, secondary }: AudienceCardProps) {
  return (
    <div className="dual-col" style={COL_STYLE}>
      <div style={EYEBROW_STYLE}>{eyebrow}</div>
      <h3 style={H3_STYLE}>{title}</h3>
      <p style={P_STYLE}>{lede}</p>
      <ul style={UL_STYLE}>
        {bullets.map((b) => (
          <li key={b.text} style={LI_STYLE}>
            <Check size={16} aria-hidden="true" style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 3 }} />
            <span>{b.text}</span>
          </li>
        ))}
      </ul>
      <div style={CTA_ROW_STYLE}>
        {primary.onClick ? (
          <button
            type="button"
            onClick={primary.onClick}
            data-testid={primary.testid}
            style={{
              ...btnStyle(primary.kind),
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            {primary.label}
          </button>
        ) : (
          <Link
            to={primary.to}
            data-testid={primary.testid}
            style={btnStyle(primary.kind)}
          >
            {primary.label}
          </Link>
        )}
        <Link to={secondary.to} style={btnStyle('secondary')}>
          {secondary.label}
        </Link>
      </div>
    </div>
  );
}

interface DualAudiencesProps {
  children?: ReactNode;
}

export function DualAudiences(_: DualAudiencesProps = {}) {
  // Launch flag. When DEPLOY_ENABLED=false, the makers card's primary
  // CTA swaps from "Deploy your first app → /signup" to a "Join
  // waitlist" button that opens WaitlistModal in-place.
  const deployEnabled = useDeployEnabled();
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const waitlistMode = deployEnabled === false;
  return (
    <section
      data-testid="dual-audiences"
      style={{ padding: '56px 28px', maxWidth: 1240, margin: '0 auto' }}
    >
      <SectionEyebrow testid="dual-eyebrow">Who it&rsquo;s for</SectionEyebrow>
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 34,
          lineHeight: 1.1,
          letterSpacing: '-0.02em',
          textAlign: 'center',
          margin: '0 auto 28px',
          maxWidth: 760,
        }}
      >
        Two audiences. One runtime.
      </h2>
      <div className="dual" style={DUAL_STYLE}>
        <AudienceCard
          eyebrow="For makers"
          title="Ship the weekend project."
          lede="Vibe-code the idea. Paste your repo. Floom turns it into a page, an MCP server, and a JSON API. Share it with one link."
          bullets={[
            { text: 'One JSON spec, no framework to learn' },
            { text: 'Auto-generated landing page and MCP install' },
            { text: "Free tier runs on Floom's Gemini key" },
            { text: 'Self-host with one Docker command' },
          ]}
          primary={
            waitlistMode
              ? {
                  label: 'Join waitlist',
                  to: '/waitlist',
                  kind: 'ink',
                  onClick: () => setWaitlistOpen(true),
                  testid: 'dual-audience-waitlist',
                }
              : {
                  label: 'Deploy your first app',
                  to: '/signup',
                  kind: 'ink',
                  testid: 'dual-audience-deploy',
                }
          }
          secondary={{ label: 'Read the protocol', to: '/docs' }}
        />
        <AudienceCard
          eyebrow="For teams"
          title="Use AI apps that actually work."
          lede="Compare competitors, audit a landing page, rewrite a pitch. No setup, no code. Install in your AI tool or run from a browser. Workspace, shared runs, one bill."
          bullets={[
            { text: '3 AI apps, free to run' },
            { text: 'Install in your AI tool in 30 seconds' },
            { text: 'Workspace, roles, audit log on Team plan' },
            { text: 'BYOK for unlimited runs' },
          ]}
          primary={{ label: 'Browse the apps', to: '/apps', kind: 'accent' }}
          secondary={{ label: 'See pricing', to: '/pricing' }}
        />
      </div>
      <WaitlistModal
        open={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
        source="dual-audiences"
      />
    </section>
  );
}
