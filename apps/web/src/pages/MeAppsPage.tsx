import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MeLayout } from '../components/me/MeLayout';
import { ToolTile } from '../components/me/ToolTile';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;

const s: Record<string, CSSProperties> = {
  sectionHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14,
    flexWrap: 'wrap',
  },
  sectionH2: {
    fontFamily: 'var(--font-display)',
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: '-0.03em',
    lineHeight: 1.15,
    margin: 0,
    color: 'var(--ink)',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 14,
    lineHeight: 1.55,
    color: 'var(--muted)',
  },
  headerLink: {
    fontSize: 13.5,
    fontWeight: 700,
    color: 'var(--accent)',
    textDecoration: 'none',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 14,
  },
  card: {
    border: '1px solid var(--line)',
    borderRadius: 20,
    background: 'var(--card)',
    boxShadow: '0 1px 0 rgba(17, 24, 39, 0.02)',
  },
  emptyCard: {
    border: '1px solid var(--line)',
    borderRadius: 24,
    background:
      'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,248,243,0.94) 100%)',
    padding: '38px 28px',
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
  button: {
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
};

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

  const usedApps = useMemo(() => {
    if (runs === null) return null;
    const seen = new Map<
      string,
      {
        slug: string;
        name: string;
        lastUsedAt: string | null;
        lastRunId: string;
        lastRunAction: string;
      }
    >();
    for (const run of runs) {
      if (!run.app_slug) continue;
      if (seen.has(run.app_slug)) continue;
      seen.set(run.app_slug, {
        slug: run.app_slug,
        name: run.app_name || run.app_slug,
        lastUsedAt: run.started_at,
        lastRunId: run.id,
        lastRunAction: run.action,
      });
    }
    return Array.from(seen.values());
  }, [runs]);

  return (
    <MeLayout
      activeTab="apps"
      title="Apps · Workspace Run · Floom"
      allowSignedOutShell={signedOutPreview}
      eyebrow="Workspace Run"
      heading="Apps"
      subtitle="Runnable apps in this workspace, sorted by the last time they ran."
      actions={
        <Link to="/apps" style={s.headerLink}>
          Browse store →
        </Link>
      }
    >
      <div data-testid="me-apps-page">
        <section data-testid="me-apps-used" aria-label="Apps you've used">
          <header style={s.sectionHeader}>
            <div>
              <h2 style={s.sectionH2}>Run again</h2>
              <p style={s.subtitle}>Pick up the last workspace run for each app.</p>
            </div>
          </header>

          {usedApps === null ? (
            <div style={{ ...s.card, padding: 18, color: 'var(--muted)', fontSize: 13.5 }}>
              Loading workspace apps…
            </div>
          ) : usedApps.length === 0 ? (
            <div data-testid="me-apps-used-empty" style={s.emptyCard}>
              <h2 style={s.emptyTitle}>You haven’t run anything yet.</h2>
              <p style={s.emptyBody}>
                Browse the public directory, try an app, and it appears here for quick re-runs.
              </p>
              <Link to="/apps" style={s.button}>
                Browse the store →
              </Link>
            </div>
          ) : (
            <div data-testid="me-apps-used-grid" style={s.grid}>
              {usedApps.map((app) => (
                <ToolTile
                  key={app.slug}
                  slug={app.slug}
                  name={app.name}
                  lastUsedAt={app.lastUsedAt}
                  lastRunId={app.lastRunId}
                  lastRunAction={app.lastRunAction}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </MeLayout>
  );
}
