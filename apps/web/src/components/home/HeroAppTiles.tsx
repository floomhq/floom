/**
 * HeroAppTiles — compact app chips directly under the hero CTA row.
 *
 * Purpose: proof-of-life above the fold. v11 landing put 4 apps (FlyFast,
 * OpenPaper, ...) in a card grid INSIDE the hero wrap; the 2026-04-19
 * compression pass pulled them out and left the hero as typography + form
 * only. Federico's feedback ("landing page can be improved a lot") mapped
 * directly to this loss: the hero stopped demonstrating the product.
 *
 * 2026-04-20 landing-v4 fix (audit items 2c + 2d):
 *   - Show exactly 4 tiles at all viewports ≥ 640px. The old 5-tile
 *     layout dropped the 5th at 768–1024 via `:nth-child(n+5)` which
 *     looked like a broken grid. Four tiles with a "+N more" link in
 *     the fourth tile's footer is cleaner and doesn't change the count
 *     between breakpoints.
 *   - Clamp descriptions to 2 lines at a word boundary. The old layout
 *     had a CSS line-clamp at 2 but no content cap, so descriptions
 *     cut mid-word at narrow widths. We now hard-cap input descriptions
 *     at 80 chars at a word boundary before passing them to the tile,
 *     and still keep the CSS clamp as a safety net for unusual
 *     character widths.
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
   * more" count on the 4th tile). Defaults to `tiles.length` when not
   * provided. Passed in by CreatorHeroPage so the badge reflects the
   * real hub size, not just the 5 teaser slugs.
   */
  totalCount?: number;
}

const DISPLAYED_TILE_COUNT = 4;
// Hard cap on description length. Clamped at a word boundary so the
// tile reads as a finished sentence, not an ellipsised fragment. The
// CSS line-clamp at 2 is still enabled as a safety net for edge-case
// widths.
const DESCRIPTION_CAP = 80;

function clampToWordBoundary(text: string, cap: number): string {
  if (!text) return '';
  if (text.length <= cap) return text;
  const slice = text.slice(0, cap + 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > cap * 0.6 ? lastSpace : cap;
  return text.slice(0, cut).replace(/[,;:.\s]+$/, '') + '…';
}

export function HeroAppTiles({ tiles, totalCount }: HeroAppTilesProps) {
  if (tiles.length === 0) return null;

  // Show up to 4 tiles. When the roster has fewer (post-2026-04-21
  // curation: only 3 showcase demos), render exactly that many — no
  // ghost slots, no padding. When more apps exist, the last tile gets
  // a "+N more" footer that links to the full directory. If the
  // visible roster already covers the entire public hub, the overflow
  // badge is suppressed regardless of DISPLAYED_TILE_COUNT, so we
  // never say "+0 more" or imply hidden apps that don't exist.
  const shown = tiles.slice(0, DISPLAYED_TILE_COUNT);
  const effectiveTotal = typeof totalCount === 'number' ? totalCount : tiles.length;
  const hasHiddenApps = effectiveTotal > shown.length;
  const overflowCount = hasHiddenApps ? effectiveTotal - shown.length : 0;

  return (
    <div
      data-testid="hero-app-tiles"
      className="hero-app-tiles"
      style={{
        marginTop: 28,
        display: 'grid',
        gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))`,
        gap: 10,
        maxWidth: 820,
        marginLeft: 'auto',
        marginRight: 'auto',
        textAlign: 'left',
      }}
    >
      {shown.map((t, i) => {
        const isLast = i === shown.length - 1;
        const showOverflowBadge = isLast && overflowCount > 0;
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
              gap: 8,
              padding: '12px 12px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              color: 'inherit',
              textDecoration: 'none',
              transition: 'border-color 140ms ease, transform 140ms ease',
              minWidth: 0,
            }}
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
            {/* #279 launch polish (2026-04-21): radial gradient + inset
                highlight so the chip reads as a physical pill, not a flat
                square. Matches AppStripe's goosebumps tint. */}
            <span
              aria-hidden="true"
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                background:
                  'radial-gradient(circle at 30% 25%, #d1fae5 0%, #ecfdf5 55%, #d1fae5 100%)',
                color: '#047857',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                boxShadow:
                  'inset 0 0 0 1px rgba(5,150,105,0.15), 0 1px 2px rgba(5,150,105,0.18), inset 0 1px 0 rgba(255,255,255,0.6)',
              }}
            >
              <AppIcon slug={t.slug} size={18} color="#047857" />
            </span>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
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
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}
            >
              {clampToWordBoundary(t.description, DESCRIPTION_CAP)}
            </div>
            {showOverflowBadge && (
              <span
                data-testid="hero-tile-overflow"
                style={{
                  position: 'absolute',
                  right: 10,
                  bottom: 10,
                  fontSize: 11,
                  color: 'var(--accent)',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  background: 'var(--card)',
                  padding: '2px 6px',
                  borderRadius: 6,
                  letterSpacing: '-0.01em',
                }}
              >
                +{overflowCount} more
              </span>
            )}
          </Link>
        );
      })}

    </div>
  );
}
