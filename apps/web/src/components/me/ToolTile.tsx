// ToolTile — used on /me "Your apps" grid. One tile per distinct app the
// user has previously run, sorted by last-used desc. Tile body is a Link to
// /p/:slug so clicking anywhere opens the run surface; the visible "Run"
// pill is a visual affordance, not a separate target (it shares the same
// navigation as the card to avoid nested <a> / double-click confusion).
//
// Kept the "ToolTile" component name for file-level stability — it ships
// the same visual primitive the curated apps row also uses. The v18 IA
// rename ("tools" → "apps") applies to user-facing copy only; internal
// filenames stay put so git history stays legible.
//
// Empty / curated variant lives in MePage directly — this component is just
// the tile.

import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../AppIcon';
import { formatTime } from '../../lib/time';

interface Props {
  slug: string;
  name: string;
  /** ISO timestamp — shown as relative "3m ago" under the name. */
  lastUsedAt?: string | null;
  /** Optional pill when tile is surfaced but not yet used (curated row). */
  badge?: string;
  testIdSuffix?: string;
  ctaLabel?: string;
}

const s: Record<string, CSSProperties> = {
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: '18px 18px 16px',
    border: '1px solid var(--line)',
    borderRadius: 18,
    background:
      'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,248,243,0.92) 100%)',
    color: 'var(--ink)',
    textDecoration: 'none',
    transition: 'border-color 120ms ease, transform 120ms ease',
    minHeight: 154,
    position: 'relative',
    boxShadow: '0 1px 0 rgba(17, 24, 39, 0.03)',
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 12,
    background: 'rgba(255,255,255,0.72)',
    border: '1px solid var(--line)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  name: {
    fontSize: 15,
    fontWeight: 700,
    lineHeight: 1.3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    fontSize: 13,
    color: 'var(--muted)',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.45,
  },
  badge: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    padding: '2px 6px',
    borderRadius: 4,
    color: 'var(--accent)',
    border: '1px solid var(--accent)',
    background: 'rgba(16,185,129,0.08)',
    alignSelf: 'flex-start',
  },
  runCta: {
    marginTop: 'auto',
    alignSelf: 'flex-start',
    fontSize: 12.5,
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: '#fff',
    background: 'var(--ink)',
    padding: '9px 13px',
    borderRadius: 999,
    lineHeight: 1,
  },
};

export function ToolTile({
  slug,
  name,
  lastUsedAt,
  badge,
  testIdSuffix,
  ctaLabel = 'Run again',
}: Props) {
  const suffix = testIdSuffix ?? slug;
  const rel = lastUsedAt ? formatTime(lastUsedAt) : null;
  return (
    <Link
      to={`/p/${slug}`}
      data-testid={`me-tool-tile-${suffix}`}
      style={s.tile}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--accent)';
        (e.currentTarget as HTMLAnchorElement).style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--line)';
        (e.currentTarget as HTMLAnchorElement).style.transform = 'translateY(0)';
      }}
    >
      <span aria-hidden style={s.iconWrap}>
        <AppIcon slug={slug} size={20} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={s.name} title={name}>
          {name}
        </span>
        {rel ? (
          <span style={s.meta}>Latest run {rel}</span>
        ) : badge ? (
          <span style={s.badge}>{badge}</span>
        ) : null}
      </div>
      <span aria-hidden data-testid={`me-tool-run-${suffix}`} style={s.runCta}>
        {ctaLabel} →
      </span>
    </Link>
  );
}
