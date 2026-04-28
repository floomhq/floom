/**
 * AppsList — shared content shell for /run/apps and /studio/apps.
 *
 * Structure (identical in both modes, only data + CTAs differ):
 *   wc-head: title + subtitle + primary CTA
 *   hero-stat-row: 4 stat cards
 *   filter toolbar
 *   apps grid
 *   secondary panel (recent runs / recent activity)
 *   activity strip (bottom CTA)
 *
 * mode="run"    → browse-store CTA, recently-used app cards, "Recent runs" panel
 * mode="studio" → new-app CTA, owned app cards, "Recent activity" panel
 */

import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../AppIcon';
import { formatTime } from '../../lib/time';
import type { CreatorApp, MeRunSummary } from '../../lib/types';

// ── Stat card ────────────────────────────────────────────────────────

interface StatCardData {
  label: string;
  value: string;
  sub?: string;
}

// ── App item (unified shape for run + studio) ────────────────────────

export interface AppsListAppItem {
  slug: string;
  name: string;
  /** Mono meta line: last run time, run count, status etc. */
  meta: string;
  description: string;
  /** CTA label shown at bottom of card */
  ctaLabel: string;
  /** href the card links to */
  href: string;
}

// ── Activity row (recent runs / recent activity) ─────────────────────

export interface AppsListActivityRow {
  id: string;
  title: string;
  snippet: string;
  duration: string;
  when: string;
  href: string;
  fast?: boolean;
}

// ── Top-level props ──────────────────────────────────────────────────

export interface AppsListProps {
  mode: 'run' | 'studio';
  /** Page heading */
  heading: string;
  /** Supporting subtitle */
  subtitle: string;
  /** Primary CTA in page-head */
  primaryCta: ReactNode;
  /** 4 hero stat cards */
  stats: [StatCardData, StatCardData, StatCardData, StatCardData];
  /** Filter chips: label + whether active */
  filters?: Array<{ label: string; active?: boolean }>;
  /** Secondary action in toolbar (e.g. "Browse the store →") */
  toolbarAction?: ReactNode;
  /** App cards in the grid */
  apps: AppsListAppItem[] | null;
  /** Activity panel title */
  activityTitle: string;
  /** Activity panel "view all" link */
  activityAllHref: string;
  /** Activity rows */
  activityRows?: AppsListActivityRow[];
  /** Bottom strip CTA */
  stripCta: ReactNode;
  /** Loading state */
  loading?: boolean;
}

// ── Styles ───────────────────────────────────────────────────────────

const s: Record<string, CSSProperties> = {
  content: {
    padding: '24px 28px 64px',
  },
  head: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 18,
    flexWrap: 'wrap',
    marginBottom: 18,
  },
  h1: {
    fontFamily: 'var(--font-display)',
    fontWeight: 800,
    fontSize: 30,
    letterSpacing: '-0.02em',
    lineHeight: 1.1,
    margin: '0 0 5px',
    color: 'var(--ink)',
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--muted)',
    margin: 0,
    lineHeight: 1.55,
  },
  heroRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 12,
    marginBottom: 18,
  },
  statCard: {
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 12,
    padding: '14px 16px',
  },
  statLab: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10.5,
    color: 'var(--muted)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    fontWeight: 600,
  },
  statVal: {
    fontFamily: 'JetBrains Mono, monospace',
    fontWeight: 700,
    fontSize: 22,
    color: 'var(--ink)',
    lineHeight: 1,
    marginTop: 6,
  },
  statSub: {
    fontSize: 11,
    color: 'var(--muted)',
    marginTop: 3,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  filters: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  chip: {
    fontSize: 12,
    padding: '5px 11px',
    borderRadius: 999,
    background: 'var(--card)',
    border: '1px solid var(--line)',
    color: 'var(--muted)',
    fontWeight: 500,
    cursor: 'pointer',
  },
  chipOn: {
    background: 'var(--accent-soft)',
    color: 'var(--accent)',
    borderColor: 'var(--accent-border)',
    fontWeight: 600,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 14,
    marginBottom: 18,
  },
  card: {
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 14,
    padding: 16,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    textDecoration: 'none',
    color: 'inherit',
    boxShadow: 'var(--shadow-1)',
  },
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 11,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    background: 'var(--bg)',
    border: '1px solid var(--line)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardName: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--ink)',
  },
  cardMeta: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10.5,
    color: 'var(--muted)',
    marginTop: 2,
  },
  cardDesc: {
    margin: 0,
    fontSize: 12.5,
    color: 'var(--muted)',
    lineHeight: 1.5,
  },
  cardCta: {
    fontSize: 12,
    color: 'var(--accent)',
    fontWeight: 600,
    marginTop: 'auto',
  },
  panel: {
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 12,
    padding: '18px 20px',
    boxShadow: 'var(--shadow-1)',
    marginBottom: 16,
  },
  panelHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  panelTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--ink)',
  },
  panelLink: {
    fontSize: 12,
    color: 'var(--accent)',
    textDecoration: 'none',
    fontWeight: 500,
  },
  actRow: {
    display: 'grid',
    gridTemplateColumns: '20px minmax(0,1fr) auto auto',
    alignItems: 'center',
    gap: 12,
    padding: '10px 0',
    borderTop: '1px solid var(--line)',
    textDecoration: 'none',
    color: 'inherit',
    fontSize: 12.5,
  },
  actTitle: {
    fontWeight: 600,
    color: 'var(--ink)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  actSnippet: {
    fontSize: 11.5,
    color: 'var(--muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  durFast: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10.5,
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
    border: '1px solid var(--accent-border)',
    borderRadius: 999,
    padding: '2px 8px',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
  },
  durNormal: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10.5,
    color: 'var(--muted)',
    background: 'var(--bg)',
    border: '1px solid var(--line)',
    borderRadius: 999,
    padding: '2px 8px',
    whiteSpace: 'nowrap' as const,
  },
  when: {
    fontSize: 11.5,
    color: 'var(--muted)',
    whiteSpace: 'nowrap' as const,
  },
  strip: {
    marginTop: 4,
  },
  loading: {
    padding: 18,
    fontSize: 13.5,
    color: 'var(--muted)',
  },
};

