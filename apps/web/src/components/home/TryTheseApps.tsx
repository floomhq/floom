/**
 * TryTheseApps — launch-hero app card row (waitlist-reality landing).
 *
 * Shows the 3 apps that are live + runnable on production today
 * (Resume Screener / Lead Scorer / Competitor Analyzer) as side-by-side
 * cards right below the hero demo. This is the "proof of life" moment
 * now that Deploy is gated behind the waitlist: the visitor can't ship
 * their own app yet, but they can run these three in one click.
 *
 * Coordination note:
 *   Agent 12 is in parallel rebuilding the canonical `AppCard` component
 *   used in /apps and /store. We intentionally do NOT import their
 *   in-flight component — the AppCard on main today visibly truncates
 *   titles to "Res..." / "Lea..." / "Co..." and looks bad on landing.
 *   This component is a *launch-hero-specific* variant sized to keep full
 *   titles readable. When agent 12 lands a new AppCard we can swap this
 *   for a `<AppCard variant="launch-hero" />` wrapper — all the links,
 *   copy, and run-count metadata stay the same.
 *
 * Spec:
 *   - Desktop (≥780px): 3 equal-width cards side by side.
 *   - Mobile (<780px): horizontal snap-scroll carousel, one-and-a-bit
 *     visible so the visitor knows more exist.
 *   - Each card: category eyebrow, full app name (never truncated),
 *     1-line description, "Run it now →" accent button, optional run-count.
 *   - Every card links to `/p/<slug>`.
 */
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { CSSProperties } from 'react';

import { AppIcon } from '../AppIcon';
import { SectionEyebrow } from './SectionEyebrow';

export interface TryAppCardData {
  slug: string;
  name: string;
  description: string;
  category: string;
  /** Optional run-count displayed under the name (e.g. "1,240 runs"). */
  runs?: string;
}

const DEFAULT_CARDS: TryAppCardData[] = [
  {
    slug: 'lead-scorer',
    name: 'Lead Scorer',
    description: 'Upload a CSV of leads + your ICP. Get fit scores and reasoning.',
    category: 'GROWTH',
  },
  {
    slug: 'resume-screener',
    name: 'Resume Screener',
    description: 'Zip of PDFs + a JD. Get a ranked shortlist with reasoning.',
    category: 'HIRING',
  },
  {
    slug: 'competitor-analyzer',
    name: 'Competitor Analyzer',
    description: 'Paste competitor URLs. Get positioning + a strengths/weaknesses table.',
    category: 'RESEARCH',
  },
];

// 2026-04-24: unified to ONE neutral icon tint across all three cards.
// Previously GROWTH / HIRING / RESEARCH each shipped their own fg/bg/ring
// (green / amber / slate) which painted the landing hero row in three
// pastel hues. That redundant signalling fought the rest of the page's
// restrained palette (brand green as the ONLY accent). Category identity
// stays legible via the eyebrow text (HIRING / GROWTH / RESEARCH) and
// the app name — the icon color was carrying no information the label
// wasn't already carrying.
//
// Matches AppGrid.tsx's CARD_NEUTRAL: warm dark neutral (#1b1a17) on a
// warm light neutral band (#f5f5f3), identical chip treatment. One
// palette entry per category is kept so the call-sites (icon tile +
// category pill) can continue to read `palette.fg` without restructure.
const NEUTRAL_PALETTE = {
  fg: '#1b1a17',
  bg: 'radial-gradient(circle at 30% 25%, #f5f5f3 0%, #fafaf8 55%, #ececea 100%)',
  ring:
    'inset 0 0 0 1px rgba(15,23,42,0.08), 0 1px 2px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.6)',
} as const;

const CATEGORY_PALETTE: Record<string, { fg: string; bg: string; ring: string }> = {
  GROWTH: NEUTRAL_PALETTE,
  HIRING: NEUTRAL_PALETTE,
  RESEARCH: NEUTRAL_PALETTE,
};

interface TryTheseAppsProps {
  /** Override the default 3-app roster (useful for tests or future AB). */
  apps?: TryAppCardData[];
}

export function TryTheseApps({ apps = DEFAULT_CARDS }: TryTheseAppsProps = {}) {
  return (
    <section
      data-testid="try-these-apps"
      style={{
        padding: '48px 28px 24px',
        maxWidth: 1240,
        margin: '0 auto',
      }}
    >
      <SectionEyebrow>Try it now</SectionEyebrow>
      <h2 style={H2_STYLE}>Three apps you can run in one click.</h2>
      <p style={LEAD_STYLE}>
        All three are live on floom.dev today &mdash; no signup, no setup.
        Run them, see the output, and tell us what you want next.
      </p>

      {/* Row: grid on desktop, snap-scroll carousel on mobile */}
      <div className="try-these-carousel-wrapper" style={{ position: 'relative' }}>
        <div className="try-these-row" data-testid="try-these-row" style={ROW_STYLE}>
          {apps.map((app) => (
            <TryAppCard key={app.slug} app={app} />
          ))}
        </div>
      </div>

      <style>{SCOPED_CSS}</style>
    </section>
  );
}

