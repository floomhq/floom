/**
 * ShowcaseGridV23 — v23 landing · editorial 1-hero + 2-compact app grid.
 *
 * Replaces the prior `<AppStripe variant="landing"/> × 3` neutral row
 * pattern with the wireframe v23 editorial layout: one wide hero card
 * (1.6fr, 240–300px banner thumb) + two compact cards (1fr each, 200px
 * banner thumb). Each thumb is a `app-banner` with a mini run-result
 * preview ("competitor-lens / stripe vs adyen / winner: stripe") so the
 * scroller sees the *result shape*, not just the app identity.
 *
 * Banner palette: NEUTRAL ONLY (Federico-locked 2026-04-25 — "no category
 * tints"). Single subtle gradient on `var(--studio)` warm off-white,
 * regardless of the app's category. Glyph chips in card headers stay
 * neutral too (`var(--card)` + `var(--line)`).
 *
 * Roster comes from the parent (already filtered to the 3 launch apps:
 * competitor-lens, ai-readiness-audit, pitch-coach). The banner content
 * for each app is hard-coded here: it's the run-result preview shape, not
 * a runtime metric.
 */
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { CSSProperties } from 'react';
import { DescriptionMarkdown } from '../DescriptionMarkdown';

interface Stripe {
  slug: string;
  name: string;
  description: string;
  category?: string;
}

interface ShowcaseGridV23Props {
  stripes: Stripe[];
}

/**
 * Run-result banner content per app slug. Matches the v23 wireframe + the
 * launch-day brief. Adding a new app means adding a row here. Falls back
 * to the slug + first description sentence if a slug isn't recognised.
 */
const BANNER_CONTENT: Record<
  string,
  { title: string; lines: Array<{ text: string; tone?: 'dim' | 'accent' }> }
> = {
  'competitor-lens': {
    title: 'competitor-lens',
    lines: [
      { text: 'stripe vs adyen' },
      { text: 'fee 1.4% vs 1.6%', tone: 'dim' },
      { text: 'winner: stripe', tone: 'accent' },
    ],
  },
  'ai-readiness-audit': {
    title: 'ai-readiness',
    lines: [
      { text: 'floom.dev' },
      { text: 'score: 8.4/10', tone: 'dim' },
      { text: '3 risks · 3 wins', tone: 'accent' },
    ],
  },
  'pitch-coach': {
    title: 'pitch-coach',
    lines: [
      { text: 'harsh truth' },
      { text: '3 critiques', tone: 'dim' },
      { text: '3 rewrites', tone: 'accent' },
    ],
  },
};

const SHOWCASE_HEADER_ROW: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-end',
  gap: 16,
  flexWrap: 'wrap',
  marginBottom: 24,
};

const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 18,
};

const CARD_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 16,
  display: 'flex',
  flexDirection: 'column',
  textDecoration: 'none',
  color: 'inherit',
  overflow: 'hidden',
  transition: 'border-color 140ms ease, transform 140ms ease',
};

const BANNER_BASE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderBottom: '1px solid var(--line)',
  // Neutral banner — single warm off-white gradient. NO per-category tints.
  background:
    'linear-gradient(135deg, var(--studio, #f5f4f0) 0%, var(--card, #ffffff) 100%)',
  overflow: 'hidden',
};

const BANNER_CARD_BASE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  lineHeight: 1.55,
  color: 'var(--ink)',
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  textAlign: 'left',
  whiteSpace: 'pre',
  boxShadow: '0 6px 18px rgba(15, 23, 42, 0.06)',
};

const BANNER_TITLE_STYLE: CSSProperties = {
  display: 'block',
  fontSize: 9.5,
  fontWeight: 700,
  color: 'var(--muted)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 6,
};

const BANNER_LINE_STYLE: CSSProperties = {
  display: 'block',
  fontWeight: 500,
  color: 'var(--ink)',
};

const BANNER_LINE_DIM: CSSProperties = {
  ...BANNER_LINE_STYLE,
  color: 'var(--muted)',
};

const BANNER_LINE_ACCENT: CSSProperties = {
  ...BANNER_LINE_STYLE,
  color: 'var(--accent)',
  fontWeight: 600,
};

const HERO_PILL_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  background: 'var(--accent-soft, #ecfdf5)',
  border: '1px solid var(--accent-border, #d1fae5)',
  borderRadius: 999,
  padding: '3px 10px',
};

const CARD_BODY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: '20px 22px 22px',
  gap: 10,
  flex: 1,
};

const CARD_NAME: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--ink)',
  lineHeight: 1.25,
  margin: 0,
};

const CARD_NAME_COMPACT: CSSProperties = {
  ...CARD_NAME,
  fontSize: 16,
};

