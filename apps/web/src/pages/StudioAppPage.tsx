// /studio/:slug — Studio per-app Overview. Creator workspace view of
// an owned app. Shows app header, ownership actions (New run link to
// /p/:slug, View in Store, Delete), and recent runs (scoped to owner).
//
// Access-gated: non-owners are redirected to /p/:slug (the public page).

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { AppHeader } from './MeAppPage';
import * as api from '../api/client';
import type { AppDetail, CreatorRun } from '../lib/types';
import { formatTime } from '../lib/time';

export function StudioAppPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [runs, setRuns] = useState<CreatorRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setApp(null);
    setRuns(null);
    setError(null);
    api
      .getApp(slug)
      .then((res) => {
        if (cancelled) return;
        setApp(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 404) {
          const q = new URLSearchParams({ notice: 'app_not_found' });
          if (slug) q.set('slug', slug);
          nav(`/studio?${q.toString()}`, { replace: true });
          return;
        }
        if (status === 403) {
          // Not owner → bounce to public permalink.
          nav(`/p/${slug}`, { replace: true });
          return;
        }
        setError((err as Error).message || 'Failed to load app');
      });
    api
      .getAppRuns(slug, 10)
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, nav]);

  return (
    <StudioLayout
      title={app ? `${app.name} · Studio` : 'App · Studio'}
      activeAppSlug={slug}
      activeSubsection="overview"
    >
      {error && (
        <div
          data-testid="studio-app-error"
          style={{
            background: '#fdecea',
            border: '1px solid #f4b7b1',
            color: '#c2321f',
            padding: '10px 14px',
            borderRadius: 8,
            fontSize: 13,
            marginBottom: 20,
          }}
        >
          {error}
        </div>
      )}
      {!app && !error && <LoadingSkeleton />}
      {app && (
        <div data-testid="studio-app-overview">
          <AppHeader app={app} />

          <div
            style={{
              display: 'flex',
              gap: 10,
              marginBottom: 28,
              flexWrap: 'wrap',
            }}
          >
            <Link
              to={`/p/${app.slug}`}
              data-testid="studio-app-open-store"
              style={primaryCta}
            >
              Open in Store →
            </Link>
            <Link
              to={`/studio/${app.slug}/secrets`}
              style={secondaryCta}
            >
              Manage secrets
            </Link>
            <Link
              to={`/studio/${app.slug}/runs`}
              style={secondaryCta}
            >
              View runs
            </Link>
          </div>

          <h2 style={sectionHeader}>Recent runs</h2>
          {!runs && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
          {runs && runs.length === 0 && (
            <div
              data-testid="studio-app-runs-empty"
              style={emptyState}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                No runs yet
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                Share <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>/p/{app.slug}</code> to drive your first run.
              </p>
            </div>
          )}
          {runs && runs.length > 0 && (
            <RunTable runs={runs.slice(0, 5)} />
          )}
          {runs && runs.length > 5 && (
            <div style={{ marginTop: 12 }}>
              <Link to={`/studio/${app.slug}/runs`} style={{ color: 'var(--accent)', fontSize: 13 }}>
                View all runs →
              </Link>
            </div>
          )}
        </div>
      )}
    </StudioLayout>
  );
}

function RunTable({ runs }: { runs: CreatorRun[] }) {
  return (
    <div
      data-testid="studio-app-runs"
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'var(--card)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
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
        }}
      >
        <span>Started</span>
        <span>Action</span>
        <span>Status</span>
        <span style={{ textAlign: 'right' }}>Time</span>
      </div>
      {runs.map((r) => (
        <Link
          key={r.id}
          to={`/me/runs/${r.id}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '1.5fr 1fr 1fr 80px',
            gap: 8,
            padding: '12px 16px',
            borderBottom: '1px solid var(--line)',
            fontSize: 13,
            color: 'var(--ink)',
            textDecoration: 'none',
            alignItems: 'center',
          }}
        >
          <span>{formatTime(r.started_at)}</span>
          <span
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              color: 'var(--muted)',
            }}
          >
            {r.action}
          </span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.status}</span>
          <span style={{ textAlign: 'right', fontSize: 12, color: 'var(--muted)' }}>
            {r.duration_ms ? `${Math.round(r.duration_ms)}ms` : '-'}
          </span>
        </Link>
      ))}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div data-testid="studio-app-loading" style={{ opacity: 0.6 }}>
      <div style={{ height: 44, background: 'var(--bg)', borderRadius: 8, marginBottom: 16 }} />
      <div style={{ height: 200, background: 'var(--bg)', borderRadius: 10 }} />
    </div>
  );
}

const primaryCta: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 18px',
  background: 'var(--ink)',
  color: '#fff',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
};

const secondaryCta: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 18px',
  background: 'var(--card)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: 'none',
};

const sectionHeader: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--muted)',
  margin: '0 0 10px',
};

const emptyState: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 10,
  padding: '24px 20px',
  background: 'var(--card)',
};
