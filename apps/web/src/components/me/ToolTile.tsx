// ToolTile — used on /me "Your apps" grid. One tile per distinct app the
// user has previously run, sorted by last-used desc. The card body opens
// the app surface; the primary CTA deep-links to the user's last run so
// the form opens prefilled with the previous inputs when available.
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
import { buildRerunHref } from './runPreview';

interface Props {
  slug: string;
  name: string;
  /** ISO timestamp — shown as relative "3m ago" under the name. */
  lastUsedAt?: string | null;
  /** When present, the primary CTA preloads this run's inputs. */
  lastRunId?: string | null;
  lastRunAction?: string | null;
  /** Optional pill when tile is surfaced but not yet used (curated row). */
  badge?: string;
  testIdSuffix?: string;
  ctaLabel?: string;
}

const s: Record<string, CSSProperties> = {
  tile: {
    display: 'flex',
    flexDirection: 'column',
    padding: '18px 18px 16px',
    border: '1px solid var(--line)',
    borderRadius: 18,
    background:
      'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,248,243,0.92) 100%)',
    color: 'var(--ink)',
    minHeight: 154,
    position: 'relative',
    boxShadow: '0 1px 0 rgba(17, 24, 39, 0.03)',
  },
  contentLink: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    color: 'var(--ink)',
    textDecoration: 'none',
    minWidth: 0,
    flex: 1,
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
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    padding: '12px 16px',
    fontSize: 13.5,
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: '#fff',
    background: 'var(--ink)',
    borderRadius: 999,
    lineHeight: 1,
    textDecoration: 'none',
  },
};

export function ToolTile({
  slug,
  name,
  lastUsedAt,
  lastRunId,
  lastRunAction,
  badge,
  testIdSuffix,
  ctaLabel = 'Re-run',
}: Props) {
  const suffix = testIdSuffix ?? slug;
  const rel = lastUsedAt ? formatTime(lastUsedAt) : null;
  const rerunHref = buildRerunHref(slug, lastRunId, lastRunAction);

  return (
    <article style={s.tile}>
      <Link to={`/p/${slug}`} data-testid={`me-tool-tile-${suffix}`} style={s.contentLink}>
        <span aria-hidden style={s.iconWrap}>
          <AppIcon slug={slug} size={20} />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={s.name} title={name}>
            {name}
          </span>
          {rel ? (
            <span style={s.meta}>Last run {rel}</span>
          ) : badge ? (
            <span style={s.badge}>{badge}</span>
          ) : null}
        </div>
      </Link>
      <Link to={rerunHref} data-testid={`me-tool-run-${suffix}`} style={s.runCta}>
        {ctaLabel}
      </Link>
    </article>
  );
}
