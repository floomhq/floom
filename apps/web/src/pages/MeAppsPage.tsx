// /me/apps — Apps tab of the Studio-tabbed dashboard.
//
// Shows two sections on one page:
//   1. Apps you've used — distinct slugs from your run history, most-
//      recent first. Links to /p/:slug to run again.
//   2. Apps you publish — your own CreatorApps (from /api/me/apps). Each
//      row links to /studio/:slug so the creator can manage the app.
//
// Why together? The two lists are cheap to render side-by-side and
// answering "where is my app?" shouldn't require the user to remember
// whether it's something they ran or something they shipped. The
// Studio-surface creator experience still lives at /studio; this tab
// exists so the user dashboard has a complete picture of "apps in my
// orbit" without requiring two context switches.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MeLayout } from '../components/me/MeLayout';
import { ToolTile } from '../components/me/ToolTile';
import { AppIcon } from '../components/AppIcon';
import { useSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;

const s: Record<string, CSSProperties> = {
  sectionHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14,
  },
  sectionH2: {
    fontFamily: 'var(--font-display)',
    fontSize: 20,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 1.2,
    margin: 0,
    color: 'var(--ink)',
  },
  headerLink: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--accent)',
    textDecoration: 'none',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: 12,
    marginBottom: 40,
  },
  emptyCard: {
    border: '1px dashed var(--line)',
    borderRadius: 12,
    background: 'var(--card)',
    padding: '24px 20px',
    textAlign: 'center' as const,
    marginBottom: 40,
  },
  publishList: {
    border: '1px solid var(--line)',
    borderRadius: 12,
    background: 'var(--card)',
    overflow: 'hidden',
  },
  publishRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 16px',
    textDecoration: 'none',
    color: 'var(--ink)',
    borderBottom: '1px solid var(--line)',
    transition: 'background 0.12s ease',
  },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    background: 'var(--bg)',
    border: '1px solid var(--line)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
};

export function MeAppsPage() {
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const { apps: myApps, loading: myAppsLoading } = useMyApps();
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
    const seen = new Map<string, { slug: string; name: string; lastUsedAt: string | null }>();
    for (const run of runs) {
      if (!run.app_slug) continue;
      if (seen.has(run.app_slug)) continue;
      seen.set(run.app_slug, {
        slug: run.app_slug,
        name: run.app_name || run.app_slug,
        lastUsedAt: run.started_at,
      });
    }
    return Array.from(seen.values());
  }, [runs]);

  return (
    <MeLayout activeTab="apps" title="Apps · Me · Floom" allowSignedOutShell={signedOutPreview}>
      <div data-testid="me-apps-page">
        {/* Used apps */}
        <section data-testid="me-apps-used" aria-label="Apps you've used" style={{ marginBottom: 8 }}>
          <header style={s.sectionHeader}>
            <h2 style={s.sectionH2}>Apps you&rsquo;ve used</h2>
            <Link to="/apps" style={s.headerLink}>
              Browse the directory →
            </Link>
          </header>

          {usedApps === null ? (
            <div
              style={{
                ...s.emptyCard,
                borderStyle: 'solid',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              Loading…
            </div>
          ) : usedApps.length === 0 ? (
            <div data-testid="me-apps-used-empty" style={s.emptyCard}>
              <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
                You haven&rsquo;t run any Floom apps yet.
              </div>
              <Link
                to="/apps"
                style={{
                  display: 'inline-block',
                  padding: '10px 18px',
                  background: 'var(--ink)',
                  color: '#fff',
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Try an app →
              </Link>
            </div>
          ) : (
            <div data-testid="me-apps-used-grid" style={s.grid}>
              {usedApps.map((a) => (
                <ToolTile key={a.slug} slug={a.slug} name={a.name} lastUsedAt={a.lastUsedAt} />
              ))}
            </div>
          )}
        </section>

        {/* Published apps */}
        <section data-testid="me-apps-published" aria-label="Apps you publish">
          <header style={s.sectionHeader}>
            <h2 style={s.sectionH2}>Apps you publish</h2>
            <Link to="/studio/build" style={s.headerLink}>
              + New app
            </Link>
          </header>

          {signedOutPreview ? (
            <div style={s.emptyCard}>
              <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.5 }}>
                Sign in to see the apps you publish.
              </div>
            </div>
          ) : myAppsLoading ? (
            <div
              style={{
                ...s.emptyCard,
                borderStyle: 'solid',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              Loading…
            </div>
          ) : !myApps || myApps.length === 0 ? (
            <div data-testid="me-apps-published-empty" style={s.emptyCard}>
              <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
                No published apps yet. Publish one from GitHub or an OpenAPI URL.
              </div>
              <Link
                to="/studio/build"
                style={{
                  display: 'inline-block',
                  padding: '10px 18px',
                  background: 'var(--accent, #10b981)',
                  color: '#fff',
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Publish your first app →
              </Link>
            </div>
          ) : (
            <div data-testid="me-apps-published-list" style={s.publishList}>
              {myApps.map((app, i) => (
                <Link
                  key={app.slug}
                  to={`/studio/${app.slug}`}
                  data-testid={`me-published-row-${app.slug}`}
                  style={{
                    ...s.publishRow,
                    borderBottom: i === myApps.length - 1 ? 'none' : '1px solid var(--line)',
                  }}
                >
                  <span aria-hidden style={s.iconWrap}>
                    <AppIcon slug={app.slug} size={16} />
                  </span>
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
                      {app.name || app.slug}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--muted)',
                        fontFamily: 'JetBrains Mono, monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      /p/{app.slug}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--muted)',
                      flexShrink: 0,
                      textTransform: 'capitalize' as const,
                    }}
                  >
                    {app.visibility || 'public'}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
                    {formatTime(app.updated_at)}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </MeLayout>
  );
}
