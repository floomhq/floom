/**
 * /run/runs — thin wrapper over RunsList.
 * Data fetching lives here; all rendering in RunsList.
 */

import { useEffect, useMemo, useState } from 'react';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { RunsList, runListRowsFromMeRuns } from '../components/workspace/RunsList';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { MeRunSummary } from '../lib/types';

const INITIAL_LIMIT = 25;
const LOAD_STEP = 25;
const FETCH_LIMIT = 200;

export function MeRunsPage() {
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_LIMIT);

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

  const allRows = useMemo(() => (runs ? runListRowsFromMeRuns(runs) : null), [runs]);
  const visibleRows = useMemo(
    () => (allRows ? allRows.slice(0, visibleCount) : null),
    [allRows, visibleCount],
  );
  const hasMore = allRows ? allRows.length > visibleCount : false;

  return (
    <WorkspacePageShell
      mode="run"
      title="Runs · Workspace Run · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      <RunsList
        mode="run"
        heading="Runs"
        subtitle="Run history for this workspace across browser, MCP, HTTP, and CLI."
        secondaryAction={
          <button
            type="button"
            style={{
              padding: '7px 14px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 999,
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--muted)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Export CSV
          </button>
        }
        stats={[
          {
            label: 'Runs 7d',
            value: runs ? String(runs.length) : '—',
            sub: 'this week',
          },
          { label: 'Success', value: runs ? successRate(runs) : '—', sub: 'rate' },
          { label: 'P95', value: runs ? p95(runs) : '—', sub: 'duration' },
          {
            label: 'Apps',
            value: runs ? String(new Set(runs.map((r) => r.app_slug).filter(Boolean)).size) : '—',
            sub: 'active',
          },
        ]}
        filters={[
          { label: 'All', active: true },
          { label: 'Failed only' },
        ]}
        runs={visibleRows}
        totalCount={runs?.length}
        hasMore={hasMore}
        onLoadMore={() => setVisibleCount((n) => n + LOAD_STEP)}
        loading={runs === null && !runsError}
        error={runsError}
      />
    </WorkspacePageShell>
  );
}

// ── Stat helpers ─────────────────────────────────────────────────────

function successRate(runs: MeRunSummary[]): string {
  if (runs.length === 0) return '—';
  const successes = runs.filter((r) => r.status === 'success').length;
  return `${((successes / runs.length) * 100).toFixed(1)}%`;
}

function p95(runs: MeRunSummary[]): string {
  const durations = runs
    .map((r) => r.duration_ms)
    .filter((d): d is number => d != null)
    .sort((a, b) => a - b);
  if (durations.length === 0) return '—';
  const idx = Math.floor(durations.length * 0.95);
  const ms = durations[Math.min(idx, durations.length - 1)];
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
