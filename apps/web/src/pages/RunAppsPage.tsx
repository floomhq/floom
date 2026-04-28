// /run/apps — v26 Run-mode apps dashboard.
//
// Wireframe: /var/www/wireframes-floom/v26/run-apps.html
// Issues: #918 (stub fix), #913 (compact hero override), #928 (rebase onto main)
//
// Shell: WorkspacePageShell mode="run" (RunRail + ModeToggle per v26 §12).
// Hero: COMPACT single-line stat strip (NOT 4-card grid — issue #913).
// Grid: installed apps derived from /me/runs run history.
// Filter chips: All / Recently used / Scheduled / Drafts (URL param ?filter=).
// Recent runs: compact panel sourced from api.getMyRuns.
// Bottom CTA: Browse the app store → /apps.
//
// COEXIST strategy: v23 /me/apps (MeAppsPage) is preserved untouched.
// This file serves the NEW v26 /run/apps route. Per spec §9, /me/apps
// will redirect here in a future PR.

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { useSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
import { formatTime } from '../lib/time';
import * as api from '../api/client';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;

/** Per-app summary derived from run history. */
interface RunApp {
  slug: string;
  name: string;
  description?: string;
  runCount: number;
  lastRunAt: string | null;
  lastRunId: string;
  lastRunAction: string;
  lastRunStatus: string;
}

function deriveApps(runs: MeRunSummary[]): RunApp[] {
  const seen = new Map<string, RunApp>();
  for (const run of runs) {
    if (!run.app_slug) continue;
    const existing = seen.get(run.app_slug);
    if (existing) {
      existing.runCount += 1;
      continue;
    }
    seen.set(run.app_slug, {
      slug: run.app_slug,
      name: run.app_name || run.app_slug,
      runCount: 1,
      lastRunAt: run.started_at,
      lastRunId: run.id,
      lastRunAction: run.action,
      lastRunStatus: run.status,
    });
  }
  return Array.from(seen.values());
}

// ------------------------------------------------------------------
// Filter chips (wireframe run-apps.html lines 136–143)
// ------------------------------------------------------------------

type RunAppFilter = 'all' | 'recent' | 'scheduled' | 'drafts';

const RUN_APP_FILTER_LABELS: Record<RunAppFilter, string> = {
  all: 'All',
  recent: 'Recently used',
  scheduled: 'Scheduled',
  drafts: 'Drafts',
};

function filterApps(apps: RunApp[], filter: RunAppFilter): RunApp[] {
  if (filter === 'all') return apps;
  if (filter === 'recent') {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return apps.filter((a) => {
      if (!a.lastRunAt) return false;
      const t = new Date(a.lastRunAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  // 'scheduled' and 'drafts' require backend fields not yet in RunApp.
  // Graceful: show empty (per spec "show empty if data missing").
  return [];
}

function FilterChipBar({
  active,
  counts,
  onChange,
}: {
  active: RunAppFilter;
  counts: Record<RunAppFilter, number>;
  onChange: (f: RunAppFilter) => void;
}) {
  const filters: RunAppFilter[] = ['all', 'recent', 'scheduled', 'drafts'];
  return (
    <div
      data-testid="run-apps-filter-chips"
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        marginBottom: 16,
      }}
    >
      {filters.map((f) => {
        const isActive = f === active;
        return (
          <button
            key={f}
            type="button"
            data-testid={`run-apps-chip-${f}`}
            onClick={() => onChange(f)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              padding: '5px 11px',
              borderRadius: 999,
              background: isActive ? 'var(--accent-soft)' : 'var(--card)',
              border: `1px solid ${isActive ? 'var(--accent-border, #a7f3d0)' : 'var(--line)'}`,
              color: isActive ? 'var(--accent)' : 'var(--muted)',
              fontWeight: isActive ? 600 : 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all 0.12s ease',
            }}
          >
            {RUN_APP_FILTER_LABELS[f]}
            {f === 'all' && (
              <span style={{ opacity: 0.7 }}>{counts.all}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------
// Compact hero metric strip (issue #913: NOT a 4-card grid)
// ------------------------------------------------------------------

function CompactHeroStrip({
  appCount,
  runCount,
}: {
  appCount: number;
  runCount: number;
}) {
  // TODO: wire to real metrics endpoint when available (/api/workspace/stats)
  return (
    <div
      className="ws-compact-hero"
      data-testid="run-apps-compact-hero"
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
      <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{appCount}</span>
      <span>runnable app{appCount !== 1 ? 's' : ''}</span>
      <span aria-hidden style={{ color: 'var(--line)', userSelect: 'none' }}>·</span>
      <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{runCount}</span>
      <span>runs this week</span>
    </div>
  );
}

// ------------------------------------------------------------------
// Apps grid
// ------------------------------------------------------------------

function AppCard({ app }: { app: RunApp }) {
  const initials = app.slug.slice(0, 2).toUpperCase();
  const failed =
    app.lastRunStatus === 'error' || app.lastRunStatus === 'timeout';
  return (
    <Link
      to={`/run/apps/${app.slug}/run`}
      data-testid={`run-apps-card-${app.slug}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--muted)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <div
          aria-hidden="true"
          style={{
            width: 38,
            height: 38,
            borderRadius: 9,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            color: 'var(--ink)',
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {app.name}
          </div>
          <div
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 10.5,
              color: 'var(--muted)',
              marginTop: 2,
            }}
          >
            {app.runCount} run{app.runCount !== 1 ? 's' : ''}
            {app.lastRunAt ? ` · ${formatTime(app.lastRunAt)}` : ''}
          </div>
        </div>
      </div>

      {app.description && (
        <p
          style={{
            fontSize: 14,
            color: 'var(--ink-2, var(--muted))',
            margin: '6px 0 0',
            lineHeight: 1.5,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {app.description}
        </p>
      )}

      <div
        style={{
          fontSize: 12,
          color: failed ? '#ef4444' : 'var(--accent)',
          fontWeight: 600,
          marginTop: 'auto',
        }}
      >
        {failed ? 'Last run failed →' : 'Run again →'}
      </div>
    </Link>
  );
}

function AppsGrid({ apps }: { apps: RunApp[] }) {
  return (
    <div
      data-testid="run-apps-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 14,
        marginBottom: 18,
      }}
    >
      {apps.map((app) => (
        <AppCard key={app.slug} app={app} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------
// Recent runs panel
// ------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RecentRunsPanel({ runs }: { runs: MeRunSummary[] }) {
  const visible = runs.slice(0, 5);
  if (visible.length === 0) return null;

  return (
    <div
      data-testid="run-apps-recent-runs"
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '16px 18px 6px',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
          }}
        >
          Recent runs
        </div>
        <Link
          to="/run/runs"
          data-testid="run-apps-view-all-runs"
          style={{
            fontSize: 12.5,
            color: 'var(--muted)',
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          View all →
        </Link>
      </div>
      <div style={{ borderTop: '1px solid var(--line)', margin: '0 -18px' }}>
        {visible.map((run) => {
          const failed =
            run.status === 'error' || run.status === 'timeout';
          const dotColor = failed ? '#ef4444' : 'var(--accent)';
          const dotHalo = failed ? '#fef2f2' : 'var(--accent-soft)';
          const appLabel = run.app_name || run.app_slug || 'app';
          const dur =
            run.duration_ms != null ? formatDuration(run.duration_ms) : '—';
          return (
            <Link
              key={run.id}
              to={`/run/runs/${run.id}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '12px minmax(0,1fr) auto auto auto',
                gap: 10,
                alignItems: 'center',
                padding: '10px 18px',
                borderBottom: '1px solid var(--line)',
                fontSize: 12.5,
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: dotColor,
                  boxShadow: `0 0 0 3px ${dotHalo}`,
                  display: 'inline-block',
                }}
              />
              <div
                style={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>
                  {appLabel}
                </span>{' '}
                <span style={{ color: 'var(--muted)' }}>· {run.action}</span>
              </div>
              <span
                style={{
                  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                  color: 'var(--muted)',
                  fontSize: 11.5,
                }}
              >
                {dur}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                {formatTime(run.started_at)}
              </span>
              <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500 }}>
                View →
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Empty state
// ------------------------------------------------------------------

function EmptyState() {
  return (
    <div
      data-testid="run-apps-empty"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: '48px 24px 56px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        marginBottom: 18,
      }}
    >
      <h3
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 26,
          fontWeight: 400,
          letterSpacing: '-0.02em',
          margin: '0 0 8px',
          color: 'var(--ink)',
        }}
      >
        No apps installed yet.
      </h3>
      <p
        style={{
          fontSize: 14,
          color: 'var(--muted)',
          margin: '0 auto 20px',
          maxWidth: 440,
          lineHeight: 1.55,
        }}
      >
        Browse the store to install your first app. It will appear here —
        ready to run from your browser, Claude, Cursor, or the CLI.
      </p>
      <Link to="/apps" className="btn-ink" data-testid="run-apps-empty-cta">
        Browse the store →
      </Link>
    </div>
  );
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------

export function RunAppsPage() {
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const { apps: myApps } = useMyApps();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const sessionPending =
    sessionLoading || (session === null && !sessionError);

  // Read filter from URL param; default to 'all'
  const rawFilter = searchParams.get('filter');
  const activeFilter: RunAppFilter =
    rawFilter === 'recent' || rawFilter === 'scheduled' || rawFilter === 'drafts'
      ? rawFilter
      : 'all';

  function handleFilterChange(f: RunAppFilter) {
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
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionPending]);

  const apps = useMemo<RunApp[]>(() => {
    if (!runs) return [];
    const derived = deriveApps(runs);
    // Merge description from useMyApps (CreatorApp.description) by slug.
    const descBySlug = new Map<string, string>(
      (myApps ?? []).map((a) => [a.slug, a.description]),
    );
    return derived.map((app) => ({
      ...app,
      description: descBySlug.get(app.slug) || undefined,
    }));
  }, [runs, myApps]);

  const filteredApps = useMemo(
    () => filterApps(apps, activeFilter),
    [apps, activeFilter],
  );

  const appCount = apps.length;
  // TODO: replace with real 7-day metric from /api/workspace/stats
  const runCount = runs?.length ?? 0;

  const filterCounts: Record<RunAppFilter, number> = useMemo(
    () => ({
      all: apps.length,
      recent: filterApps(apps, 'recent').length,
      scheduled: 0,
      drafts: 0,
    }),
    [apps],
  );

  return (
    <WorkspacePageShell mode="run" title="Apps · Run · Floom">
      <div data-testid="run-apps-page">
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
              Apps
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>
              {appCount > 0
                ? `${appCount} runnable app${appCount !== 1 ? 's' : ''} in your workspace. Available in browser, Claude, Cursor, and HTTP.`
                : 'Install apps from the store to run them here.'}
            </p>
          </div>
          <Link
            to="/apps"
            data-testid="run-apps-browse-store"
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
            Browse store →
          </Link>
        </div>

        {/* Compact hero metric strip (issue #913: NOT 4-card grid) */}
        {runs !== null && (
          <CompactHeroStrip appCount={appCount} runCount={runCount} />
        )}

        {/* Filter chip toolbar (wireframe run-apps.html lines 136–143) */}
        {runs !== null && appCount > 0 && (
          <FilterChipBar
            active={activeFilter}
            counts={filterCounts}
            onChange={handleFilterChange}
          />
        )}

        {/* Apps grid */}
        {runs === null ? (
          <div
            data-testid="run-apps-loading"
            style={{ color: 'var(--muted)', padding: '32px 0', fontSize: 14 }}
          >
            Loading your apps…
          </div>
        ) : apps.length === 0 ? (
          <EmptyState />
        ) : filteredApps.length === 0 ? (
          <>
            <div
              data-testid="run-apps-filter-empty"
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                marginBottom: 12,
                padding: '10px 0',
              }}
            >
              No apps match this filter.
            </div>
            <AppsGrid apps={apps} />
          </>
        ) : (
          <AppsGrid apps={filteredApps} />
        )}

        {/* Recent runs panel */}
        {runs && runs.length > 0 && <RecentRunsPanel runs={runs} />}

        {/* Bottom CTA */}
        <div data-testid="run-apps-bottom-cta" style={{ marginTop: 4 }}>
          <Link
            to="/apps"
            style={{
              padding: '8px 16px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--muted)',
              textDecoration: 'none',
            }}
          >
            Browse the app store →
          </Link>
        </div>
      </div>
    </WorkspacePageShell>
  );
}
