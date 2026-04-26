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
import { BannerCard, type BannerLine } from './BannerCard';
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
 * Per-slug banner-card content (Delta 12, v23 wireframe). Each
 * registered slug renders a small mono "run-state" preview inside the
 * thumbnail band — a tiny executable taste of what the app returns, NOT
 * a fake screenshot or generic icon. Federico-locked 2026-04-25:
 * "show the result of running the app, not the app identity."
 *
 * Source of truth = wireframes-floom v23 apps.html lines 304-381 for
 * the utility apps; lines 215-281 for the 3 launch AI apps (which
 * normally render in <AppShowcaseRow> but stay registered here in
 * case the grid renders them under a tag filter).
 *
 * Slugs without an entry fall through to the icon-only band.
 *
 * 2026-04-26 (PR-C): replaced the previous MiniViz slug set
 * (lead-scorer / resume-screener / competitor-analyzer) — those apps
 * shipped in the launch demo trio that has been retired. The new
 * launch trio (competitor-lens, ai-readiness-audit, pitch-coach) gets
 * editorial banner content; the 7 utility apps (json-format, uuid,
 * jwt-decode, password, hash, base64, word-count) get pattern-shape
 * banner content keyed off their actual output.
 */
const BANNER_CONTENT: Record<
  string,
  { title: string; lines: BannerLine[] }
