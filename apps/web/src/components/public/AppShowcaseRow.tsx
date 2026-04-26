// AppShowcaseRow — 3-card editorial hero band above the browse grid.
// v23 wireframe parity (apps.html lines 208-283), single PORT block per
// /apps decision doc (2026-04-26).
//
// What it is:
//   - 3 large cards, one per launch AI app (competitor-lens,
//     ai-readiness-audit, pitch-coach). Card content is hardcoded —
//     this is editorial copy, not API data, because the wireframe's
//     run-state previews must match the actual launch demos and the
//     server doesn't expose `output_preview` yet.
//   - Each card uses the BannerCard pattern in its thumb (mono
//     "run result" preview), then name + desc + stats + tags + CTA row
//     below.
//
// What it is NOT:
//   - NO category tints. Federico-locked 2026-04-26 (overrides the
//     wireframe's banner-research / banner-writing tinted thumbs).
//     All 3 cards share one neutral surface.
//
// The card resolves an `HubApp` from the directory hub (so name, desc,
// runs, stars stay live and dynamic), but falls back to the editorial
// copy when the API hasn't returned that slug yet (e.g. while loading,
// or self-host where the slug isn't installed). This keeps the section
// "always present and stable" — no flash of empty state.

import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { CSSProperties } from 'react';
import { BannerCard, type BannerLine } from './BannerCard';
import type { HubApp } from '../../lib/types';

/**
 * Editorial showcase content per launch slug. Source of truth = v23
 * wireframe lines 215-281. Banner lines mirror the actual demo output
 * shape — when these strings drift from real run output, update both
 * here and the live demo so the card stays honest.
 */
interface ShowcaseEntry {
  slug: string;
  /** Display name fallback when the API hasn't loaded yet. */
  name: string;
  /** Tagline fallback. */
  description: string;
  /** Single-word category cap shown top-left of the thumb. */
  category: string;
  /** Mono title inside the banner-card. */
  bannerTitle: string;
  /** 3 result lines that mirror what the app actually returns. */
  bannerLines: BannerLine[];
  /** "via Floom or Claude" muted left text in the CTA row. */
  installVia: string;
  /** Optional tag pills shown above the CTA row. */
  tags: string[];
  /** Whether to render the green "#1 Featured" pill in the thumb. */
  topFeatured?: boolean;
}

const SHOWCASE_ENTRIES: ShowcaseEntry[] = [
  {
    slug: 'competitor-lens',
    name: 'Competitor Lens',
    description:
      'Compare your positioning to a competitor in under 2 seconds. Powered by Gemini 3 Pro, deterministic JSON.',
    category: 'Research',
    bannerTitle: 'competitor-lens',
    bannerLines: [
      { text: 'stripe vs adyen' },
      { text: 'fee 1.4% vs 1.6%', dim: true },
      { text: 'winner: stripe', accent: true },
    ],
    installVia: 'via Floom or Claude',
    tags: ['research', 'positioning', 'gemini'],
    topFeatured: true,
  },
  {
    slug: 'ai-readiness-audit',
    name: 'AI Readiness Audit',
    description:
      "Score a company's AI readiness on a single URL. Returns markdown ready to paste into Notion.",
    category: 'Research',
    bannerTitle: 'ai-readiness',
    bannerLines: [
      { text: 'floom.dev' },
      { text: 'score: 8.4/10', dim: true },
      { text: '3 risks · 3 wins', accent: true },
    ],
    installVia: 'via Floom or Cursor',
    tags: ['research', 'positioning'],
  },
  {
    slug: 'pitch-coach',
    name: 'Pitch Coach',
    description:
      'Roast and rewrite a startup pitch in your voice. Top 3 critiques, 3 punchier rewrites.',
    category: 'Writing',
    bannerTitle: 'pitch-coach',
    bannerLines: [
      { text: 'harsh truth' },
      { text: '3 critiques', accent: true },
      { text: '3 rewrites', dim: true },
    ],
    installVia: 'via Floom or ChatGPT',
    tags: ['writing', 'pitch'],
  },
];

export const SHOWCASE_ROW_SLUGS: ReadonlyArray<string> = SHOWCASE_ENTRIES.map(
  (e) => e.slug,
);