function TryAppCard({ app }: { app: TryAppCardData }) {
  const palette = CATEGORY_PALETTE[app.category] ?? CATEGORY_PALETTE.GROWTH;
  return (
    <Link
      to={`/p/${app.slug}`}
      data-testid={`try-app-card-${app.slug}`}
      className="try-app-card"
      style={CARD_STYLE}
    >
      <div style={CARD_HEAD}>
        <span
          aria-hidden="true"
          style={{
            ...ICON_TILE,
            background: palette.bg,
            color: palette.fg,
            boxShadow: palette.ring,
          }}
        >
          <AppIcon slug={app.slug} size={22} color={palette.fg} />
        </span>
        {/* Category eyebrow stays muted — the ink-black palette.fg would
            over-weight three ALL-CAPS monospace labels on the page. Muted
            reads as metadata, matches AppGrid's treatment. */}
        <span style={{ ...CATEGORY_PILL, color: 'var(--muted)' }}>{app.category}</span>
      </div>

      <div style={CARD_BODY}>
        {/* Full name: never truncated. word-wrap allowed, no ellipsis. */}
        <div className="try-app-name" style={NAME_STYLE}>
          {app.name}
        </div>
        <p style={DESC_STYLE}>{app.description}</p>
      </div>

      <div style={CARD_FOOT}>
        {app.runs ? <span style={META_STYLE}>{app.runs}</span> : <span />}
        <span style={CTA_STYLE}>
          Run it now
          <ArrowRight size={14} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const H2_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 34,
  lineHeight: 1.1,
  letterSpacing: '-0.02em',
  textAlign: 'center',
  margin: '0 auto 10px',
  maxWidth: 760,
};

const LEAD_STYLE: CSSProperties = {
  fontSize: 15.5,
  color: 'var(--muted)',
  textAlign: 'center',
  maxWidth: 620,
  margin: '0 auto 32px',
  lineHeight: 1.55,
};

const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 16,
  maxWidth: 1080,
  margin: '0 auto',
};

const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '24px 22px',
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 16,
  textDecoration: 'none',
  color: 'inherit',
  transition: 'border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease',
  minHeight: 200,
};

const CARD_HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};

const ICON_TILE: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 12,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const CATEGORY_PILL: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  letterSpacing: '0.12em',
  fontWeight: 700,
};

const CARD_BODY: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
};

// IMPORTANT: no ellipsis / no line-clamp on name. The broken /apps card on
// main truncates to "Res..." / "Lea..." / "Co..." which is what this
// section exists to NOT do. wordBreak + whiteSpace explicit.
const NAME_STYLE: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  fontWeight: 600,
  lineHeight: 1.15,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
  whiteSpace: 'normal',
  overflow: 'visible',
  textOverflow: 'clip',
  wordBreak: 'break-word',
};

const DESC_STYLE: CSSProperties = {
  fontSize: 13.5,
  color: 'var(--muted)',
  lineHeight: 1.5,
  margin: 0,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

const CARD_FOOT: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  paddingTop: 10,
  borderTop: '1px solid var(--line)',
};

const META_STYLE: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--muted)',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  letterSpacing: '0.04em',
};

const CTA_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--accent)',
};

const SCOPED_CSS = `
  .try-app-card:hover {
    border-color: var(--ink) !important;
    transform: translateY(-2px);
    box-shadow: 0 10px 24px -16px rgba(14,14,12,0.25);
  }
  @media (max-width: 780px) {
    .try-these-carousel-wrapper::after {
      content: "";
      position: absolute;
      top: 0;
      right: -20px;
      bottom: 0;
      width: 60px;
      background: linear-gradient(to right, transparent, var(--bg));
      pointer-events: none;
      z-index: 2;
    }
    .try-these-row {
      display: flex !important;
      grid-template-columns: none !important;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      padding: 4px 20px 12px;
      margin: 0 -20px;
      gap: 12px !important;
      scrollbar-width: none;
    }
    .try-these-row::-webkit-scrollbar { display: none; }
    .try-these-row > .try-app-card {
      scroll-snap-align: start;
      flex: 0 0 82%;
      min-width: 260px;
    }
  }
`;
