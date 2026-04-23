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

// Category badge palette — single restrained neutral across ALL cards
// (2026-04-24 per Federico: "for app cards: i really want to refrain
// from using many colours"). We used to ship 4 buckets (emerald / amber
// / blue / slate) which painted HIRING / GROWTH / RESEARCH in distinct
// pastel hues — alongside the pastel-tinted thumbnail band and output
// strip, the grid read as a rainbow. The restraint is: one chip style
// for every category, one band tint for every card, one output-strip
// style for every card. Brand green stays the ONLY accent, reserved
// for the "Run →" CTA, HERO badge text, hot-star glyph, output-strip
// dot, and the hover border (via `var(--ink)`).
const CARD_NEUTRAL = {
  bg: '#f5f5f3',       // warm light neutral — band + icon tiles + output strip
  fg: '#1b1a17',       // warm dark neutral — icons inside tiles
  chipBg: 'rgba(255,255,255,0.92)',
  chipBorder: 'var(--line)',
  chipFg: 'var(--muted)',
} as const;

function formatRuns(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    // One decimal when it reads cleanly (e.g. 1.3k), drop when it
    // wouldn't add info (e.g. 2k not 2.0k).
    return k % 1 === 0 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

/**
 * Per-slug output-preview snippets — small taste of what the app returns.
 *
 * Added 2026-04-24 after the browser audit flagged cards as "not sexy":
 * plain icon + title + description gave no preview of the actual output.
 * Hardcoded for the 3 launch showcase apps; any app without an entry
 * falls through to a null (no preview row), which keeps unknown apps
 * looking clean rather than fake.
 *
 * When the backend grows an `output_preview` field on HubApp this map
 * becomes the fallback and the API value wins.
 */
const OUTPUT_PREVIEWS: Record<string, string> = {
  'lead-scorer': '87/100 · Strong fit',
  'resume-screener': '92/100 · Top candidate',
  'competitor-analyzer': '3 strengths, 2 gaps',
};

export function AppGrid({ apps, variant = 'default' }: AppGridProps) {
  // HERO badge is pure visual noise when EVERY visible card is a hero —
  // the tag stops signalling "this one's featured" and just clutters
  // three identical corners (audit 2026-04-24: S3). Suppress it while
  // the directory is in that all-hero state; once we ship a 4th+ app
  // and the ratio breaks, the badge naturally reappears on the ones
  // that are marked. We also continue to render it when there's only
  // one card, since a solitary badge still reads as intentional.
  const heroCount = apps.reduce((n, a) => n + (a.hero ? 1 : 0), 0);
  const suppressHeroBadge = apps.length > 1 && heroCount === apps.length;

  // Grid layout (2026-04-24): switched from fixed `repeat(4, 1fr)` to
  // `auto-fit` so the directory doesn't leave a dead empty column when
  // the app count is smaller than 4. At launch there are 3 showcase apps
  // in the prod curation, which previously rendered as 3 cards + one
  // ~400px hole on the right (audit screenshot `apps-prod.png`). With
  // auto-fit the 3 cards now expand to fill the 1180px container. When
  // the directory grows past 4 apps the layout naturally settles back to
  // a tight 4-col grid.
  const gridColumns =
    apps.length <= 3
      ? `repeat(${Math.max(1, apps.length)}, minmax(240px, 1fr))`
      : 'repeat(auto-fill, minmax(260px, 1fr))';

  return (
    <div
      data-testid="apps-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: gridColumns,
        gap: 16,
      }}
      className="app-grid"
    >
      {apps.map((app) => (
        <AppGridCard
          key={app.slug}
          app={app}
          variant={variant}
          suppressHeroBadge={suppressHeroBadge}
        />
      ))}
      <style>{`
        @media (max-width: 1024px) {
          .app-grid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)) !important; }
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
  suppressHeroBadge = false,
}: {
  app: HubApp;
  variant?: 'default' | 'featured';
  suppressHeroBadge?: boolean;
}) {
  const stars = app.stars ?? 0;
  const runs7d = app.runs_7d ?? 0;
  const isHot = stars >= 100;
  const hero = !!app.hero && !suppressHeroBadge;
  const thumbnail = app.thumbnail_url ?? null;
  const isFeatured = variant === 'featured';
  const thumbHeight = isFeatured ? 140 : 120;
  const titleSize = isFeatured ? 16 : 15;
  // 2026-04-24 polish: hide the "0 stars" meta while the product has no
  // users — it reads as noise ("⭐ 0"). Show only when the count is > 0.
  // The "hot" accent still triggers at >= 100 through `isHot`.
  const showStars = stars > 0;
  // Per-slug output preview (what the app returns) — small taste below
  // the description so the card isn't purely name + blurb. Hardcoded
  // for the 3 launch apps; null for everything else (no fake preview).
  const outputPreview = OUTPUT_PREVIEWS[app.slug] ?? null;

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
        // 2026-04-24 polish: slightly stronger lift + border highlight so
        // the hover feels responsive rather than cosmetic. Still subtle —
        // 2px lift, no glow, no animation beyond the 140ms transition set
        // on the base style.
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--ink)';
        el.style.transform = 'translateY(-2px)';
        el.style.boxShadow = '0 10px 24px -16px rgba(14,14,12,0.25)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--line)';
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = 'none';
      }}
    >
      {/* THUMBNAIL. Gradient tile + centered AppIcon (or real PNG when
          we have one). Top-right corner hosts the category chip so the
          card footer can stay clean (2026-04-24 audit: chip previously
          sat bottom-left and competed with the "Run →" CTA). HERO badge
          — when present — sits on the top-left so it never collides
          with the category chip. */}
      <div
        data-testid={`app-grid-thumb-${app.slug}`}
        style={{
          height: thumbHeight,
          background: thumbnail ? 'var(--bg)' : CARD_NEUTRAL.bg,
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
              color: CARD_NEUTRAL.fg,
            }}
            aria-hidden="true"
          >
            <AppIcon slug={app.slug} size={isFeatured ? 52 : 44} color={CARD_NEUTRAL.fg} />
          </div>
        )}

        {/* Category chip — top-right inside the pastel band. Moved here
            from the footer (2026-04-24 polish). Keeps the colored-per-
            category signal but out of the CTA row. */}
        {app.category && (
          <span
            data-testid={`app-grid-category-${app.slug}`}
            data-category={app.category}
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10,
              color: CARD_NEUTRAL.chipFg,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              padding: '3px 8px',
              border: `1px solid ${CARD_NEUTRAL.chipBorder}`,
              borderRadius: 4,
              background: CARD_NEUTRAL.chipBg,
              fontWeight: 600,
              boxShadow: '0 1px 2px rgba(15,23,42,0.06)',
              backdropFilter: 'saturate(1.2)',
            }}
          >
            {labelForCategory(app.category)}
          </span>
        )}

        {hero && (
          <span
            data-testid={`app-grid-hero-${app.slug}`}
            style={{
              position: 'absolute',
              top: 10,
              left: 10,
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
            background: CARD_NEUTRAL.bg,
            boxShadow: 'inset 0 0 0 1px rgba(15, 23, 42, 0.06)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: CARD_NEUTRAL.fg,
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          <AppIcon slug={app.slug} size={18} color={CARD_NEUTRAL.fg} />
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
          narrow mobile column is tighter than expected.
          2026-04-24 polish: hide the star glyph + count while the app
          has 0 stars (reads as noise pre-launch). Reappears naturally
          when stars > 0. */}
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
        {showStars && (
          <>
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
          </>
        )}
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
          marginBottom: outputPreview ? 10 : 12,
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

      {/* OUTPUT PREVIEW — small taste of what the app returns (e.g.
          "87/100 · Strong fit" for Lead Scorer). Only rendered when we
          have a curated snippet for the slug; keeps unknown apps
          looking intentional rather than showing a fake placeholder. */}
      {outputPreview && (
        <div
          data-testid={`app-grid-preview-${app.slug}`}
          style={{
            margin: '0 14px 12px',
            padding: '8px 10px',
            borderRadius: 8,
            background: CARD_NEUTRAL.bg,
            boxShadow: 'inset 0 0 0 1px rgba(15,23,42,0.05)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11.5,
            color: CARD_NEUTRAL.fg,
            fontWeight: 600,
            letterSpacing: '0.01em',
            minWidth: 0,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--accent, #047857)',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {outputPreview}
          </span>
        </div>
      )}

      {/* FOOTER: Run → CTA, right-aligned. Category pill moved to the
          thumbnail band (2026-04-24 polish), so this row is now a single
          action affordance — no competition. */}
      <div
        style={{
          marginTop: 'auto',
          padding: '10px 14px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
          minHeight: 44,
        }}
      >
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
