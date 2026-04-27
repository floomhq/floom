/**
 * /run/apps — thin wrapper over AppsList.
 * Data fetching lives here; all rendering in AppsList.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import {
  AppsList,
  runAppsFromRuns,
  type AppsListActivityRow,
} from '../components/workspace/AppsList';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;

export function MeAppsPage() {
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);

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
      .catch(() => {
        if (!cancelled) setRuns([]);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionPending, signedOutPreview]);

  const apps = useMemo(() => (runs ? runAppsFromRuns(runs) : null), [runs]);

  // Build recent-activity rows from the most recent 3 runs
  const activityRows = useMemo((): AppsListActivityRow[] => {
    if (!runs || runs.length === 0) return [];
    return runs.slice(0, 3).map((run) => ({
      id: run.id,
      title: run.app_name || run.app_slug || 'App',
      snippet: run.action || '',
      duration: run.duration_ms != null
        ? run.duration_ms < 1000
          ? `${Math.round(run.duration_ms)}ms`
          : `${(run.duration_ms / 1000).toFixed(1)}s`
        : '—',
      when: formatTime(run.started_at),
      href: `/run/runs/${encodeURIComponent(run.id)}`,
      fast: run.duration_ms != null && run.duration_ms < 2000,
    }));
  }, [runs]);

  const loading = runs === null;

  return (
    <WorkspacePageShell
      mode="run"
      title="Apps · Workspace Run · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      <AppsList
        mode="run"
        heading="Apps"
        subtitle={`Runnable apps in this workspace, sorted by the last time they ran.`}
        primaryCta={
          <Link
            to="/apps"
            style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent)', textDecoration: 'none' }}
          >
            Browse store →
          </Link>
        }
        stats={[
          { label: 'Apps', value: apps ? String(apps.length) : '—', sub: 'installed' },
          { label: 'Runs 7d', value: '—', sub: 'this week' },
          { label: 'Running now', value: '—', sub: 'active' },
          { label: 'P95', value: '—', sub: 'workspace' },
        ]}
        filters={[
          { label: 'All', active: true },
          { label: 'Recently used' },
          { label: 'Scheduled' },
        ]}
        toolbarAction={
          <Link
            to="/apps"
            className="btn btn-secondary btn-sm"
            style={{ textDecoration: 'none', fontSize: 12.5, padding: '6px 12px' }}
          >
            Browse the store →
          </Link>
        }
        apps={apps}
        activityTitle="Recent runs"
        activityAllHref="/run/runs"
        activityRows={activityRows}
        stripCta={
          <Link
            to="/apps"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '9px 16px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
          >
            Browse the app store →
          </Link>
        }
        loading={loading}
      />
    </WorkspacePageShell>
  );
}