// Single neutral thumb surface (NO TINTS). Matches the AppGrid
// CARD_NEUTRAL palette so showcase + browse share one warm-light tone.
const THUMB_BG =
  'linear-gradient(135deg, var(--bg) 0%, #f5f5f3 100%)';
const THUMB_RING = 'inset 0 0 0 1px rgba(15, 23, 42, 0.06)';

function formatRuns(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k % 1 === 0 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
  }
  return String(n);
}

export interface AppShowcaseRowProps {
  /** Apps from the hub. We pluck the 3 launch slugs out by ID. */
  apps: HubApp[];
}

export function AppShowcaseRow({ apps }: AppShowcaseRowProps) {
  const bySlug = new Map(apps.map((a) => [a.slug, a]));
  // Only render editorial cards whose slug is in the supplied app list.
  // This way a chip filter / search narrows the showcase row in step
  // with the browse grid below — without a filter active, the caller
  // (`AppsDirectoryPage`) passes the full showcase set and all 3 render.
  // If the filter narrows out every showcase slug, the caller hides the
  // band entirely (`showShowcaseBand`), so this filter never produces
  // an empty row.
  const visibleEntries = SHOWCASE_ENTRIES.filter((e) => bySlug.has(e.slug));

  if (visibleEntries.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="apps-showcase"
      style={{
        maxWidth: 1180,
        margin: '0 auto',
        padding: '36px 28px 8px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 18,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: 24,
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--ink)',
          }}
        >
          Featured
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--accent, #047857)',
              border: '1px solid var(--accent-border, #a7f3d0)',
              borderRadius: 999,
              padding: '3px 9px',
              background: 'rgba(4, 120, 87, 0.06)',
            }}
          >
            FREE TO RUN
          </span>
        </h2>
        <p
          style={{
            fontSize: 13,
            color: 'var(--muted)',
            margin: 0,
          }}
        >
          3 AI apps. 5 free runs each on Floom's Gemini key.
        </p>
      </div>

      <div
        data-testid="apps-showcase-grid"
        className="apps-showcase-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 22,
        }}
      >
        {visibleEntries.map((entry) => (
          <ShowcaseCard
            key={entry.slug}
            entry={entry}
            app={bySlug.get(entry.slug)}
          />
        ))}
      </div>
    </section>
  );
}

