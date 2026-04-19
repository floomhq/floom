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
}

const s: Record<string, CSSProperties> = {
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '14px 14px 12px',
    border: '1px solid var(--line)',
    borderRadius: 12,
    background: 'var(--card)',
    color: 'var(--ink)',
    textDecoration: 'none',
    transition: 'border-color 120ms ease',
    minHeight: 118,
    position: 'relative',
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    background: 'var(--bg)',
    border: '1px solid var(--line)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  name: {
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  meta: {
    fontSize: 12,
    color: 'var(--muted)',
    fontVariantNumeric: 'tabular-nums',
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
    alignSelf: 'flex-end',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: '#fff',
    background: 'var(--ink)',
    padding: '6px 12px',
    borderRadius: 6,
    lineHeight: 1,
  },
};

export function ToolTile({ slug, name, lastUsedAt, badge, testIdSuffix }: Props) {
  const suffix = testIdSuffix ?? slug;
  const rel = lastUsedAt ? formatTime(lastUsedAt) : null;
  return (
    <Link
      to={`/p/${slug}`}
      data-testid={`me-tool-tile-${suffix}`}
      style={s.tile}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--accent)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--line)';
      }}
    >
      <span aria-hidden style={s.iconWrap}>
        <AppIcon slug={slug} size={18} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={s.name} title={name}>
          {name}
        </span>
        {rel ? (
          <span style={s.meta}>Last used {rel}</span>
        ) : badge ? (
          <span style={s.badge}>{badge}</span>
        ) : null}
      </div>
      <span aria-hidden data-testid={`me-tool-run-${suffix}`} style={s.runCta}>
        Run →
      </span>
    </Link>
  );
}
