// /run/runs — v26 Run-mode all runs dashboard.
//
// Wireframe: /var/www/wireframes-floom/v26/run-runs.html
//
// Shell: WorkspacePageShell mode="run" (same as RunAppsPage).
// Hero: COMPACT single-line stat strip (total/errors/P95/avg).
// Filter chips: All / Successful / Failed / Recent (client-side).
// Table: mirrors MeRunsPage column shape (app · action · status · duration · time).
// Click-through: → /run/runs/:runId detail page.
//
// Data: reuses api.getMyRuns (same endpoint as MeRunsPage) — /me/runs is
// the current canonical consumer-run list. RunRunsPage is the v26 WorkspaceShell
// surface for the same data.
//
// COEXIST: MeRunsPage at /me/runs is preserved untouched.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { AppIcon } from '../components/AppIcon';
import { useSession } from '../hooks/useSession';
import {
  formatDuration,
  runSnippetText,
  runOutputSummary,
} from '../components/me/runPreview';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;
const INITIAL_LIMIT = 25;
const LOAD_STEP = 25;

// ------------------------------------------------------------------
// Compact hero stat strip
// ------------------------------------------------------------------

function CompactHeroStrip({ runs }: { runs: MeRunSummary[] }) {
  const total = runs.length;
  const errors = runs.filter(
    (r) => r.status === 'error' || r.status === 'timeout',
  ).length;
  const durations = runs
    .map((r) => r.duration_ms)
    .filter((d): d is number => d != null)
    .sort((a, b) => a - b);
  const p95 =
    durations.length > 0
      ? durations[Math.floor(durations.length * 0.95)]
      : null;
  const avg =
    durations.length > 0
      ? durations.reduce((s, d) => s + d, 0) / durations.length
      : null;

  return (
    <div
      className="ws-compact-hero"
      data-testid="run-runs-compact-hero"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 12px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 999,
        fontSize: 12.5,
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontWeight: 500,
        color: 'var(--muted)',
        marginBottom: 18,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: 'var(--ink)', fontWeight: 700 }}>
        {total.toLocaleString()}
      </span>
      <span>total run{total !== 1 ? 's' : ''}</span>
      {errors > 0 && (
        <>
          <span aria-hidden style={{ color: 'var(--line)', userSelect: 'none' }}>·</span>
          <span style={{ color: '#ef4444', fontWeight: 700 }}>{errors}</span>
          <span>error{errors !== 1 ? 's' : ''}</span>
        </>
      )}
      {p95 != null && (
        <>
          <span aria-hidden style={{ color: 'var(--line)', userSelect: 'none' }}>·</span>
          <span style={{ color: 'var(--ink)', fontWeight: 700 }}>
            {formatDuration(p95)}
          </span>
          <span>P95</span>
        </>
      )}
      {avg != null && (
        <>
          <span aria-hidden style={{ color: 'var(--line)', userSelect: 'none' }}>·</span>
          <span style={{ color: 'var(--ink)', fontWeight: 700 }}>
            {formatDuration(avg)}
          </span>
          <span>avg</span>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Filter chips
// ------------------------------------------------------------------

type RunFilter = 'all' | 'successful' | 'failed' | 'recent';

const FILTER_LABELS: Record<RunFilter, string> = {
  all: 'All',
  successful: 'Successful',
  failed: 'Failed',
  recent: 'Recent',
};

function filterRuns(runs: MeRunSummary[], filter: RunFilter): MeRunSummary[] {
  if (filter === 'all') return runs;
  if (filter === 'successful') {
    return runs.filter((r) => r.status === 'success');
  }
  if (filter === 'failed') {
    return runs.filter(
      (r) => r.status === 'error' || r.status === 'timeout',
    );
  }
  if (filter === 'recent') {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last 24h
    return runs.filter((r) => {
      const t = new Date(r.started_at).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  return runs;
}

function FilterChipBar({
  active,
  runs,
  onChange,
}: {
  active: RunFilter;
  runs: MeRunSummary[];
  onChange: (f: RunFilter) => void;
}) {
  const filters: RunFilter[] = ['all', 'successful', 'failed', 'recent'];
  const counts: Record<RunFilter, number> = useMemo(
    () => ({
      all: runs.length,
      successful: filterRuns(runs, 'successful').length,
      failed: filterRuns(runs, 'failed').length,
      recent: filterRuns(runs, 'recent').length,
    }),
    [runs],
  );

  return (
    <div
      data-testid="run-runs-filter-chips"
      style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}
    >
      {filters.map((f) => {
        const isOn = f === active;
        return (
          <button
            key={f}
            type="button"
            data-testid={`run-runs-chip-${f}`}
            onClick={() => onChange(f)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              padding: '5px 11px',
              borderRadius: 999,
              background: isOn ? 'var(--accent-soft)' : 'var(--card)',
              border: `1px solid ${isOn ? 'var(--accent-border, #a7f3d0)' : 'var(--line)'}`,
              color: isOn ? 'var(--accent)' : 'var(--muted)',
              fontWeight: isOn ? 600 : 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.12s ease',
            }}
          >
            {FILTER_LABELS[f]}
            <span style={{ opacity: 0.7 }}>{counts[f]}</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------
// Run row
// ------------------------------------------------------------------

function RunRow({ run }: { run: MeRunSummary }) {
  const slug = run.app_slug;
  const action = run.action && run.action !== 'run' ? run.action : null;
  const lab = slug ? (action ? `${slug} · ${action}` : slug) : action || 'run';
  const snip = runSnippetText(run);
  const out = runOutputSummary(run);
  const isFailed = run.status === 'error' || run.status === 'timeout';
  const isRunning = run.status === 'running';

  return (
    <Link
      to={`/run/runs/${encodeURIComponent(run.id)}`}
      data-testid={`run-runs-row-${run.id}`}
      style={{
        display: 'grid',
        gridTemplateColumns: '36px minmax(0,1fr) 90px 100px auto',
        gap: 14,
        alignItems: 'center',
        padding: '12px 18px',
        borderTop: '1px solid var(--line)',
        textDecoration: 'none',
        color: 'inherit',
        transition: 'background 0.1s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Icon */}
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          border: '1px solid var(--line)',
          background: 'var(--bg)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        aria-hidden
      >
        {slug ? (
          <AppIcon slug={slug} size={18} />
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 14, fontWeight: 700 }}>·</span>
        )}
      </span>

      {/* Body */}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {lab}
        </div>
        {snip && (
          <div
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 10.5,
              color: 'var(--muted)',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {snip}
          </div>
        )}
        {out && (
          <div
            style={{
              fontSize: 11,
              color: isFailed ? 'var(--danger, #ef4444)' : 'var(--muted)',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {out}
          </div>
        )}
      </div>

      {/* Status pill */}
      <span>
        {isFailed ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              background: 'var(--danger, #ef4444)',
              color: '#fff',
            }}
          >
            FAILED
          </span>
        ) : isRunning ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              background: '#0ea5e9',
              color: '#fff',
            }}
          >
            RUNNING
          </span>
        ) : run.status === 'success' ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              background: 'var(--accent)',
              color: '#fff',
            }}
          >
            DONE
          </span>
        ) : (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              color: 'var(--muted)',
            }}
          >
            {run.status.toUpperCase()}
          </span>
        )}
      </span>

      {/* Duration */}
      <span
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 10.5,
          color: isFailed ? 'var(--danger, #ef4444)' : 'var(--accent)',
          background: isFailed ? 'var(--danger-soft, #fef2f2)' : 'var(--accent-soft)',
          border: `1px solid ${isFailed ? '#fca5a5' : 'var(--accent-border, #a7f3d0)'}`,
          borderRadius: 999,
          padding: '2px 9px',
          fontWeight: 600,
          textAlign: 'center',
          whiteSpace: 'nowrap',
        }}
      >
        {formatDuration(run.duration_ms)}
      </span>

      {/* Timestamp */}
      <span
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 10.5,
          color: 'var(--muted)',
          whiteSpace: 'nowrap',
        }}
      >
        {formatTime(run.started_at)}
      </span>
    </Link>
  );
}