> = {
  // Launch AI trio — used as fallback if these slugs ever render in
  // the browse grid (e.g. under a filter). Normal path is the
  // showcase row above.
  'competitor-lens': {
    title: 'competitor-lens',
    lines: [
      { text: 'stripe vs adyen' },
      { text: 'fee 1.4% vs 1.6%', dim: true },
      { text: 'winner: stripe', accent: true },
    ],
  },
  'ai-readiness-audit': {
    title: 'ai-readiness',
    lines: [
      { text: 'floom.dev' },
      { text: 'score: 8.4/10', dim: true },
      { text: '3 risks · 3 wins', accent: true },
    ],
  },
  'pitch-coach': {
    title: 'pitch-coach',
    lines: [
      { text: 'harsh truth' },
      { text: '3 critiques', accent: true },
      { text: '3 rewrites', dim: true },
    ],
  },
  // Utility apps — banner shapes mirror what each one actually returns.
  'jwt-decode': {
    title: 'jwt decode',
    lines: [
      { text: 'iss: floom.dev' },
      { text: 'sub: usr_***' },
      { text: 'exp: 2027-04-26', dim: true },
    ],
  },
  'json-format': {
    title: 'format',
    lines: [
      { text: '{' },
      { text: '  "ok": true,' },
      { text: '  "n": 42' },
      { text: '}' },
    ],
  },
  password: {
    title: 'password',
    lines: [
      { text: 'k7T#mq2&Lp9' },
      { text: 'v4*8nW@2Zb1y', dim: true },
      { text: '9sP!q3&Hr5cF', dim: true },
    ],
  },
  uuid: {
    title: 'uuid v4',
    lines: [
      { text: 'a3f8e1c2-4d9b' },
      { text: '8c7e-1f3b9d2a', dim: true },
      { text: 'b1d4-7a2f-9e8c', dim: true },
    ],
  },
  hash: {
    title: 'sha-256',
    lines: [
      { text: 'a3f8e1c2…' },
      { text: '4d9b8c7e…', dim: true },
      { text: '1f3b9d2a', dim: true },
    ],
  },
  base64: {
    title: 'base64',
    lines: [
      { text: 'aGVsbG8gd29y' },
      { text: 'bGQgZnJvbSBm', dim: true },
      { text: 'bG9vbS5kZXY=', accent: true },
    ],
  },
  'word-count': {
    title: 'word-count',
    lines: [
      { text: 'words: 248' },
      { text: 'chars: 1,432', dim: true },
      { text: 'reading: 2 min', accent: true },
    ],
  },
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

  // Grid layout (2026-04-26, v23 wireframe parity): `repeat(4, 1fr)`
  // even-spacing 4-col on desktop, 3-col at 1024px, 2-col at 760px,
  // 1-col at 480px (apps-v23.html lines 78-80).
  //
  // Tradeoff vs the prior `auto-fill, minmax(260px, 380px)` (#679):
  // a single-card filtered state stretches that card across the full
  // 1180px container instead of keeping it at 380px. We accept the
  // regression because (a) the wireframe spec is authoritative and
  // (b) the showcase row above the grid removes the most common
  // single-card situation (3 launch apps render up there, not here).
  // If the stretched-card edge case bites, follow-up: cap each
  // grid-row item with `max-width: 380px` while keeping the 4-track
  // structure.
  //
  // Responsive breakpoints land via the `apps-grid-4col` class in
  // `csp-inline-style-migrations.css`, since this is a CSS-in-JS file
  // without media-query support.
  return (
    <div
      data-testid="apps-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 14,
      }}
      className="app-grid apps-grid-4col"
    >
      {apps.map((app) => (
        <AppGridCard
          key={app.slug}
          app={app}
          variant={variant}
          suppressHeroBadge={suppressHeroBadge}
        />
      ))}
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
  // v23 wireframe (apps-v23.html line 95): browse-grid card title is
  // 14px / 600. Featured variant (used by landing shelves) keeps the
  // 16px hero treatment.
  const titleSize = isFeatured ? 16 : 14;
  // 2026-04-24 polish: hide the "0 stars" meta while the product has no
  // users — it reads as noise ("⭐ 0"). Show only when the count is > 0.
  // The "hot" accent still triggers at >= 100 through `isHot`.
  const showStars = stars > 0;
  // Per-slug banner-card content (PR-C, v23): if the slug has an entry
  // in BANNER_CONTENT, render a mini run-state preview inside the
  // thumb. Falls back to the icon-only band for unknown apps. NO fake
  // banner-card content for apps we don't have a shape for — keeps the
  // directory honest.
  const bannerContent = BANNER_CONTENT[app.slug] ?? null;
  // Hide the "{N} runs" label while an app is new and barely used —
  // "0 runs" / "1 runs" reads as negative social proof pre-launch.
  // Above 10 runs, the counter becomes meaningful signal. 7d age
  // chip still renders so the card isn't dead silent.
  const showRuns = runs7d >= 10;

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
      {/* THUMB — v23 wireframe parity (apps-v23.html line 87).
          16:9 aspect-ratio panel with single neutral surface (NO
          category tints — Federico-locked 2026-04-26). Centred
          BannerCard renders a small mono "run-state" preview keyed to
          the slug; unknown apps fall back to a centred AppIcon. When
          a real `thumbnail_url` is set we still show the image. */}
      <div
        data-testid={`app-grid-thumb-${app.slug}`}
        style={{
          aspectRatio: '16 / 9',
          background: thumbnail
            ? 'var(--bg)'
            : `linear-gradient(135deg, var(--bg) 0%, ${CARD_NEUTRAL.bg} 100%)`,
          borderBottom: '1px solid var(--line)',
          position: 'relative',
          overflow: 'hidden',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
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
        ) : bannerContent ? (
          <BannerCard
            title={bannerContent.title}
            lines={bannerContent.lines}
            size="sm"
          />
        ) : (
          /* Fallback for apps we don't have a banner shape for: clean
             icon-only band. No fake banner-card content — the
             directory stays honest. */
          <div
            style={{
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

      {/* TITLE ROW — v23 wireframe parity (apps-v23.html line 95):
          plain name only, 14px / 600. The mini-tile icon next to the
          name was removed (wireframe doesn't carry it; the banner-card
          in the thumb is the visual anchor now). 2-line clamp keeps
          card heights aligned across the grid. */}
      <div style={{ padding: '14px 16px 6px' }}>
        <h3
          data-testid={`app-grid-title-${app.slug}`}
          style={{
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

      {/* STATS ROW — v23 wireframe parity (apps-v23.html line 97):
          single mono line, nowrap, 10.5px. Stat-line nowrap fix
          (decision doc PORT #6): the line shouldn't break mid-string.
          2026-04-24 polish (kept): hide the star glyph + count while
          the app has 0 stars; hide runs label while runs7d < 10. */}
      <div
        data-testid={`app-grid-stats-${app.slug}`}
        style={{
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'nowrap',
          columnGap: 6,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 10.5,
          color: 'var(--muted)',
          lineHeight: 1.3,
          fontVariantNumeric: 'tabular-nums',
          marginBottom: 6,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
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
        {showRuns && (
          <>
            <span data-testid={`app-grid-runs-${app.slug}`}>
              {formatRuns(runs7d)} runs
            </span>
            <span aria-hidden="true" style={{ color: 'var(--line)' }}>·</span>
            <span>7d</span>
          </>
        )}
        {/* FRESH badge removed 2026-04-24 (#657): every launch card is
           fresh on day one, so the badge painted on all 3 cards and read
           as noise rather than signal. When an app grows past 10 runs
           the real "{N} runs · 7d" counter takes over. No replacement
           badge — an empty stats row beats a meaningless one. */}
      </div>

      {/* DESCRIPTION — v23 wireframe parity (apps-v23.html line 96):
          12.5px / muted, 2-line clamp. Reserves 2 lines of height so
          card heights stay aligned across the grid. */}
      <div
        data-testid={`app-grid-desc-${app.slug}`}
        style={{
          padding: '0 16px',
          fontSize: 12.5,
          color: 'var(--muted)',
          lineHeight: 1.45,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          minHeight: 'calc(12.5px * 1.45 * 2)',
          marginBottom: 10,
          flex: 1,
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

      {/* FOOTER — v23 wireframe parity (apps-v23.html line 98): category
          cap (mono uppercase, muted) on the left + accent "Run →" on the
          right, separated from the description by a 1px border-top.
          Category moved here from the thumb top-right (2026-04-26
          PR-C): the thumb now hosts the BannerCard run-state preview
          and stays visually clean. */}
      <div
        style={{
          marginTop: 'auto',
          padding: '10px 16px 14px',
          borderTop: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minHeight: 40,
          fontSize: 11.5,
        }}
      >
        {app.category ? (
          <span
            data-testid={`app-grid-category-${app.slug}`}
            data-category={app.category}
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              fontWeight: 500,
            }}
          >
            {labelForCategory(app.category)}
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <span
          className="app-grid-cta"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
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
