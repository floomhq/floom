// /studio/runs — v26 Studio runs dashboard.
//
// Wireframe: /var/www/wireframes-floom/v26/studio-runs.html
//
// Shell: WorkspacePageShell mode="studio" (was StudioLayout — migrated for
// v26 structural DRY per wireframe spec "run/studio pages share identical shell").
// Hero: COMPACT single-line stat strip (matches RunAppsPage/RunRunsPage pattern,
// NOT 4-card grid — issue #913).
// Filter chips: All apps / Failed only (per wireframe toolbar).
// Table: preserves existing StudioActivityRun data shape + functionality.
//
// Data: api.getStudioActivity (unchanged — only shell + filter layer added).

import { useEffect, useState, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { StudioSignedOutState } from '../components/studio/StudioSignedOutState';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { StudioActivityRun } from '../lib/types';
import { formatTime } from '../lib/time';
import { AppIcon } from '../components/AppIcon';

// ------------------------------------------------------------------
// Compact hero stat strip
// ------------------------------------------------------------------

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function CompactHeroStrip({ runs }: { runs: StudioActivityRun[] }) {
  const total = runs.length;
  const failed = runs.filter(
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

  return (
    <div
      className="ws-compact-hero"
      data-testid="studio-runs-compact-hero"
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
      {failed > 0 && (
        <>
          <span aria-hidden style={{ color: 'var(--line)', userSelect: 'none' }}>·</span>
          <span style={{ color: '#ef4444', fontWeight: 700 }}>{failed}</span>
          <span>error{failed !== 1 ? 's' : ''}</span>
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
    </div>
  );
}

// ------------------------------------------------------------------
// Filter chips
// ------------------------------------------------------------------

type RunsFilter = 'all' | 'failed';

function FilterChipBar({
  active,
  totalCount,
  failedCount,
  onChange,
}: {
  active: RunsFilter;
  totalCount: number;
  failedCount: number;
  onChange: (f: RunsFilter) => void;
}) {
  return (
    <div
      data-testid="studio-runs-filter-chips"
      style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}
    >
      {(['all', 'failed'] as RunsFilter[]).map((f) => {
        const isOn = f === active;
        const label =
          f === 'all'
            ? `All apps`
            : 'Failed only';
        const count = f === 'all' ? totalCount : failedCount;
        return (
          <button
            key={f}
            type="button"
            data-testid={`studio-runs-chip-${f}`}
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
            {label}
            <span style={{ opacity: 0.7 }}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------
// Runs table (preserves existing column shape from old StudioRunsPage)
// ------------------------------------------------------------------

function RunsTable({ runs }: { runs: StudioActivityRun[] }) {
  return (
    <div data-testid="studio-runs-list" style={listStyle}>
      {runs.map((run, index) => (
        <div
          key={run.id}
          style={{
            ...rowStyle,
            borderBottom: index === runs.length - 1 ? 'none' : rowStyle.borderBottom,
          }}
        >
          <span style={iconWrapStyle}>
            <AppIcon slug={run.app_slug} size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={rowTitleStyle}>
              <span style={strongStyle}>{run.user_label}</span> ran{' '}
              <Link to={`/studio/${run.app_slug}`} style={appLinkStyle}>
                {run.app_name}
              </Link>{' '}
              from <span style={{ color: 'var(--muted)' }}>{run.source_label}</span>
            </div>
            <div style={rowMetaStyle}>
              <span>{formatTime(run.started_at)}</span>
              <span>·</span>
              <span>{formatDuration(run.duration_ms)}</span>
              {run.status !== 'success' ? (
                <>
                  <span>·</span>
                  <span style={{ color: '#b42318' }}>{run.status}</span>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------

export function StudioRunsPage() {
  const { data: session } = useSession();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;
  const [runs, setRuns] = useState<StudioActivityRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<RunsFilter>('all');

  useEffect(() => {
    if (signedOutPreview) return;
    let cancelled = false;
    api
      .getStudioActivity(100)
      .then((response) => {
        if (!cancelled) setRuns(response.runs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load runs');
      });
    return () => {
      cancelled = true;
    };
  }, [signedOutPreview]);

  const failedCount = useMemo(
    () =>
      runs
        ? runs.filter((r) => r.status === 'error' || r.status === 'timeout').length
        : 0,
    [runs],
  );

  const filteredRuns = useMemo(() => {
    if (!runs) return [];
    if (activeFilter === 'failed') {
      return runs.filter(
        (r) => r.status === 'error' || r.status === 'timeout',
      );
    }
    return runs;
  }, [runs, activeFilter]);

  return (
    <WorkspacePageShell
      mode="studio"
      title="All runs · Studio · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      {signedOutPreview ? (
        <StudioSignedOutState />
      ) : (
        <div data-testid="studio-runs-page" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {/* Page head */}
          <div style={headerStyle}>
            <div>
              <div style={eyebrowStyle}>Studio · All runs</div>
              <h1 style={titleStyle}>Latest across all apps</h1>
              <p style={subtitleStyle}>Who ran what, where they ran it from, and how long it took.</p>
            </div>
          </div>

          {/* Compact hero stat strip */}
          {runs !== null && runs.length > 0 && (
            <CompactHeroStrip runs={runs} />
          )}

          {/* Filter chips */}
          {runs !== null && runs.length > 0 && (
            <FilterChipBar
              active={activeFilter}
              totalCount={runs.length}
              failedCount={failedCount}
              onChange={setActiveFilter}
            />
          )}

          {error ? <div style={errorStyle}>{error}</div> : null}

          {runs === null ? (
            <div style={loadingStyle}>Loading runs…</div>
          ) : runs.length === 0 ? (
            <div data-testid="studio-runs-empty" style={emptyStyle}>
              Nothing here yet — be the first.
            </div>
          ) : filteredRuns.length === 0 ? (
            <div
              data-testid="studio-runs-filter-empty"
              style={{ ...emptyStyle, marginBottom: 12 }}
            >
              No runs match this filter.
            </div>
          ) : (
            <RunsTable runs={filteredRuns} />
          )}
        </div>
      )}
    </WorkspacePageShell>
  );
}

// ------------------------------------------------------------------
// Styles (preserved from old StudioRunsPage)
// ------------------------------------------------------------------

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  flexWrap: 'wrap',
  marginBottom: 18,
};

const eyebrowStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
};

const titleStyle: CSSProperties = {
  margin: '8px 0 0',
  fontFamily: 'var(--font-display)',
  fontSize: 34,
  fontWeight: 400,
  letterSpacing: '-0.03em',
  lineHeight: 1.05,
  color: 'var(--ink)',
};

const subtitleStyle: CSSProperties = {
  margin: '10px 0 0',
  maxWidth: 620,
  fontSize: 14,
  lineHeight: 1.65,
  color: 'var(--muted)',
};

const errorStyle: CSSProperties = {
  padding: '14px 16px',
  borderRadius: 16,
  border: '1px solid #f4b7b1',
  background: '#fdecea',
  color: '#5c2d26',
  fontSize: 13.5,
  lineHeight: 1.6,
};

const loadingStyle: CSSProperties = {
  padding: '18px',
  borderRadius: 18,
  border: '1px dashed var(--line)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  fontSize: 13,
};

const emptyStyle: CSSProperties = {
  padding: '24px 18px',
  borderRadius: 18,
  border: '1px dashed var(--line)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  fontSize: 13,
};

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 20,
  border: '1px solid var(--line)',
  overflow: 'hidden',
  background: 'var(--card)',
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px minmax(0, 1fr)',
  gap: 14,
  alignItems: 'center',
  padding: '16px 18px',
  borderBottom: '1px solid var(--line)',
};

const iconWrapStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 14,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const rowTitleStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: 'var(--ink)',
};

const rowMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 4,
  fontSize: 12,
  color: 'var(--muted)',
};

const strongStyle: CSSProperties = {
  fontWeight: 700,
};

const appLinkStyle: CSSProperties = {
  fontWeight: 700,
  color: 'var(--ink)',
  textDecoration: 'none',
};
