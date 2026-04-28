/**
 * RunsList — shared content shell for /run/runs and /studio/runs.
 *
 * Structure (identical in both modes, only data differs):
 *   wc-head: title + subtitle + optional secondary action
 *   hero-stat-row: 4 stat cards
 *   filter toolbar
 *   runs table: icon · body · surface · duration · open link
 *   pagination strip
 *
 * mode="run"    → "Run history for workspace" framing, Export CSV action
 * mode="studio" → "All runs across all apps" framing, no secondary action
 */

import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../AppIcon';
import { formatTime } from '../../lib/time';
import type { MeRunSummary, RunStatus, StudioActivityRun } from '../../lib/types';

// ── Stat card ────────────────────────────────────────────────────────

interface StatCardData {
  label: string;
  value: string;
  sub?: string;
}

// ── Run row (unified shape for run + studio) ─────────────────────────

export interface RunsListRow {
  id: string;
  appSlug: string | null;
  appName: string;
  /** Main content line: app · snippet */
  body: string;
  /** Surface label: "Claude", "web", "mcp", "cli", etc. */
  surface: string;
  /** Duration string (e.g. "1.8s") */
  duration: string;
  /** Timestamp string */
  when: string;
  /** Whether this run failed */
  failed: boolean;
  /** href for the detail page */
  href: string;
  status: RunStatus;
}

// ── Top-level props ──────────────────────────────────────────────────

export interface RunsListProps {
  mode: 'run' | 'studio';
  /** Page heading */
  heading: string;
  /** Supporting subtitle */
  subtitle: string;
  /** Optional secondary action in page-head (e.g. Export CSV) */
  secondaryAction?: React.ReactNode;
  /** 4 hero stat cards */
  stats: [StatCardData, StatCardData, StatCardData, StatCardData];
  /** Filter chips */
  filters?: Array<{ label: string; active?: boolean }>;
  /** Run rows to display */
  runs: RunsListRow[] | null;
  /** Total count (for "Showing N of X") */
  totalCount?: number;
  /** Whether more items can be loaded */
  hasMore?: boolean;
  /** Called when user clicks "Load more" */
  onLoadMore?: () => void;
  /** Loading state */
  loading?: boolean;
  /** Error string */
  error?: string | null;
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
  table: {
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 14,
    overflow: 'hidden',
    boxShadow: 'var(--shadow-1)',
    marginBottom: 14,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '36px minmax(0,1fr) 88px 96px auto',
    gap: 14,
    alignItems: 'center',
    padding: '12px 18px',
    borderTop: '1px solid var(--line)',
    textDecoration: 'none',
    color: 'inherit',
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
  body: {
    minWidth: 0,
  },
  nm: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--ink)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  meta: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10.5,
    color: 'var(--muted)',
    marginTop: 2,
  },
  via: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10.5,
    color: 'var(--muted)',
  },
  dur: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10.5,
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
    border: '1px solid var(--accent-border)',
    borderRadius: 999,
    padding: '2px 9px',
    fontWeight: 600,
    textAlign: 'center' as const,
    whiteSpace: 'nowrap' as const,
  },
  durFail: {
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 10.5,
    color: '#fff',
    background: 'var(--danger)',
    border: '1px solid var(--danger)',
    borderRadius: 999,
    padding: '2px 9px',
    fontWeight: 600,
    textAlign: 'center' as const,
    whiteSpace: 'nowrap' as const,
  },
  open: {
    fontSize: 11.5,
    color: 'var(--accent)',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
  },
  pagination: {
    textAlign: 'center' as const,
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11.5,
    color: 'var(--muted)',
  },
  paginationLink: {
    color: 'var(--accent)',
    fontWeight: 600,
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11.5,
    padding: 0,
  },
  loading: {
    padding: 18,
    fontSize: 13.5,
    color: 'var(--muted)',
  },
  error: {
    padding: '14px 16px',
    borderRadius: 16,
    border: '1px solid #f4b7b1',
    background: '#fdecea',
    color: '#5c2d26',
    fontSize: 13.5,
    lineHeight: 1.6,
    marginBottom: 16,
  },
  empty: {
    padding: '24px 18px',
    borderRadius: 18,
    border: '1px dashed var(--line)',
    background: 'var(--bg)',
    color: 'var(--muted)',
    fontSize: 13,
    marginBottom: 14,
  },
};

// ── Component ────────────────────────────────────────────────────────

