/**
 * /studio/runs — thin wrapper over RunsList.
 * Data fetching lives here; all rendering in RunsList.
 * v26-IA-SPEC §12.2: uses WorkspacePageShell mode="studio" for shell alignment.
 */

import { useEffect, useMemo, useState } from 'react';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { StudioSignedOutState } from '../components/studio/StudioSignedOutState';
import { RunsList, runListRowsFromStudioActivity } from '../components/workspace/RunsList';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { StudioActivityRun } from '../lib/types';

const INITIAL_LIMIT = 25;
const LOAD_STEP = 25;

export function StudioRunsPage() {
  const { data: session } = useSession();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;
  const [runs, setRuns] = useState<StudioActivityRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_LIMIT);

  useEffect(() => {
    if (signedOutPreview) return;
    let cancelled = false;
    api
      .getStudioActivity(200)
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

  const allRows = useMemo(() => (runs ? runListRowsFromStudioActivity(runs) : null), [runs]);
  const visibleRows = useMemo(
    () => (allRows ? allRows.slice(0, visibleCount) : null),
    [allRows, visibleCount],
  );
  const hasMore = allRows ? allRows.length > visibleCount : false;

  return (
    <WorkspacePageShell
      mode="studio"
      title="Runs · Studio · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      {signedOutPreview ? (
        <StudioSignedOutState />
      ) : (
        <RunsList
          mode="studio"
          heading="All runs"
          subtitle="Workspace-wide analytics across every app owned by this workspace."
          stats={[
            {
              label: 'Runs 7d',
              value: runs ? runs.length.toLocaleString() : '—',
              sub: 'all apps',
            },
            {
              label: 'Success',
              value: runs ? successRate(runs) : '—',
              sub: 'rate',
            },
            {
              label: 'P95',
              value: runs ? p95(runs) : '—',
              sub: 'duration',
            },
            {
              label: 'Apps',
              value: runs
                ? String(new Set(runs.map((r) => r.app_slug)).size)
                : '—',
              sub: 'active',
            },
          ]}
          filters={[
            { label: 'All apps', active: true },
            { label: 'Failed only' },
          ]}
          runs={visibleRows}
          totalCount={runs?.length}
          hasMore={hasMore}
          onLoadMore={() => setVisibleCount((n) => n + LOAD_STEP)}
          loading={runs === null && !error}
          error={error}
        />
      )}
    </WorkspacePageShell>
  );
}

// ── Stat helpers ─────────────────────────────────────────────────────

function successRate(runs: StudioActivityRun[]): string {
  if (runs.length === 0) return '—';
  const successes = runs.filter((r) => r.status === 'success').length;
  return `${((successes / runs.length) * 100).toFixed(1)}%`;
}

function p95(runs: StudioActivityRun[]): string {
  const durations = runs
    .map((r) => r.duration_ms)
    .filter((d): d is number => d != null)
    .sort((a, b) => a - b);
  if (durations.length === 0) return '—';
  const idx = Math.floor(durations.length * 0.95);
  const ms = durations[Math.min(idx, durations.length - 1)];
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
