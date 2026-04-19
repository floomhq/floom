/**
 * HeroAppTiles — 5 compact app chips directly under the hero CTA row.
 *
 * Purpose: proof-of-life above the fold. v11 landing put 4 apps (FlyFast,
 * OpenPaper, ...) in a card grid INSIDE the hero wrap; the 2026-04-19
 * compression pass pulled them out and left the hero as typography + form
 * only. Federico's feedback ("landing page can be improved a lot") mapped
 * directly to this loss: the hero stopped demonstrating the product.
 *
 * Each tile links to `/p/:slug` (same destination as the full AppStripe on
 * the featured-apps section further down). Renders a compact 44px icon +
 * app name + one-line description on a single row. At <900px the grid
 * collapses to 1 column so the strip still fits on the first scroll below
 * the hero CTA on mobile.
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
}

export function HeroAppTiles({ tiles }: HeroAppTilesProps) {
  if (tiles.length === 0) return null;
  // Show at most 5 in the hero strip. The full roster lives in the
  // Featured Apps section below; tiles here are the teaser.
  const shown = tiles.slice(0, 5);

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
      {shown.map((t) => (
        <Link
          key={t.slug}
          to={`/p/${t.slug}`}
          data-testid={`hero-tile-${t.slug}`}
          className="hero-app-tile"
          style={{
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
          <span
            aria-hidden="true"
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: '#ecfdf5',
              color: '#047857',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
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
            {t.description}
          </div>
        </Link>
      ))}

      <style>{`
        @media (max-width: 900px) {
          .hero-app-tiles {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
          /* Keep only the first 4 tiles on tablet so the grid stays clean. */
          .hero-app-tiles a:nth-child(n+5) {
            display: none !important;
          }
        }
        @media (max-width: 520px) {
          .hero-app-tiles {
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
          }
          .hero-app-tiles a:nth-child(n+5) {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