// ------------------------------------------------------------------
// Empty state
// ------------------------------------------------------------------

function EmptyRuns() {
  return (
    <div
      data-testid="run-runs-empty"
      style={{
        border: '1px solid var(--line)',
        borderRadius: 24,
        background: 'var(--card)',
        padding: '40px 28px',
        textAlign: 'center',
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
        No runs yet.
      </h2>
      <p
        style={{
          margin: '0 auto 22px',
          maxWidth: 420,
          fontSize: 15,
          lineHeight: 1.65,
          color: 'var(--muted)',
        }}
      >
        Run any app from the store and its history will show up here.
      </p>
      <Link
        to="/apps"
        data-testid="run-runs-empty-cta"
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
    </div>
  );
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------

export function RunRunsPage() {
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_LIMIT);
  const [searchParams, setSearchParams] = useSearchParams();

  const sessionPending = sessionLoading || (session === null && !sessionError);

  // Filter from URL param
  const rawFilter = searchParams.get('filter');
  const activeFilter: RunFilter =
    rawFilter === 'successful' || rawFilter === 'failed' || rawFilter === 'recent'
      ? rawFilter
      : 'all';

  function handleFilterChange(f: RunFilter) {
    setVisibleCount(INITIAL_LIMIT);
    if (f === 'all') {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('filter');
        return next;
      }, { replace: true });
    } else {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('filter', f);
        return next;
      }, { replace: true });
    }
  }

  useEffect(() => {
    if (sessionPending) return;
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
  }, [sessionPending]);

  const filteredRuns = useMemo(
    () => (runs ? filterRuns(runs, activeFilter) : []),
    [runs, activeFilter],
  );

  const visibleRuns = useMemo(
    () => filteredRuns.slice(0, visibleCount),
    [filteredRuns, visibleCount],
  );

  const hasMore = filteredRuns.length > visibleCount;
  const totalRuns = runs?.length ?? 0;

  return (
    <WorkspacePageShell mode="run" title="Runs · Run · Floom">
      <div data-testid="run-runs-page">
        {/* Page head */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 18,
            flexWrap: 'wrap',
            marginBottom: 10,
          }}
        >
          <div>
            <h1
              style={{
                fontWeight: 800,
                fontSize: 28,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                margin: '0 0 5px',
                color: 'var(--ink)',
              }}
            >
              Runs
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>
              {totalRuns > 0
                ? `${totalRuns} run${totalRuns !== 1 ? 's' : ''} across your apps.`
                : 'Everything you run on Floom shows up here.'}
            </p>
          </div>
          <Link
            to="/run/apps"
            data-testid="run-runs-back-apps"
            style={{
              padding: '8px 14px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--muted)',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            ← Back to Apps
          </Link>
        </div>

        {/* Compact hero stat strip */}
        {runs !== null && runs.length > 0 && (
          <CompactHeroStrip runs={runs} />
        )}

        {/* Filter chips */}
        {runs !== null && runs.length > 0 && (
          <FilterChipBar
            active={activeFilter}
            runs={runs}
            onChange={handleFilterChange}
          />
        )}

        {/* Loading / error / empty / list */}
        {runs === null && !runsError ? (
          <div
            data-testid="run-runs-loading"
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
          <section
            data-testid="run-runs-error"
            style={{
              padding: '14px 16px',
              borderRadius: 14,
              border: '1px solid #f4b7b1',
              background: '#fdecea',
              color: '#5c2d26',
              fontSize: 13.5,
              lineHeight: 1.6,
            }}
          >
            <strong style={{ color: '#b42318' }}>Couldn't load runs.</strong>{' '}
            {runsError}
          </section>
        ) : runs && runs.length === 0 ? (
          <EmptyRuns />
        ) : filteredRuns.length === 0 ? (
          <div
            data-testid="run-runs-filter-empty"
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
            No runs match this filter.
          </div>
        ) : (
          <>
            <div
              data-testid="run-runs-list"
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                overflow: 'hidden',
                marginBottom: 14,
              }}
            >
              {visibleRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
            <div
              data-testid="run-runs-foot"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 12,
                color: 'var(--muted)',
                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                marginBottom: 16,
              }}
            >
              <span>
                Showing {visibleRuns.length} of {filteredRuns.length}
              </span>
              {hasMore ? (
                <button
                  type="button"
                  data-testid="run-runs-load-more"
                  onClick={() => setVisibleCount((c) => c + LOAD_STEP)}
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    borderRadius: 999,
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--ink)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Load more
                </button>
              ) : (
                <Link
                  to="/run/apps"
                  style={{ color: 'var(--muted)', textDecoration: 'none', fontWeight: 500 }}
                >
                  Back to apps →
                </Link>
              )}
            </div>
          </>
        )}
      </div>
    </WorkspacePageShell>
  );
}
