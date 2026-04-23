// 4-column responsive app card grid for /apps. Wireframe parity
// (2026-04-23) with `/var/www/wireframes-floom/v17/store.html`:
//
//   - 4 cols desktop (>=1025px), 3 cols at 1024, 2 cols at 760, 1 col at 480.
//   - Each card has: 120px thumbnail slot → icon row (AppIcon + title +
//     star-count + runs-7d) → description (2-line clamp) → footer
//     (category tag + "Run →" CTA).
//   - "HERO" accent tag flipped in via `app.hero`.
//   - Star glyph + count with the "hot" treatment (filled accent) at
//     stars >= 100.
//
// Thumbnail fallback: when `app.thumbnail_url` is null we render the
// gradient tile (AppIcon on a category tint). This is the honest
// Option-2 fallback from the brief — no fake screenshot art. Option 1
// (headless-screenshot at seed time) is a follow-up.
//
// Callers: /apps (AppsDirectoryPage) only, for now. AppStripe still
// owns landing-hero tiles and other list surfaces (see HeroAppTiles,
// CreatorHeroPage). We did not delete AppStripe.

import { Link } from 'react-router-dom';
import { ArrowRight, Star } from 'lucide-react';
import { AppIcon } from '../AppIcon';
import { DescriptionMarkdown } from '../DescriptionMarkdown';
import { categoryTint } from '../../lib/categoryTint';
import type { HubApp } from '../../lib/types';

export interface AppGridProps {
  apps: HubApp[];
  /**
   * Card rendering variant.
   *   - "default": standard /apps directory card.
   *   - "featured": slightly taller thumbnail + stronger title (used by
   *     landing "Try these" shelves that want a hero row of cards).
   * Defaults to "default" so existing call-sites keep their look.
   */
  variant?: 'default' | 'featured';
}

const CATEGORY_LABELS: Record<string, string> = {
  all: 'All',
  travel: 'Travel',
  'developer-tools': 'Dev tools',
  'developer_tools': 'Dev tools',
  developer: 'Dev tools',
  research: 'Research',
  marketing: 'Marketing',
  analytics: 'Analytics',
  productivity: 'Productivity',
  writing: 'Content',
  content: 'Content',
  ai: 'AI',
  seo: 'SEO',
  design: 'Design',
  sales: 'Sales',
  hr: 'HR',
  utilities: 'Utilities',
  'open-data': 'Open data',
  'open_data': 'Open data',
};