export function RunsList({
  mode,
  heading,
  subtitle,
  secondaryAction,
  stats,
  filters = [],
  runs,
  totalCount,
  hasMore,
  onLoadMore,
  loading = false,
  error = null,
}: RunsListProps) {
  const visibleCount = runs?.length ?? 0;

  return (
    <div data-testid={`workspace-runs-${mode}`} style={s.content}>

      {/* 1. page-head */}
      <div style={s.head}>
        <div>
          <h1 style={s.h1}>{heading}</h1>
          <p style={s.subtitle}>{subtitle}</p>
        </div>
        {secondaryAction ? <div>{secondaryAction}</div> : null}
      </div>

      {/* 2. hero stat row */}
      <div style={s.heroRow} data-testid="workspace-runs-stats">
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
        </div>
      )}

      {/* error */}
      {error ? <div style={s.error}>{error}</div> : null}

      {/* 4. runs table */}
      {loading ? (
        <div style={s.loading}>Loading runs…</div>
      ) : runs && runs.length > 0 ? (
        <div
          style={s.table}
          aria-label="Workspace run history"
          data-testid="workspace-runs-table"
        >
          {runs.map((run, i) => (
            <RunRow key={run.id} row={run} isFirst={i === 0} />
          ))}
        </div>
      ) : runs && runs.length === 0 ? (
        <div style={s.empty} data-testid="workspace-runs-empty">
          {mode === 'run' ? "You haven't run anything yet." : 'Nothing here yet.'}
        </div>
      ) : null}

      {/* 5. pagination strip */}
      {runs && runs.length > 0 && (
        <div style={s.pagination} data-testid="workspace-runs-pagination">
          {totalCount != null
            ? `Showing ${visibleCount} of ${totalCount.toLocaleString()} · `
            : null}
          {hasMore && onLoadMore ? (
            <button
              type="button"
              style={s.paginationLink}
              onClick={onLoadMore}
              data-testid="workspace-runs-load-more"
            >
              Load 30 more →
            </button>
          ) : null}
        </div>
      )}

    </div>
  );
}

// ── RunRow sub-component ─────────────────────────────────────────────

function RunRow({ row, isFirst }: { row: RunsListRow; isFirst: boolean }) {
  return (
    <Link
      to={row.href}
      data-testid={`workspace-run-row-${row.id}`}
      style={{ ...s.row, borderTop: isFirst ? 'none' : s.row.borderTop }}
    >
      <span style={s.iconWrap} aria-hidden="true">
        {row.appSlug ? (
          <AppIcon slug={row.appSlug} size={16} />
        ) : (
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>•</span>
        )}
      </span>
      <div style={s.body}>
        <div style={s.nm}>{row.body}</div>
        <div style={s.meta}>{row.when} · via {row.surface}</div>
      </div>
      <span style={s.via}>{row.surface}</span>
      <span style={row.failed ? s.durFail : s.dur}>{row.duration}</span>
      <span style={s.open}>Open →</span>
    </Link>
  );
}

// ── Convenience helpers for callers ──────────────────────────────────

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function deriveSource(_run: MeRunSummary): string {
  // No surface info in MeRunSummary; fall back to generic label
  return 'floom.dev';
}

/** Convert MeRunSummary[] → RunsListRow[] for Run mode (/run/runs) */
export function runListRowsFromMeRuns(runs: MeRunSummary[]): RunsListRow[] {
  return runs.map((run) => ({
    id: run.id,
    appSlug: run.app_slug,
    appName: run.app_name || run.app_slug || 'App',
    body: [run.app_name || run.app_slug, run.action].filter(Boolean).join(' · '),
    surface: deriveSource(run),
    duration: formatDuration(run.duration_ms),
    when: formatTime(run.started_at),
    failed: run.status === 'error' || run.status === 'timeout',
    href: `/run/runs/${encodeURIComponent(run.id)}`,
    status: run.status,
  }));
}

/** Convert StudioActivityRun[] → RunsListRow[] for Studio mode (/studio/runs) */
export function runListRowsFromStudioActivity(runs: StudioActivityRun[]): RunsListRow[] {
  return runs.map((run) => ({
    id: run.id,
    appSlug: run.app_slug,
    appName: run.app_name,
    body: [run.app_name, run.action].filter(Boolean).join(' · '),
    surface: run.source_label,
    duration: formatDuration(run.duration_ms),
    when: formatTime(run.started_at),
    failed: run.status === 'error' || run.status === 'timeout',
    href: `/studio/${run.app_slug}/runs`,
    status: run.status,
  }));
}