// ── Component ────────────────────────────────────────────────────────

export function AppsList({
  mode,
  heading,
  subtitle,
  primaryCta,
  stats,
  filters = [],
  toolbarAction,
  apps,
  activityTitle,
  activityAllHref,
  activityRows = [],
  stripCta,
  loading = false,
}: AppsListProps) {
  return (
    <div data-testid={`workspace-apps-${mode}`} style={s.content}>

      {/* 1. page-head */}
      <div style={s.head}>
        <div>
          <h1 style={s.h1}>{heading}</h1>
          <p style={s.subtitle}>{subtitle}</p>
        </div>
        {primaryCta}
      </div>

      {/* 2. hero stat row */}
      <div style={s.heroRow} data-testid="workspace-apps-stats">
        {stats.map((stat) => (
          <div key={stat.label} style={s.statCard}>
            <div style={s.statLab}>{stat.label}</div>
            <div style={s.statVal}>{stat.value}</div>
            {stat.sub ? <div style={s.statSub}>{stat.sub}</div> : null}
          </div>
        ))}
      </div>

      {/* 3. filter toolbar */}
      {filters.length > 0 && (
        <div style={s.toolbar}>
          <div style={s.filters}>
            {filters.map((f) => (
              <span
                key={f.label}
                style={f.active ? { ...s.chip, ...s.chipOn } : s.chip}
              >
                {f.label}
              </span>
            ))}
          </div>
          {toolbarAction ? <div>{toolbarAction}</div> : null}
        </div>
      )}

      {/* 4. apps grid */}
      {loading ? (
        <div style={s.loading}>Loading apps…</div>
      ) : apps && apps.length > 0 ? (
        <div style={s.grid} data-testid="workspace-apps-grid">
          {apps.map((app) => (
            <AppCard key={app.slug} app={app} />
          ))}
        </div>
      ) : apps && apps.length === 0 ? (
        <EmptyApps mode={mode} />
      ) : null}

      {/* 5. secondary panel */}
      {activityRows.length > 0 && (
        <div style={s.panel} data-testid="workspace-apps-activity">
          <div style={s.panelHead}>
            <span style={s.panelTitle}>{activityTitle}</span>
            <Link to={activityAllHref} style={s.panelLink}>
              {mode === 'run' ? 'View all' : 'All runs'}
            </Link>
          </div>
          {activityRows.map((row) => (
            <ActivityRow key={row.id} row={row} />
          ))}
        </div>
      )}

      {/* 6. bottom strip */}
      <div style={s.strip}>{stripCta}</div>

    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function AppCard({ app }: { app: AppsListAppItem }) {
  return (
    <Link
      to={app.href}
      data-testid={`workspace-app-card-${app.slug}`}
      style={s.card}
    >
      <div style={s.cardHead}>
        <span style={s.iconWrap} aria-hidden="true">
          <AppIcon slug={app.slug} size={18} />
        </span>
        <div>
          <div style={s.cardName}>{app.name}</div>
          <div style={s.cardMeta}>{app.meta}</div>
        </div>
      </div>
      <p style={s.cardDesc}>{app.description}</p>
      <span style={s.cardCta}>{app.ctaLabel}</span>
    </Link>
  );
}

function ActivityRow({ row }: { row: AppsListActivityRow }) {
  return (
    <Link to={row.href} style={s.actRow}>
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: 'var(--accent)',
          display: 'inline-block',
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={s.actTitle}>{row.title}</div>
        <div style={s.actSnippet}>{row.snippet}</div>
      </div>
      <span style={row.fast ? s.durFast : s.durNormal}>{row.duration}</span>
      <span style={s.when}>{row.when}</span>
    </Link>
  );
}

function EmptyApps({ mode }: { mode: 'run' | 'studio' }) {
  if (mode === 'run') {
    return (
      <div
        data-testid="workspace-apps-empty-run"
        style={{
          border: '1px solid var(--line)',
          borderRadius: 24,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,248,243,0.94) 100%)',
          padding: '38px 28px',
          textAlign: 'center',
          marginBottom: 18,
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 24,
            fontWeight: 800,
            letterSpacing: '-0.04em',
            lineHeight: 1.1,
            color: 'var(--ink)',
            margin: '0 0 10px',
          }}
        >
          No apps installed yet.
        </h2>
        <p style={{ margin: '0 auto 22px', maxWidth: 420, fontSize: 15, lineHeight: 1.65, color: 'var(--muted)' }}>
          Browse the public store to install your first app.
        </p>
        <Link
          to="/apps"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '11px 18px',
            borderRadius: 999,
            background: 'var(--ink)',
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          Browse the store →
        </Link>
        <p style={{ margin: '16px auto 0', maxWidth: 380, fontSize: 12.5, lineHeight: 1.6, color: 'var(--muted)' }}>
          Or use Floom from Claude, Cursor, or Codex via MCP &mdash;
          install the floom server in your tool&rsquo;s config.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="workspace-apps-empty-studio"
      style={{
        border: '1px solid var(--line)',
        borderRadius: 24,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,248,243,0.94) 100%)',
        padding: '38px 28px',
        textAlign: 'center',
        marginBottom: 18,
      }}
    >
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 24,
          fontWeight: 800,
          letterSpacing: '-0.04em',
          lineHeight: 1.1,
          color: 'var(--ink)',
          margin: '0 0 10px',
        }}
      >
        No apps published yet.
      </h2>
      <p style={{ margin: '0 auto 22px', maxWidth: 420, fontSize: 15, lineHeight: 1.65, color: 'var(--muted)' }}>
        Create your first app from a GitHub repo, OpenAPI spec, or blank canvas.
      </p>
      <Link
        to="/studio/build"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '11px 18px',
          borderRadius: 999,
          background: 'var(--ink)',
          color: '#fff',
          fontSize: 14,
          fontWeight: 700,
          textDecoration: 'none',
        }}
      >
        + New app
      </Link>
      <p style={{ margin: '16px auto 0', maxWidth: 380, fontSize: 12.5, lineHeight: 1.6, color: 'var(--muted)' }}>
        After you publish, apps appear in the public store at /apps once approved.
      </p>
    </div>
  );
}