function ShowcaseCard({
  entry,
  app,
}: {
  entry: ShowcaseEntry;
  app?: HubApp;
}) {
  // Prefer live API name/desc/stats when present (so a server edit
  // doesn't require a redeploy of the editorial fallback). Fall back
  // to the wireframe-locked strings when the slug isn't loaded.
  const name = app?.name ?? entry.name;
  const description = app?.description ?? entry.description;
  const runs7d = app?.runs_7d ?? 0;
  const stars = app?.stars ?? 0;
  const showStats = runs7d > 0 || stars > 0;

  const cardStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 18,
    overflow: 'hidden',
    textDecoration: 'none',
    color: 'inherit',
    boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    transition:
      'border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease',
  };

  return (
    <Link
      to={`/p/${entry.slug}`}
      data-testid={`apps-showcase-card-${entry.slug}`}
      aria-label={`${name} — open app`}
      style={cardStyle}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--ink)';
        el.style.transform = 'translateY(-2px)';
        el.style.boxShadow = '0 12px 28px -16px rgba(14,14,12,0.28)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLAnchorElement;
        el.style.borderColor = 'var(--line)';
        el.style.transform = 'translateY(0)';
        el.style.boxShadow = '0 1px 2px rgba(15,23,42,0.04)';
      }}
    >
      {/* THUMB — 16:10 aspect, banner-card centered, neutral surface
          (NO TINTS — Federico-locked). Corner tag + optional featured
          pill. */}
      <div
        className="sc-thumb"
        style={{
          aspectRatio: '16 / 10',
          background: THUMB_BG,
          boxShadow: THUMB_RING,
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 9.5,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            fontWeight: 600,
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '3px 7px',
            color: 'var(--muted)',
          }}
        >
          {entry.category}
        </span>
        {entry.topFeatured && (
          <span
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 9.5,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              fontWeight: 700,
              background: 'var(--accent, #047857)',
              color: '#fff',
              borderRadius: 6,
              padding: '3px 7px',
            }}
          >
            #1 Featured
          </span>
        )}
        <BannerCard
          title={entry.bannerTitle}
          lines={entry.bannerLines}
          size="lg"
        />
      </div>

      {/* BODY */}
      <div
        className="sc-body"
        style={{
          padding: '22px 22px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          flex: 1,
        }}
      >
        <div
          className="nm"
          data-testid={`apps-showcase-name-${entry.slug}`}
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            lineHeight: 1.2,
            color: 'var(--ink)',
          }}
        >
          {name}
        </div>
        <p
          className="desc"
          style={{
            fontSize: 13.5,
            color: 'var(--muted)',
            lineHeight: 1.55,
            margin: 0,
            flex: 1,
          }}
        >
          {description}
        </p>
        {showStats && (
          <div
            data-testid={`apps-showcase-stats-${entry.slug}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10.5,
              color: 'var(--muted)',
              // Stat-line nowrap fix per decision doc PORT #6: stats
              // line shouldn't wrap mid-string.
              whiteSpace: 'nowrap',
              flexWrap: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {runs7d > 0 && (
              <>
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
                <span>{formatRuns(runs7d)} runs / 7d</span>
              </>
            )}
            {runs7d > 0 && stars > 0 && (
              <span aria-hidden="true">·</span>
            )}
            {stars > 0 && <span>{stars} stars</span>}
          </div>
        )}
        <div
          className="tags"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 5,
            marginTop: 2,
          }}
        >
          {entry.tags.map((tag) => (
            <span
              key={tag}
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10,
                color: 'var(--muted)',
                letterSpacing: '0.04em',
                padding: '2px 7px',
                border: '1px solid var(--line)',
                borderRadius: 4,
                background: 'var(--bg)',
                fontWeight: 500,
              }}
            >
              {tag}
            </span>
          ))}
        </div>
        <div
          className="cta-row"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            paddingTop: 10,
            borderTop: '1px solid var(--line)',
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 11.5,
              color: 'var(--muted)',
            }}
          >
            {entry.installVia}
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'var(--accent, #047857)',
              color: '#fff',
              borderRadius: 9,
              padding: '8px 14px',
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            Run it
            <ArrowRight size={14} aria-hidden="true" />
          </span>
        </div>
      </div>
    </Link>
  );
}

/**
 * Skeleton placeholder for the 3-card showcase row. Reserves the same
 * vertical space as the rendered cards so the page doesn't shift down
 * when the API resolves. Matches `<AppGridSkeleton>` shimmer treatment.
 */
export function AppShowcaseRowSkeleton() {
  const shimmer: CSSProperties = {
    background:
      'linear-gradient(90deg, var(--line) 0%, rgba(0,0,0,0.04) 50%, var(--line) 100%)',
    backgroundSize: '200px 100%',
    backgroundRepeat: 'no-repeat',
    animation: 'apps-skeleton-shimmer 1.2s ease-in-out infinite',
    borderRadius: 6,
  };
  return (
    <section
      data-testid="apps-showcase-skeleton"
      aria-busy="true"
      aria-label="Loading featured apps"
      style={{
        maxWidth: 1180,
        margin: '0 auto',
        padding: '36px 28px 8px',
      }}
    >
      <div
        className="apps-showcase-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 22,
        }}
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 18,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                aspectRatio: '16 / 10',
                ...shimmer,
                borderRadius: 0,
              }}
            />
            <div style={{ padding: '22px 22px 20px' }}>
              <div style={{ height: 20, width: '60%', ...shimmer }} />
              <div
                style={{
                  height: 13,
                  width: '95%',
                  marginTop: 12,
                  ...shimmer,
                }}
              />
              <div
                style={{
                  height: 13,
                  width: '78%',
                  marginTop: 6,
                  ...shimmer,
                }}
              />
              <div
                style={{
                  marginTop: 18,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    height: 16,
                    width: 110,
                    borderRadius: 999,
                    ...shimmer,
                  }}
                />
                <div
                  style={{
                    height: 32,
                    width: 88,
                    borderRadius: 9,
                    ...shimmer,
                  }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
