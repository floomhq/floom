// /studio/:slug/runs — full list of runs scoped to a single app. The
// Studio Overview tab shows only the most recent 5; this page is the
// "see all" destination. Owner-only.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { AppHeader } from './MeAppPage';
import * as api from '../api/client';
import type { AppDetail, CreatorRun } from '../lib/types';
import { formatTime } from '../lib/time';

export function StudioAppRunsPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [runs, setRuns] = useState<CreatorRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api
      .getApp(slug)
      .then((res) => !cancelled && setApp(res))
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 404) {
          nav('/studio', { replace: true });
          return;
        }
        if (status === 403) {
          nav(`/p/${slug}`, { replace: true });
          return;
        }
        setError((err as Error).message || 'Failed to load app');
      });
    api
      .getAppRuns(slug, 100)
      .then((res) => !cancelled && setRuns(res.runs))
      .catch(() => !cancelled && setRuns([]));
    return () => {
      cancelled = true;
    };
  }, [slug, nav]);

  return (
    <StudioLayout
      title={app ? `${app.name} · Runs · Studio` : 'Runs · Studio'}
      activeAppSlug={slug}
      activeSubsection="runs"
    >
      {error && <div style={errorStyle}>{error}</div>}
      {app && (
        <>
          <AppHeader app={app} />
          <h2 style={sectionHeader}>All runs</h2>
          {!runs && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
          {runs && runs.length === 0 && (
            <div data-testid="studio-app-runs-empty" style={emptyState}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                No runs yet
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                Share <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>/p/{app.slug}</code> to drive your first run.
              </p>
            </div>
          )}
          {runs && runs.length > 0 && (
            <div
              data-testid="studio-app-runs-list"
              style={{
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--card)',
                overflow: 'hidden',
              }}
            >
              <div style={tableHeaderStyle}>
                <span>Started</span>
                <span>Action</span>
                <span>Status</span>
                <span style={{ textAlign: 'right' }}>Time</span>
              </div>
              {runs.map((r) => (
                <Link
                  key={r.id}
                  to={`/me/runs/${r.id}`}
                  style={tableRowStyle}
                >
                  <span>{formatTime(r.started_at)}</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: 'var(--muted)' }}>
                    {r.action}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.status}</span>
                  <span style={{ textAlign: 'right', fontSize: 12, color: 'var(--muted)' }}>
                    {r.duration_ms ? `${Math.round(r.duration_ms)}ms` : '-'}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </StudioLayout>
  );
}

const sectionHeader: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: 'var(--ink)',
  margin: '20px 0 12px',
};

const errorStyle: React.CSSProperties = {
  background: '#fdecea',
  border: '1px solid #f4b7b1',
  color: '#c2321f',
  padding: '10px 14px',
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 20,
};

const emptyState: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 10,
  padding: '24px 20px',
  background: 'var(--card)',
};

const tableHeaderStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.5fr 1fr 1fr 80px',
  gap: 8,
  padding: '10px 16px',
  background: 'var(--bg)',
  borderBottom: '1px solid var(--line)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--muted)',
  fontWeight: 700,
};

const tableRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.5fr 1fr 1fr 80px',
  gap: 8,
  padding: '12px 16px',
  borderBottom: '1px solid var(--line)',
  fontSize: 13,
  color: 'var(--ink)',
  textDecoration: 'none',
  alignItems: 'center',
};