function labelForCategory(cat: string): string {
  return (
    CATEGORY_LABELS[cat] ??
    cat
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// Category badge palette. Per-category soft color so HIRING / GROWTH /
// RESEARCH read distinct at a glance instead of a wall of identical
// neutral pills. Restrained: only four buckets, all soft-tinted
// backgrounds with AA-contrast text. Unknown categories fall back to
// a neutral line pill so we never invent a color we don't own.
interface BadgePalette {
  bg: string;
  border: string;
  fg: string;
}
const BADGE_EMERALD: BadgePalette = {
  bg: '#ecfdf5',
  border: '#a7f3d0',
  fg: '#047857',
};
const BADGE_AMBER: BadgePalette = {
  bg: '#fffaf0',
  border: '#fde68a',
  fg: '#b45309',
};
const BADGE_BLUE: BadgePalette = {
  bg: '#eff6ff',
  border: '#bfdbfe',
  fg: '#1d4ed8',
};
const BADGE_SLATE: BadgePalette = {
  bg: '#f1f5f9',
  border: '#e2e8f0',
  fg: '#475569',
};

const CATEGORY_BADGE: Record<string, BadgePalette> = {
  hiring: BADGE_BLUE,
  hr: BADGE_BLUE,
  recruiting: BADGE_BLUE,
  growth: BADGE_EMERALD,
  marketing: BADGE_EMERALD,
  sales: BADGE_EMERALD,
  seo: BADGE_EMERALD,
  research: BADGE_AMBER,
  ai: BADGE_AMBER,
  analytics: BADGE_AMBER,
  writing: BADGE_AMBER,
  content: BADGE_AMBER,
  design: BADGE_AMBER,
  'developer-tools': BADGE_SLATE,
  'developer_tools': BADGE_SLATE,
  developer: BADGE_SLATE,
  productivity: BADGE_SLATE,
  utilities: BADGE_SLATE,
  'open-data': BADGE_SLATE,
  'open_data': BADGE_SLATE,
  travel: BADGE_SLATE,
};

function badgePaletteFor(category: string | null | undefined): BadgePalette | null {
  if (!category) return null;
  return CATEGORY_BADGE[category] ?? null;
}

function formatRuns(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // One decimal when it reads cleanly (e.g. 1.3k), drop when it
    // wouldn't add info (e.g. 2k not 2.0k).
    return k % 1 === 0 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

export function AppGrid({ apps, variant = 'default' }: AppGridProps) {
  return (
    <div
      data-testid="apps-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: 16,
      }}
      className="app-grid"
    >
      {apps.map((app) => (
        <AppGridCard key={app.slug} app={app} variant={variant} />
      ))}
      <style>{`
        @media (max-width: 1024px) {
          .app-grid { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
        }
        @media (max-width: 760px) {
          .app-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 12px !important; }
        }
        @media (max-width: 480px) {
          .app-grid { grid-template-columns: 1fr !important; gap: 12px !important; }
        }
        /* Keyboard-focus ring on cards (hover is already wired via JS).
           Uses the brand accent so it reads clearly against the card. */
        [data-testid^="app-grid-card-"]:focus-visible {
          outline: 2px solid var(--accent, #047857);
          outline-offset: 2px;
          border-color: var(--ink) !important;
        }
      `}</style>
    </div>
  );
}

function AppGridCard({
  app,
  variant = 'default',
}: {
  app: HubApp;
  variant?: 'default' | 'featured';
}) {
  const tint = categoryTint(app.category);
  const stars = app.stars ?? 0;
  const runs7d = app.runs_7d ?? 0;
  const isHot = stars >= 100;
  const hero = !!app.hero;
  const thumbnail = app.thumbnail_url ?? null;
  const badge = badgePaletteFor(app.category);
  const isFeatured = variant === 'featured';
  const thumbHeight = isFeatured ? 140 : 120;
  const titleSize = isFeatured ? 16 : 15;

  return (
    <Link
      to={`/p/${app.slug}`}
      data-testid={`app-grid-card-${app.slug}`}
      aria-label={`${app.name} — open app`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        overflow: 'hidden',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--ink)';
        el.style.transform = 'translateY(-1px)';
        el.style.boxShadow = '0 4px 16px rgba(15,23,42,0.06)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--line)';
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = 'none';
      }}
    >
      {/* THUMBNAIL. Gradient tile + centered AppIcon (or real PNG when
          we have one). HERO badge floats in the top-right corner of
          the thumbnail so it never collides with the stats row. */}
      <div
        data-testid={`app-grid-thumb-${app.slug}`}
        style={{
          height: thumbHeight,
          background: thumbnail ? 'var(--bg)' : tint.bg,
          boxShadow: thumbnail ? undefined : 'inset 0 0 0 1px rgba(15, 23, 42, 0.06)',
          position: 'relative',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={`${app.name} screenshot`}
            loading="lazy"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: tint.fg,
            }}
            aria-hidden="true"
          >
            <AppIcon slug={app.slug} size={isFeatured ? 52 : 44} color={tint.fg} />
          </div>
        )}

        {hero && (
          <span
            data-testid={`app-grid-hero-${app.slug}`}
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10,
              color: 'var(--accent, #047857)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '3px 8px',
              border: '1px solid var(--accent-border, #a7f3d0)',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.92)',
              fontWeight: 700,
              backdropFilter: 'saturate(1.2)',
              boxShadow: '0 1px 2px rgba(15,23,42,0.06)',
            }}
          >
            HERO
          </span>
        )}
      </div>

      {/* TITLE ROW: small app icon + name. Title wraps up to 2 lines —
          never truncates mid-word. min-height reserves 2 lines so card
          heights stay aligned across the grid even when some names are
          single-word. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 14px 8px' }}>
        <span
          aria-hidden="true"
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: tint.bg,
            boxShadow: 'inset 0 0 0 1px rgba(15, 23, 42, 0.06)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tint.fg,
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          <AppIcon slug={app.slug} size={18} color={tint.fg} />
        </span>
        <h3
          data-testid={`app-grid-title-${app.slug}`}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: titleSize,
            fontWeight: 600,
            lineHeight: 1.25,
            margin: 0,
            color: 'var(--ink)',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            wordBreak: 'break-word',
            minHeight: `calc(${titleSize}px * 1.25 * 2)`,
          }}
        >
          {app.name}
        </h3>
      </div>

      {/* STATS ROW: stands on its own so HERO / title / runs never
          collide. tabular-nums so counts align; flex-wrap in case a
          narrow mobile column is tighter than expected. */}
      <div
        data-testid={`app-grid-stats-${app.slug}`}
        style={{
          padding: '0 14px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          rowGap: 2,
          columnGap: 8,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 11,
          color: 'var(--muted)',
          lineHeight: 1.3,
          fontVariantNumeric: 'tabular-nums',
          marginBottom: 8,
        }}
      >
        <span
          data-testid={`app-grid-stars-${app.slug}`}
          data-hot={isHot ? 'true' : 'false'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            color: isHot ? 'var(--accent, #047857)' : 'var(--muted)',
            fontWeight: isHot ? 600 : 500,
          }}
          aria-label={`${stars} stars${isHot ? ' (hot)' : ''}`}
        >
          <Star
            size={11}
            fill={isHot ? 'currentColor' : 'none'}
            strokeWidth={1.75}
          />
          {stars}
        </span>
        <span aria-hidden="true" style={{ color: 'var(--line)' }}>·</span>
        <span data-testid={`app-grid-runs-${app.slug}`}>
          {formatRuns(runs7d)} runs
        </span>
        <span aria-hidden="true" style={{ color: 'var(--line)' }}>·</span>
        <span>7d</span>
      </div>

      {/* DESCRIPTION: 3-line clamp so the first value sentence is
          readable even when the creator's opening is a generic noun
          phrase. min-height reserves 3 lines of height for consistent
          card rhythm across the grid. */}
      <div
        data-testid={`app-grid-desc-${app.slug}`}
        style={{
          padding: '0 14px',
          fontSize: 13,
          color: 'var(--muted)',
          lineHeight: 1.5,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          minHeight: 'calc(13px * 1.5 * 3)',
          marginBottom: 12,
        }}
      >
        <DescriptionMarkdown
          description={app.description}
          testId={`app-grid-desc-md-${app.slug}`}
          style={{
            margin: 0,
            maxWidth: 'none',
            fontSize: 'inherit',
            color: 'inherit',
            lineHeight: 'inherit',
          }}
        />
      </div>

      {/* FOOTER: category pill (colored per bucket) + Run → */}
      <div
        style={{
          marginTop: 'auto',
          padding: '10px 14px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minHeight: 44,
        }}
      >
        {app.category ? (
          <span
            data-testid={`app-grid-category-${app.slug}`}
            data-category={app.category}
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10,
              color: badge ? badge.fg : 'var(--muted)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              padding: '3px 8px',
              border: `1px solid ${badge ? badge.border : 'var(--line)'}`,
              borderRadius: 4,
              background: badge ? badge.bg : 'var(--bg)',
              fontWeight: 600,
            }}
          >
            {labelForCategory(app.category)}
          </span>
        ) : (
          <span />
        )}
        <span
          className="app-grid-cta"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--accent, #047857)',
          }}
        >
          Run
          <ArrowRight size={14} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}
