/**
 * DualAudiences — v17 landing · two-column creator / biz cards.
 *
 * Source: /var/www/wireframes-floom/v17/landing.html .dual block.
 * Addresses the v17 delta: live preview only showed one audience card
 * (vibecoders). The wireframe locks TWO audiences: makers + teams.
 */
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { SectionEyebrow } from './SectionEyebrow';

interface Bullet {
  text: string;
}

interface AudienceCardProps {
  eyebrow: string;
  title: string;
  lede: string;
  bullets: Bullet[];
  primary: { label: string; to: string; kind: 'ink' | 'accent' };
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
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
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
        <Link to={primary.to} style={btnStyle(primary.kind)}>
          {primary.label}
        </Link>
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
  return (
    <section
      data-testid="dual-audiences"
      style={{ padding: '72px 28px', maxWidth: 1240, margin: '0 auto' }}
    >
      <SectionEyebrow testid="dual-eyebrow">Who it&rsquo;s for</SectionEyebrow>
      <h2
        style={{
          fontFamily: "'DM Serif Display', Georgia, serif",
          fontWeight: 400,
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
          ]}
          primary={{ label: 'Deploy your first app', to: '/signup', kind: 'ink' }}
          secondary={{ label: 'Read the protocol', to: '/docs' }}
        />
        <AudienceCard
          eyebrow="For teams"
          title="Use AI apps that actually work."
          lede="Score leads, triage tickets, screen resumes. No setup, no code. Install in Claude or run from a browser. Workspace, shared runs, one bill."
          bullets={[
            { text: '22 apps live, free to run' },
            { text: 'Install in Claude in 30 seconds' },
            { text: 'Workspace, roles, audit log on Team plan' },
          ]}
          primary={{ label: 'Browse the store', to: '/apps', kind: 'accent' }}
          secondary={{ label: 'See pricing', to: '/pricing' }}
        />
      </div>
    </section>
  );
}
