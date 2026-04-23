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
import type { HubApp } from '../../lib/types';

export interface AppGridProps {
  apps: HubApp[];
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

// Category → gradient fallback tint. Matches the three-tint system
// AppStripe already uses so /apps and /landing read as the same
// product. See AppStripe.tsx for the palette rationale (restrained,
// max 3 accents). `--accent` stays the brand green.
interface Tint {
  gradient: string;
  fg: string;
  ring: string;
}

const TINT_EMERALD: Tint = {
  gradient:
    'radial-gradient(circle at 30% 25%, #d1fae5 0%, #ecfdf5 55%, #d1fae5 100%)',
  fg: '#047857',
  ring:
    'inset 0 0 0 1px rgba(5,150,105,0.15), 0 1px 2px rgba(5,150,105,0.18), inset 0 1px 0 rgba(255,255,255,0.6)',
};
const TINT_AMBER: Tint = {
  gradient:
    'radial-gradient(circle at 30% 25%, #fef3c7 0%, #fffaf0 55%, #fde68a 100%)',
  fg: '#b45309',
  ring:
    'inset 0 0 0 1px rgba(180,83,9,0.15), 0 1px 2px rgba(180,83,9,0.14), inset 0 1px 0 rgba(255,255,255,0.6)',
};
const TINT_SLATE: Tint = {
  gradient:
    'radial-gradient(circle at 30% 25%, #e2e8f0 0%, #f1f5f9 55%, #cbd5e1 100%)',
  fg: '#475569',
  ring:
    'inset 0 0 0 1px rgba(71,85,105,0.12), 0 1px 2px rgba(71,85,105,0.12), inset 0 1px 0 rgba(255,255,255,0.6)',
};

const CATEGORY_TINT: Record<string, Tint> = {
  'developer-tools': TINT_EMERALD,
  'developer_tools': TINT_EMERALD,
  developer: TINT_EMERALD,
  productivity: TINT_EMERALD,
  utilities: TINT_EMERALD,
  ai: TINT_AMBER,
  research: TINT_AMBER,
  marketing: TINT_AMBER,
  design: TINT_AMBER,
  writing: TINT_AMBER,
  content: TINT_AMBER,
  sales: TINT_AMBER,
  hr: TINT_AMBER,
  seo: TINT_AMBER,
  analytics: TINT_AMBER,
  'open_data': TINT_SLATE,
  'open-data': TINT_SLATE,
  location: TINT_SLATE,
  financial: TINT_SLATE,
  media: TINT_SLATE,
  ecommerce: TINT_SLATE,
  messaging: TINT_SLATE,
  travel: TINT_SLATE,
};

function paletteFor(category: string | null | undefined): Tint {
  if (!category) return TINT_EMERALD;
  return CATEGORY_TINT[category] || TINT_EMERALD;
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

export function AppGrid({ apps }: AppGridProps) {
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
        <AppGridCard key={app.slug} app={app} />
      ))}
      <style>{`
        @media (max-width: 1024px) {
          .app-grid { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
        }
        @media (max-width: 760px) {
          .app-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }
        @media (max-width: 480px) {
          .app-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function AppGridCard({ app }: { app: HubApp }) {
  const tint = paletteFor(app.category);
  const stars = app.stars ?? 0;
  const runs7d = app.runs_7d ?? 0;
  const isHot = stars >= 100;
  const hero = !!app.hero;
  const thumbnail = app.thumbnail_url ?? null;

  return (
    <Link
      to={`/p/${app.slug}`}
      data-testid={`app-grid-card-${app.slug}`}
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
      {/* THUMBNAIL. 120px tall per wireframe. Real PNG if we have one,
          otherwise the gradient fallback with the AppIcon glyph big. */}
      <div
        data-testid={`app-grid-thumb-${app.slug}`}
        style={{
          height: 120,
          background: thumbnail ? 'var(--bg)' : tint.gradient,
          boxShadow: thumbnail ? undefined : tint.ring,
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
            <AppIcon slug={app.slug} size={44} color={tint.fg} />
          </div>
        )}
      </div>

      {/* TITLE ROW: icon + name + stars/runs · HERO tag */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 14px 6px' }}>
        <span
          aria-hidden="true"
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            background: tint.gradient,
            boxShadow: tint.ring,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tint.fg,
            flexShrink: 0,
          }}
        >
          <AppIcon slug={app.slug} size={18} color={tint.fg} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            data-testid={`app-grid-title-${app.slug}`}
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              lineHeight: 1.3,
              margin: 0,
              color: 'var(--ink)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {app.name}
          </h3>
          <div
            data-testid={`app-grid-stats-${app.slug}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 2,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 11,
              color: 'var(--muted)',
              lineHeight: 1.3,
            }}
          >
            <span
              data-testid={`app-grid-stars-${app.slug}`}
              data-hot={isHot ? 'true' : 'false'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                color: isHot ? 'var(--accent, #059669)' : 'var(--muted)',
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
              {formatRuns(runs7d)} runs · 7d
            </span>
          </div>
        </div>
        {hero && (
          <span
            data-testid={`app-grid-hero-${app.slug}`}
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10,
              color: 'var(--accent, #059669)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              padding: '2px 7px',
              border: '1px solid var(--accent-border, #a7f3d0)',
              borderRadius: 4,
              background: 'var(--accent-soft, #ecfdf5)',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            HERO
          </span>
        )}
      </div>

      {/* DESCRIPTION: 2-line clamp to hold card height across the grid */}
      <div
        data-testid={`app-grid-desc-${app.slug}`}
        style={{
          padding: '0 14px',
          fontSize: 13,
          color: 'var(--muted)',
          lineHeight: 1.5,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          minHeight: 39,
          marginBottom: 10,
          marginTop: 2,
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

      {/* FOOTER: category pill + Run → */}
      <div
        style={{
          marginTop: 'auto',
          padding: '10px 14px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        {app.category ? (
          <span
            data-testid={`app-grid-category-${app.slug}`}
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10,
              color: 'var(--muted)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              padding: '2px 7px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              background: 'var(--bg)',
            }}
          >
            {labelForCategory(app.category)}
          </span>
        ) : (
          <span />
        )}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--accent, #059669)',
          }}
        >
          Run
          <ArrowRight size={14} aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}
