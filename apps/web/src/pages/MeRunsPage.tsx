// v23 PR-K: /me/runs — All runs list.
//
// Design spec: https://wireframes.floom.dev/v23/me-runs.html
// Decision doc: /tmp/wireframe-react/me-runs-decision.md
//
// Key v23 changes vs v17:
//   - H1 "All runs" + count subtitle (`{n} runs across {m} apps in the last 30 days.`)
//   - Header CTA: Export CSV (client-side blob download)
//   - MeTabStrip shared with /me/apps + /me/secrets + /me/agent-keys
//   - Filter bar: status pills (All / Success / Failed) + date dropdown
//     + app dropdown + search input + sort dropdown. All client-side.
//   - Run rows: grid with `.ic / .body (.lab/.snip/.out) / .status / .dur / .ts`.
//   - Saturated DONE / FAILED status pills (white text on solid green/red).
//   - Duration pill `.dur` with `.fast` (≤1000ms + success) and `.fail`
//     variants.
//   - Mobile: H1 + chip-strip filter row + search + compact `.m-list-item`.
//
// Federico locks observed:
//   - NO category tints on row icon backgrounds (single neutral palette).
//     The wireframe shows mint/amber/sky tinted icons; we use --bg.
//   - Friendly running state: `running` rows show a sky `RUNNING` pill, no
//     fake step counters, no terminal stream visible inline.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../components/AppIcon';
import { MeLayout } from '../components/me/MeLayout';
import { MeTabStrip } from '../components/me/MeTabStrip';
import {
  formatDuration,
  runOutputSummary,
  runSnippetText,
} from '../components/me/runPreview';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { MeRunSummary, RunStatus } from '../lib/types';

const INITIAL_LIMIT = 25;
const LOAD_STEP = 25;
const FETCH_LIMIT = 200;

type StatusFilter = 'all' | 'success' | 'failed';
type DateFilter = '7d' | '30d' | 'all';
type SortOrder = 'newest' | 'oldest';

const s: Record<string, CSSProperties> = {
  head: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 18,
    flexWrap: 'wrap',
    marginBottom: 24,
  },
  h1: {
    fontFamily: 'var(--font-display)',
    fontSize: 38,
    fontWeight: 800,
    letterSpacing: '-0.02em',
    lineHeight: 1.05,
    margin: '0 0 6px',
    color: 'var(--ink)',
  },
  h1Mobile: {
    fontSize: 30,
    margin: '0 0 6px',
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--muted)',
    margin: 0,
    lineHeight: 1.55,
  },
  exportBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    background: 'var(--card)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    textDecoration: 'none',
    cursor: 'pointer',
  },
  emptyCard: {
    border: '1px solid var(--line)',
    borderRadius: 24,
    background:
      'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,248,243,0.94) 100%)',
    padding: '40px 28px',
    textAlign: 'center' as const,
  },
  emptyTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 24,
    fontWeight: 800,
    letterSpacing: '-0.04em',
    lineHeight: 1.1,
    color: 'var(--ink)',
    margin: '0 0 10px',
  },
  emptyBody: {
    margin: '0 auto 22px',
    maxWidth: 420,
    fontSize: 15,
    lineHeight: 1.65,
    color: 'var(--muted)',
  },
  primaryCta: {
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
  },
  errorCard: {
    border: '1px solid var(--danger-border)',
    borderRadius: 14,
    background: 'var(--danger-soft)',
    padding: '16px 20px',
    color: 'var(--ink)',
    fontSize: 13.5,
    lineHeight: 1.6,
  },
};