const CARD_DESC: CSSProperties = {
  fontSize: 13.5,
  color: 'var(--muted)',
  lineHeight: 1.55,
  margin: 0,
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

const CARD_FOOT: CSSProperties = {
  marginTop: 'auto',
  paddingTop: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

const RUN_PILL_ACCENT: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  background: 'var(--accent)',
  color: '#fff',
  borderRadius: 999,
  padding: '7px 14px',
  fontSize: 12.5,
  fontWeight: 600,
};

const RUN_LINK_PLAIN: CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 600,
  fontSize: 13,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

function BannerThumb({
  slug,
  isHero,
  description,
}: {
  slug: string;
  isHero: boolean;
  description: string;
}) {
  const content =
    BANNER_CONTENT[slug] ?? {
      title: slug,
      lines: [{ text: description.split('. ')[0]?.slice(0, 32) || slug, tone: 'dim' }],
    };
  const cardSize: CSSProperties = isHero
    ? { fontSize: 12, padding: '14px 18px', minWidth: 240 }
    : { fontSize: 11, padding: '10px 14px', minWidth: 200 };
  const lineSize: CSSProperties = isHero ? { fontSize: 12 } : { fontSize: 11 };
  return (
    <div
      className="app-banner"
      data-testid={`showcase-banner-${slug}`}
      style={{
        ...BANNER_BASE,
        height: isHero ? 240 : 160,
      }}
    >
      <div className="banner-card" style={{ ...BANNER_CARD_BASE, ...cardSize }}>
        <span className="banner-title" style={BANNER_TITLE_STYLE}>
          {content.title}
        </span>
        {content.lines.map((line, idx) => {
          const base =
            line.tone === 'dim'
              ? BANNER_LINE_DIM
              : line.tone === 'accent'
                ? BANNER_LINE_ACCENT
                : BANNER_LINE_STYLE;
          return (
            <span key={idx} className={`banner-line${line.tone ? ` ${line.tone}` : ''}`} style={{ ...base, ...lineSize }}>
              {line.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ShowcaseCard({ stripe, isHero }: { stripe: Stripe; isHero: boolean }) {
  return (
    <Link
      to={`/p/${stripe.slug}`}
      data-testid={`showcase-card-${stripe.slug}`}
      className="showcase-card"
      style={CARD_STYLE}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--ink)';
        el.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--line)';
        el.style.transform = 'translateY(0)';
      }}
    >
      <BannerThumb slug={stripe.slug} isHero={isHero} description={stripe.description} />
      <div style={CARD_BODY}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div style={isHero ? CARD_NAME : CARD_NAME_COMPACT}>{stripe.name}</div>
          {isHero && (
            <span aria-label="Hero showcase app" style={HERO_PILL_STYLE}>
              Hero
            </span>
          )}
        </div>
        <DescriptionMarkdown
          description={stripe.description}
          testId={`showcase-desc-${stripe.slug}`}
          style={{
            ...CARD_DESC,
            maxWidth: 'none',
          }}
        />
        <div style={CARD_FOOT}>
          <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--muted)' }}>
            &nbsp;
          </span>
          {isHero ? (
            <span style={RUN_PILL_ACCENT}>
              Run it
              <ArrowRight size={14} aria-hidden="true" />
            </span>
          ) : (
            <span style={RUN_LINK_PLAIN}>
              Run
              <ArrowRight size={13} aria-hidden="true" />
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

export function ShowcaseGridV23({ stripes }: ShowcaseGridV23Props) {
  // Hero = first stripe (competitor-lens by roster order). Two compact follow.
  const [hero, ...rest] = stripes;
  if (!hero) return null;
  return (
    <section
      data-testid="showcase"
      className="showcase-section"
      style={{
        padding: '72px 28px',
        maxWidth: 1240,
        margin: '0 auto',
        borderTop: '1px solid var(--line)',
      }}
    >
      <div className="showcase-header" style={SHOWCASE_HEADER_ROW}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 8,
            }}
          >
            Showcase
          </div>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 800,
              fontSize: 34,
              lineHeight: 1.1,
              letterSpacing: '-0.025em',
              margin: '0 0 6px',
            }}
          >
            Three apps Floom already runs in production.
          </h2>
          <p
            style={{
              fontSize: 14.5,
              color: 'var(--muted)',
              margin: 0,
              maxWidth: 580,
            }}
          >
            Real AI doing real work. All deploy from a single GitHub repo.
          </p>
        </div>
        <Link
          to="/apps"
          data-testid="showcase-browse-all"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'var(--card)',
            color: 'var(--ink)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '9px 14px',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Browse all 3
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
      <div className="showcase-grid" style={GRID_STYLE}>
        <ShowcaseCard stripe={hero} isHero />
        {rest.map((s) => (
          <ShowcaseCard key={s.slug} stripe={s} isHero={false} />
        ))}
      </div>
    </section>
  );
}