// ── Convenience helpers for callers ──────────────────────────────────

/** Convert a MeRunSummary list → AppsListAppItem list for Run mode */
export function runAppsFromRuns(runs: MeRunSummary[]): AppsListAppItem[] {
  const seen = new Map<string, MeRunSummary>();
  for (const run of runs) {
    if (!run.app_slug) continue;
    if (!seen.has(run.app_slug)) seen.set(run.app_slug, run);
  }
  return Array.from(seen.values()).map((run) => ({
    slug: run.app_slug!,
    name: run.app_name || run.app_slug!,
    meta: run.started_at ? `last run ${formatTime(run.started_at)}` : '',
    description: run.action || '',
    ctaLabel: 'Run again →',
    href: `/run/apps/${run.app_slug}`,
  }));
}

/** Convert a CreatorApp list → AppsListAppItem list for Studio mode */
export function studioAppsFromCreatorApps(apps: CreatorApp[]): AppsListAppItem[] {
  return apps.map((app) => ({
    slug: app.slug,
    name: app.name,
    meta: [
      app.run_count > 0 ? `${app.run_count.toLocaleString()} runs` : null,
      app.last_run_at ? `last ${formatTime(app.last_run_at)}` : null,
      app.publish_status && app.publish_status !== 'published' ? app.publish_status.toUpperCase() : null,
    ]
      .filter(Boolean)
      .join(' · '),
    description: app.description || '',
    ctaLabel: 'Open dashboard →',
    href: `/studio/${app.slug}`,
  }));
}