export function MeRunsPage() {
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_LIMIT);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('30d');
  const [appFilter, setAppFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');

  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;
  const sessionPending = sessionLoading || (session === null && !sessionError);

  useEffect(() => {
    if (sessionPending) return;
    if (signedOutPreview) {
      setRuns([]);
      return;
    }

    let cancelled = false;
    api
      .getMyRuns(FETCH_LIMIT)
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch((err) => {
        if (!cancelled) setRunsError((err as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionPending, signedOutPreview]);

  // Distinct apps from the loaded runs (used by the app dropdown).
  const distinctApps = useMemo(() => {
    if (!runs) return [];
    const seen = new Map<string, string>();
    for (const run of runs) {
      if (!run.app_slug) continue;
      if (!seen.has(run.app_slug)) {
        seen.set(run.app_slug, run.app_name || run.app_slug);
      }
    }
    return Array.from(seen.entries()).map(([slug, name]) => ({ slug, name }));
  }, [runs]);

  // Status counts on the current dataset (always reflect total pre-filter
  // so the "All 142 / Success 134 / Failed 8" pills don't shift as the
  // user toggles filters).
  const statusCounts = useMemo(() => {
    if (!runs) return { all: 0, success: 0, failed: 0 };
    let success = 0;
    let failed = 0;
    for (const run of runs) {
      if (run.status === 'success') success += 1;
      if (run.status === 'error' || run.status === 'timeout') failed += 1;
    }
    return { all: runs.length, success, failed };
  }, [runs]);

  // Filtered + sorted runs
  const filteredRuns = useMemo(() => {
    if (!runs) return [];
    const cutoffMs =
      dateFilter === '7d'
        ? Date.now() - 7 * 24 * 60 * 60 * 1000
        : dateFilter === '30d'
          ? Date.now() - 30 * 24 * 60 * 60 * 1000
          : 0;
    const q = searchQuery.trim().toLowerCase();
    const result = runs.filter((run) => {
      if (statusFilter === 'success' && run.status !== 'success') return false;
      if (
        statusFilter === 'failed' &&
        run.status !== 'error' &&
        run.status !== 'timeout'
      )
        return false;
      if (cutoffMs > 0) {
        const t = new Date(run.started_at).getTime();
        if (Number.isFinite(t) && t < cutoffMs) return false;
      }
      if (appFilter !== 'all' && run.app_slug !== appFilter) return false;
      if (q) {
        const hay = [
          run.app_slug || '',
          run.app_name || '',
          run.action || '',
          runSnippetText(run),
          runOutputSummary(run) || '',
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sortOrder === 'oldest') {
      result.sort(
        (a, b) =>
          new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
      );
    } else {
      result.sort(
        (a, b) =>
          new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
      );
    }
    return result;
  }, [runs, statusFilter, dateFilter, appFilter, searchQuery, sortOrder]);

  // Reset visibleCount when filters change so the user always sees the
  // top of the filtered set.
  useEffect(() => {
    setVisibleCount(INITIAL_LIMIT);
  }, [statusFilter, dateFilter, appFilter, searchQuery, sortOrder]);

  const visibleRuns = useMemo(
    () => filteredRuns.slice(0, visibleCount),
    [filteredRuns, visibleCount],
  );
  const hasMore = filteredRuns.length > visibleCount;

  const totalRuns = runs?.length ?? 0;
  const distinctAppCount = distinctApps.length;
  const subtitleText =
    totalRuns === 0
      ? 'Everything you’ve run on Floom shows up here.'
      : `${totalRuns} run${totalRuns === 1 ? '' : 's'} across ${distinctAppCount} app${distinctAppCount === 1 ? '' : 's'} in the last 30 days.`;

  function handleExportCsv() {
    if (!runs || runs.length === 0) return;
    const rows = [
      ['id', 'app_slug', 'action', 'status', 'duration_ms', 'started_at', 'error'],
      ...runs.map((run) => [
        run.id,
        run.app_slug ?? '',
        run.action ?? '',
        run.status,
        run.duration_ms == null ? '' : String(run.duration_ms),
        run.started_at,
        run.error ?? '',
      ]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((cell) => {
            const str = String(cell ?? '');
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          })
          .join(','),
      )
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `floom-runs-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <MeLayout
      activeTab="runs"
      title="All runs · Me · Floom"
      headerVariant="none"
      allowSignedOutShell={signedOutPreview}
    >
      <div data-testid="me-runs-page">
        <header style={s.head}>
          <div>
            <h1 style={s.h1}>All runs</h1>
            <p style={s.subtitle} data-testid="me-runs-subtitle">
              {subtitleText}
            </p>
          </div>
          <button
            type="button"
            data-testid="me-runs-export-csv"
            className="btn btn-secondary btn-sm"
            style={s.exportBtn}
            onClick={handleExportCsv}
            disabled={!runs || runs.length === 0}
          >
            Export CSV
          </button>
        </header>

        <MeTabStrip
          active="runs"
          counts={{
            apps: distinctAppCount || undefined,
            runs: totalRuns || undefined,
          }}
        />

        {runs !== null && runs.length > 0 ? (
          <FilterBar
            statusCounts={statusCounts}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            dateFilter={dateFilter}
            onDateFilter={setDateFilter}
            appFilter={appFilter}
            onAppFilter={setAppFilter}
            apps={distinctApps}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortOrder={sortOrder}
            onSortChange={setSortOrder}
          />
        ) : null}

        {runs === null && !runsError ? (
          <div
            data-testid="me-runs-loading"
            style={{
              border: '1px solid var(--line)',
              borderRadius: 14,
              background: 'var(--card)',
              padding: 18,
              color: 'var(--muted)',
              fontSize: 13.5,
            }}
          >
            Loading runs…
          </div>
        ) : runsError ? (
          <section data-testid="me-runs-error" style={s.errorCard}>
            <strong style={{ color: 'var(--danger)' }}>Couldn’t load runs.</strong>{' '}
            {runsError}
          </section>
        ) : runs && runs.length === 0 ? (
          <EmptyRuns signedOutPreview={signedOutPreview} />
        ) : visibleRuns.length === 0 ? (
          <NoMatches onClear={() => {
            setStatusFilter('all');
            setDateFilter('30d');
            setAppFilter('all');
            setSearchQuery('');
          }} />
        ) : (
          <>
            <div data-testid="me-runs-list" className="mr-runs-list">
              {visibleRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
            <div
              className="mr-foot"
              data-testid="me-runs-foot"
            >
              <span>
                Showing {visibleRuns.length} of {filteredRuns.length}
              </span>
              {hasMore ? (
                <button
                  type="button"
                  data-testid="me-load-more"
                  onClick={() => setVisibleCount((count) => count + LOAD_STEP)}
                >
                  Load more
                </button>
              ) : (
                <Link to="/me">Back to /me →</Link>
              )}
            </div>
            <button
              type="button"
              className="mr-export-cta"
              data-testid="me-runs-export-csv-mobile"
              onClick={handleExportCsv}
              disabled={!runs || runs.length === 0}
              style={{ display: 'none' }}
            >
              Export CSV
            </button>
            <style>{`@media (max-width:640px){[data-testid="me-runs-export-csv-mobile"]{display:inline-flex !important}[data-testid="me-runs-export-csv"]{display:none !important}}`}</style>
          </>
        )}
      </div>
    </MeLayout>
  );
}

function FilterBar({
  statusCounts,
  statusFilter,
  onStatusFilter,
  dateFilter,
  onDateFilter,
  appFilter,
  onAppFilter,
  apps,
  searchQuery,
  onSearchChange,
  sortOrder,
  onSortChange,
}: {
  statusCounts: { all: number; success: number; failed: number };
  statusFilter: StatusFilter;
  onStatusFilter: (s: StatusFilter) => void;
  dateFilter: DateFilter;
  onDateFilter: (d: DateFilter) => void;
  appFilter: string;
  onAppFilter: (a: string) => void;
  apps: Array<{ slug: string; name: string }>;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sortOrder: SortOrder;
  onSortChange: (s: SortOrder) => void;
}) {
  return (
    <>
      {/* Desktop / tablet filter bar */}
      <div
        className="mr-filter-bar"
        data-testid="me-runs-filter-bar"
        data-bp="desktop"
      >
        <div className="mr-filter-pills">
          <button
            type="button"
            className={`mr-filter-pill ${statusFilter === 'all' ? 'on' : ''}`}
            onClick={() => onStatusFilter('all')}
            data-testid="me-runs-filter-all"
          >
            All <span className="ct">{statusCounts.all}</span>
          </button>
          <button
            type="button"
            className={`mr-filter-pill ${statusFilter === 'success' ? 'on' : ''}`}
            onClick={() => onStatusFilter('success')}
            data-testid="me-runs-filter-success"
          >
            <span className="dot dot-live" /> Success{' '}
            <span className="ct">{statusCounts.success}</span>
          </button>
          <button
            type="button"
            className={`mr-filter-pill ${statusFilter === 'failed' ? 'on' : ''}`}
            onClick={() => onStatusFilter('failed')}
            data-testid="me-runs-filter-failed"
          >
            <span className="dot dot-fail" /> Failed{' '}
            <span className="ct">{statusCounts.failed}</span>
          </button>
          <select
            className="mr-filter-select"
            value={dateFilter}
            onChange={(e) => onDateFilter(e.target.value as DateFilter)}
            data-testid="me-runs-filter-date"
            aria-label="Date range"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
          <select
            className="mr-filter-select"
            value={appFilter}
            onChange={(e) => onAppFilter(e.target.value)}
            data-testid="me-runs-filter-app"
            aria-label="App"
          >
            <option value="all">All apps</option>
            {apps.map((app) => (
              <option key={app.slug} value={app.slug}>
                {app.name}
              </option>
            ))}
          </select>
        </div>
        <div className="mr-filter-right">
          <div className="mr-search-wrap">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{ color: 'var(--muted)' }}
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              placeholder="Search runs…"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              data-testid="me-runs-search"
            />
          </div>
          <select
            className="mr-filter-select"
            value={sortOrder}
            onChange={(e) => onSortChange(e.target.value as SortOrder)}
            data-testid="me-runs-sort"
            aria-label="Sort order"
          >
            <option value="newest">Sort: Newest</option>
            <option value="oldest">Sort: Oldest</option>
          </select>
        </div>
      </div>
      {/* Mobile chip strip — shown only ≤640w via the inline media-query stylesheet below */}
      <div
        className="mr-mobile-chips"
        data-testid="me-runs-filter-chips"
        data-bp="mobile"
        style={{ display: 'none', marginBottom: 12 }}
      >
        <button
          type="button"
          className={`mr-tag-chip ${statusFilter === 'all' ? 'on' : ''}`}
          onClick={() => onStatusFilter('all')}
        >
          All · {statusCounts.all}
        </button>
        <button
          type="button"
          className={`mr-tag-chip ${statusFilter === 'success' ? 'on' : ''}`}
          onClick={() => onStatusFilter('success')}
        >
          <span className="dot dot-live" /> Done · {statusCounts.success}
        </button>
        <button
          type="button"
          className={`mr-tag-chip ${statusFilter === 'failed' ? 'on' : ''}`}
          onClick={() => onStatusFilter('failed')}
        >
          <span className="dot dot-fail" /> Failed · {statusCounts.failed}
        </button>
        <select
          className="mr-tag-chip"
          value={dateFilter}
          onChange={(e) => onDateFilter(e.target.value as DateFilter)}
          aria-label="Date range"
        >
          <option value="7d">Last 7d</option>
          <option value="30d">Last 30d</option>
          <option value="all">All time</option>
        </select>
        <select
          className="mr-tag-chip"
          value={appFilter}
          onChange={(e) => onAppFilter(e.target.value)}
          aria-label="App"
        >
          <option value="all">All apps</option>
          {apps.map((app) => (
            <option key={app.slug} value={app.slug}>
              {app.name}
            </option>
          ))}
        </select>
      </div>
      <div
        className="mr-search-wrap"
        data-bp="mobile"
        style={{
          display: 'none',
          marginBottom: 16,
          background: 'var(--card)',
          minWidth: 0,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ color: 'var(--muted)' }}
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="search"
          placeholder="Search runs…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      <style>{`
        @media (max-width: 640px) {
          [data-testid="me-runs-filter-bar"][data-bp="desktop"] { display: none !important; }
          [data-bp="mobile"] { display: flex !important; }
        }
      `}</style>
    </>
  );
}

function RunRow({ run }: { run: MeRunSummary }) {
  const slug = run.app_slug;
  const action = run.action && run.action !== 'run' ? run.action : null;
  const lab = slug ? (action ? `${slug} · ${action}` : slug) : action || 'run';
  const snip = runSnippetText(run);
  const out = runOutputSummary(run);
  const isFailed = run.status === 'error' || run.status === 'timeout';

  // Duration pill variant
  let durClass = 'dur';
  if (isFailed) durClass = 'dur fail';
  else if (
    run.status === 'success' &&
    run.duration_ms != null &&
    run.duration_ms < 1000
  )
    durClass = 'dur fast';

  return (
    <Link
      to={`/me/runs/${encodeURIComponent(run.id)}`}
      data-testid={`me-run-row-${run.id}`}
      className="mr-row"
    >
      <span className="ic" aria-hidden>
        {slug ? (
          <AppIcon slug={slug} size={20} />
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 14, fontWeight: 700 }}>·</span>
        )}
      </span>
      <div className="body">
        <div className="lab">{lab}</div>
        <div className="snip">{snip}</div>
        {out ? (
          <div
            className="out"
            style={isFailed ? { color: 'var(--danger)' } : undefined}
          >
            {out}
          </div>
        ) : null}
      </div>
      <div className="status-cell">
        <StatusPill status={run.status} />
      </div>
      <span className={durClass}>{formatDuration(run.duration_ms)}</span>
      <span className="ts">{formatTime(run.started_at)}</span>
    </Link>
  );
}

export function StatusPill({ status }: { status: RunStatus }) {
  if (status === 'success') {
    return (
      <span
        className="floom-status floom-status-live"
        aria-label="Status: success"
      >
        DONE
      </span>
    );
  }
  if (status === 'error' || status === 'timeout') {
    return (
      <span
        className="floom-status floom-status-fail"
        aria-label={`Status: ${status}`}
      >
        FAILED
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span
        className="floom-status floom-status-running"
        aria-label="Status: running"
      >
        RUNNING
      </span>
    );
  }
  return (
    <span
      className="floom-status floom-status-muted"
      aria-label={`Status: ${status}`}
    >
      {status === 'pending' ? 'QUEUED' : String(status).toUpperCase()}
    </span>
  );
}

function EmptyRuns({ signedOutPreview = false }: { signedOutPreview?: boolean }) {
  return (
    <section data-testid="me-runs-empty" style={s.emptyCard}>
      <h2 style={s.emptyTitle}>
        {signedOutPreview ? 'Nothing to pick up yet.' : 'You haven’t run anything yet.'}
      </h2>
      <p style={s.emptyBody}>
        {signedOutPreview
          ? 'Browse the store, try an app, and your history will show up here after you sign in.'
          : 'Run any app from the store and its history will show up here.'}
      </p>
      <Link to="/apps" data-testid="me-empty-browse" style={s.primaryCta}>
        Browse the store →
      </Link>
    </section>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <section
      data-testid="me-runs-no-matches"
      style={{
        border: '1px dashed var(--line)',
        borderRadius: 14,
        background: 'var(--card)',
        padding: '28px 24px',
        textAlign: 'center',
        color: 'var(--muted)',
        fontSize: 13.5,
      }}
    >
      <div style={{ marginBottom: 10 }}>
        No runs match these filters.
      </div>
      <button
        type="button"
        onClick={onClear}
        style={{
          background: 'var(--ink)',
          color: '#fff',
          border: 0,
          borderRadius: 999,
          padding: '8px 16px',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        Clear filters
      </button>
    </section>
  );
}
