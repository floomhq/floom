/**
 * HeroAppTiles — proof-of-life cards directly under the hero CTA row.
 *
 * 2026-04-22 redesign ("kill PowerPoint icons"): the previous design
 * was an icon chip + bold title + two lines of grey text with zero
 * product preview. Federico flagged it as "PowerPoint boxes, not power
 * apps". The redesign replaces the icon with a real product thumbnail
 * — a 16:9 screenshot of the actual output the app produces (ranked
 * leads table, competitor scorecard, candidate shortlist). Benchmark is
 * the Vercel templates gallery, where every card leads with a product
 * thumbnail, not an icon.
 *
 * Thumbnails live in /public/cards/<slug>.webp and are authored from
 * static HTML mocks under scripts/card-shots/ (see render.sh there for
 * regeneration). Apps without a thumbnail (utility apps like JWT decode
 * or UUID gen, which have terse zero-click output) fall back to the
 * compact icon + text variant so the grid doesn't break.
 *
 * Prior doc for context:
 * Purpose: proof-of-life above the fold. v11 landing put 4 apps in a
 * card grid INSIDE the hero wrap; the 2026-04-19 compression pass pulled
 * them out and left the hero as typography + form only. Federico's
 * feedback ("landing page can be improved a lot") mapped directly to
 * this loss: the hero stopped demonstrating the product.
 *
 * Each tile links to `/p/:slug` (same destination as the full AppStripe on
 * the featured-apps section further down).
 */
import { Link } from 'react-router-dom';
import { AppIcon } from '../AppIcon';

interface Tile {
  slug: string;
  name: string;
  description: string;
}

interface HeroAppTilesProps {
  tiles: Tile[];
  /**
   * Total number of apps in the directory (used to compute the "+N
   * more" count on the last tile). Defaults to `tiles.length` when not
   * provided. Passed in by CreatorHeroPage so the badge reflects the
   * real hub size, not just the curated roster.
   */
  totalCount?: number;
}

const DISPLAYED_TILE_COUNT = 4;

/**
 * Slugs that have an authored product-thumbnail WebP in /public/cards/.
 * Kept as a static set rather than a dynamic import because (a) these
 * are the handful of showcase demos we control, (b) we want the code
 * to fail loudly (missing image at runtime) if the asset is removed,
 * and (c) utility apps (jwt-decode, uuid, password, json-format)
 * deliberately fall back to the icon+text variant so we don't have to
 * fabricate a "cool output" thumbnail for a terse zero-click utility.
 * To add a new showcase: drop `public/cards/<slug>.webp` and append
 * the slug here.
 */
const THUMBED_SLUGS = new Set([
  'lead-scorer',
  'competitor-analyzer',
  'resume-screener',
]);

function hasThumb(slug: string): boolean {
  return THUMBED_SLUGS.has(slug);
}

export function HeroAppTiles({ tiles, totalCount }: HeroAppTilesProps) {
  if (tiles.length === 0) return null;

  const shown = tiles.slice(0, DISPLAYED_TILE_COUNT);
  const effectiveTotal = typeof totalCount === 'number' ? totalCount : tiles.length;
  const hasHiddenApps = effectiveTotal > shown.length;
  const overflowCount = hasHiddenApps ? effectiveTotal - shown.length : 0;

  return (
    <div
      data-testid="hero-app-tiles"
      className="hero-app-tiles"
      style={{
        marginTop: 32,
        display: 'grid',
        gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))`,
        gap: 14,
        maxWidth: 920,
        marginLeft: 'auto',
        marginRight: 'auto',
        textAlign: 'left',
      }}
    >
      {shown.map((t, i) => {
        const isLast = i === shown.length - 1;
        const showOverflowBadge = isLast && overflowCount > 0;
        const thumbed = hasThumb(t.slug);
        return (
          <Link
            key={t.slug}
            to={`/p/${t.slug}`}
            data-testid={`hero-tile-${t.slug}`}
            className="hero-app-tile"
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 14,
              color: 'inherit',
              textDecoration: 'none',
              overflow: 'hidden',
              transition:
                'border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.borderColor = 'var(--ink)';
              el.style.transform = 'translateY(-2px)';
              el.style.boxShadow = '0 8px 24px rgba(14, 14, 12, 0.08)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.borderColor = 'var(--line)';
              el.style.transform = 'translateY(0)';
              el.style.boxShadow = 'none';
            }}
          >
            {thumbed ? (
              <div
                data-testid={`hero-tile-thumb-${t.slug}`}
                style={{
                  position: 'relative',
                  width: '100%',
                  aspectRatio: '16 / 9',
                  overflow: 'hidden',
                  borderBottom: '1px solid var(--line)',
                  background: '#fafaf7',
                }}
              >
                <img
                  src={`/cards/${t.slug}.webp`}
                  alt=""
                  aria-hidden="true"
                  loading="eager"
                  decoding="async"
                  width={640}
                  height={360}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    objectPosition: 'top',
                    display: 'block',
                  }}
                />
              </div>
            ) : (
              // Fallback for utility apps (jwt-decode, uuid, etc.) that
              // don't have an authored product thumbnail. Keeps the
              // compact icon + text shape so the grid stays coherent.
              <div
                style={{
                  position: 'relative',
                  width: '100%',
                  aspectRatio: '16 / 9',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background:
                    'linear-gradient(180deg, #fdfdfa 0%, #f4f4ee 100%)',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background:
                      'radial-gradient(circle at 30% 25%, #d1fae5 0%, #ecfdf5 55%, #d1fae5 100%)',
                    color: '#047857',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow:
                      'inset 0 0 0 1px rgba(5,150,105,0.15), 0 1px 2px rgba(5,150,105,0.18), inset 0 1px 0 rgba(255,255,255,0.6)',
                  }}
                >
                  <AppIcon slug={t.slug} size={22} color="#047857" />
                </span>
              </div>
            )}
            <div
              style={{
                padding: '12px 14px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: 'var(--ink)',
                  lineHeight: 1.25,
                  letterSpacing: '-0.005em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.name}
              </div>
              <div
                className="hero-app-tile-desc"
                style={{
                  fontSize: 12,
                  color: 'var(--muted)',
                  lineHeight: 1.4,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.description}
              </div>
            </div>
            {showOverflowBadge && (
              <span
                data-testid="hero-tile-overflow"
                style={{
                  position: 'absolute',
                  right: 10,
                  top: 10,
                  fontSize: 11,
                  color: 'var(--accent)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  background: 'var(--card)',
                  padding: '3px 7px',
                  borderRadius: 6,
                  letterSpacing: '-0.01em',
                  border: '1px solid var(--line)',
                }}
              >
                +{overflowCount} more
              </span>
            )}
          </Link>
        );
      })}

      <style>{`
        @media (max-width: 900px) {
          .hero-app-tiles {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }
        @media (max-width: 520px) {
          .hero-app-tiles {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
        }
      `}</style>
    </div>
  );
}
