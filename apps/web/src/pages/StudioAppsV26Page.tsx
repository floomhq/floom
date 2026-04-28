// /studio/apps — v26 Studio-mode apps dashboard.
//
// Wireframe: /var/www/wireframes-floom/v26/studio-apps.html
// Issues: #918 (stub fix), #913 (compact hero override), #928 (rebase onto main)
//
// Shell: WorkspacePageShell mode="studio" (StudioRail + ModeToggle per v26 §12).
// Hero: COMPACT single-line stat strip (NOT 4-card grid — issue #913).
// Grid: apps this user has built, sourced from useMyApps.
// Recent activity: panel from run history scoped to owned app slugs.
// Bottom CTA: + New app → /studio/build (overlay is issue #917, deferred).
//
// COEXIST strategy: v23 /studio/apps (StudioAppsPage in StudioHomePage.tsx) is
// preserved untouched. This file serves the NEW v26 /studio/apps route, which
// overrides the v23 route registration in main.tsx (last-wins in React Router).
// Per spec §9, /studio will redirect to /studio/apps going forward.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { useMyApps } from '../hooks/useMyApps';
import { useSession } from '../hooks/useSession';
import { formatTime } from '../lib/time';
import { DescriptionMarkdown } from '../components/DescriptionMarkdown';
import { Sparkline } from '../components/studio/Sparkline';
import * as api from '../api/client';
import type { CreatorApp, MeRunSummary } from '../lib/types';

// ------------------------------------------------------------------
// Compact hero metric strip (issue #913: NOT 4-card grid)
// ------------------------------------------------------------------

function isLiveApp(app: CreatorApp): boolean {
  return !app.publish_status || app.publish_status === 'published';
}

function CompactHeroStrip({
  apps,
  totalRuns,
}: {
  apps: CreatorApp[] | null;
  totalRuns: number;
}) {
  // TODO: success_rate + p95 require a server-side aggregates endpoint.
  //       Only surface metrics we can verify (totalRuns, apps count).
  const appCount = apps?.length ?? 0;
  const liveCount = apps?.filter(isLiveApp).length ?? 0;

  if (!apps || appCount === 0) return null;

  return (
    <div
      className="ws-compact-hero"
      data-testid="studio-apps-compact-hero"
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
        {totalRuns.toLocaleString()}
      </span>
      <span>runs across your apps</span>
      <span aria-hidden style={{ color: 'var(--line)', userSelect: 'none' }}>·</span>
      <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{appCount}</span>
      <span>app{appCount !== 1 ? 's' : ''}</span>
      {liveCount > 0 && (
        <>
          <span aria-hidden style={{ color: 'var(--line)', userSelect: 'none' }}>·</span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: 'var(--accent)',
              fontWeight: 700,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--accent)',
                display: 'inline-block',
              }}
            />
            {liveCount} live
          </span>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// App card
// ------------------------------------------------------------------

function StudioAppCard({ app }: { app: CreatorApp }) {
  const isPublished = isLiveApp(app);
  const initials = app.slug.slice(0, 2).toUpperCase();
  return (
    <div
      data-testid={`studio-apps-card-${app.slug}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'border-color 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--muted)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line)';
      }}
    >
      {/* Row 1: icon + name + live/draft pill */}
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
            /p/{app.slug}
          </div>
        </div>
        {isPublished ? (
          <span
            data-testid={`studio-apps-live-${app.slug}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '2px 8px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              border: '1px solid var(--accent-border, #a7f3d0)',
              flexShrink: 0,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: 'var(--accent)',
                display: 'inline-block',
              }}
            />
            LIVE
          </span>
        ) : (
          <span
            data-testid={`studio-apps-draft-${app.slug}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 7px',
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.04em',
              background: '#fef3c7',
              color: '#92400e',
              border: '1px solid #fde68a',
              flexShrink: 0,
            }}
          >
            DRAFT
          </span>
        )}
      </div>

      {/* Description */}
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--muted)',
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {app.description ? (
          <DescriptionMarkdown
            description={app.description}
            style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, margin: 0, maxWidth: 'none' }}
          />
        ) : (
          <span style={{ fontStyle: 'italic' }}>(no description)</span>
        )}
      </div>

      {/* Sparkline */}
      <Sparkline slug={app.slug} days={7} muted={app.run_count === 0} />

      {/* Runs + last run + open link */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          color: 'var(--muted)',
          paddingTop: 8,
          borderTop: '1px solid var(--line)',
        }}
      >
        <span>
          <strong
            style={{
              color: 'var(--ink)',
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            }}
          >
            {app.run_count.toLocaleString()}
          </strong>{' '}
          runs
          {app.last_run_at ? ` · last ${formatTime(app.last_run_at)}` : ''}
        </span>
        <Link
          to={`/studio/${app.slug}`}
          data-testid={`studio-apps-open-${app.slug}`}
          style={{
            fontSize: 12,
            color: 'var(--accent)',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Open dashboard →
        </Link>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Recent activity panel (sourced from /me/runs, scoped to owned slugs)
// ------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RecentActivityPanel({ runs }: { runs: MeRunSummary[] }) {
  const visible = runs.slice(0, 5);
  if (visible.length === 0) return null;

  return (
    <div
      data-testid="studio-apps-activity-feed"
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
        <div>
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
            Recent activity
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginTop: 2 }}>
            Your recent runs across your apps
          </div>
        </div>
        <Link
          to="/studio/runs"
          data-testid="studio-apps-activity-see-all"
          style={{
            fontSize: 12.5,
            color: 'var(--muted)',
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          All runs →
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
                <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{appLabel}</span>{' '}
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

function StudioEmptyState() {
  return (
    <div
      data-testid="studio-apps-empty"
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
        Ship your first app.
      </h3>
      <p
        style={{
          fontSize: 14,
          color: 'var(--muted)',
          margin: '0 auto 20px',
          maxWidth: 460,
          lineHeight: 1.55,
        }}
      >
        Paste a GitHub URL or an OpenAPI spec. Floom packages it as a
        runnable app with a public page, an MCP endpoint, and a JSON API.
        Under 60 seconds.
      </p>
      <Link
        to="/studio/build"
        className="btn-ink"
        data-testid="studio-apps-empty-cta"
      >
        + Deploy from GitHub
      </Link>
    </div>
  );
}

// ------------------------------------------------------------------
// Page — /studio/apps (v26)
// ------------------------------------------------------------------

export function StudioAppsV26Page() {
  const { apps, loading: appsLoading } = useMyApps();
  const { data: session } = useSession();
  const [recentRuns, setRecentRuns] = useState<MeRunSummary[] | null>(null);

  // Fetch recent runs scoped to owned app slugs.
  //
  // Scoping caveat: BOTH /me/runs AND /api/hub/:slug/runs filter by the
  // CALLER's user_id/device_id on the server. There is currently no public
  // endpoint that returns "runs OTHER users triggered on your apps". Until
  // such an endpoint exists we scope honestly to the owner's own runs
  // (the label below says "Your recent runs" not "Latest across callers"),
  // and fetch in a single /me/runs request filtered client-side to owned
  // slugs. Follow-up: expose GET /api/hub/mine/activity server-side.
  useEffect(() => {
    if (!apps || apps.length === 0) return;
    const ownedSlugs = new Set(apps.map((a) => a.slug));
    let cancelled = false;
    api
      .getMyRuns(200)
      .then((resp) => {
        if (cancelled) return;
        const filtered = resp.runs
          .filter((r) => r.app_slug && ownedSlugs.has(r.app_slug))
          .slice(0, 6);
        setRecentRuns(filtered);
      })
      .catch(() => {
        if (!cancelled) setRecentRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apps]);

  const signedOutPreview =
    !!session && session.cloud_mode && session.user.is_local;

  // Client-side metrics
  const totalRuns = apps?.reduce((s, a) => s + (a.run_count || 0), 0) ?? 0;

  return (
    <WorkspacePageShell mode="studio" title="Studio apps · Floom">
      <div data-testid="studio-apps-page">
        {signedOutPreview ? (
          <div
            data-testid="studio-apps-signed-out"
            style={{
              padding: '48px 24px',
              textAlign: 'center',
              color: 'var(--muted)',
            }}
          >
            <h3 style={{ color: 'var(--ink)', marginBottom: 8 }}>
              Sign in to view Studio
            </h3>
            <Link to="/login?next=%2Fstudio%2Fapps" className="btn-ink">
              Sign in
            </Link>
          </div>
        ) : (
          <>
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
                  {apps && apps.length > 0
                    ? 'Published and draft apps you have built.'
                    : 'Apps you build and publish appear here.'}
                </p>
              </div>
              <Link
                to="/studio/build"
                data-testid="studio-apps-new-app-cta"
                style={{
                  padding: '8px 14px',
                  background: 'var(--ink)',
                  color: '#fff',
                  border: '1px solid var(--ink)',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                + New app
              </Link>
            </div>

            {/* Compact hero metric strip (issue #913: NOT 4-card grid) */}
            {!appsLoading && (
              <CompactHeroStrip apps={apps ?? null} totalRuns={totalRuns} />
            )}

            {/* Loading state */}
            {appsLoading && !apps && (
              <div
                data-testid="studio-apps-loading"
                style={{ color: 'var(--muted)', padding: '32px 0', fontSize: 14 }}
              >
                Loading your apps…
              </div>
            )}

            {/* Apps grid */}
            {apps !== null && apps !== undefined && (
              <>
                {apps.length === 0 ? (
                  <StudioEmptyState />
                ) : (
                  <>
                    {/* Section label */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginBottom: 12,
                        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                        fontSize: 10.5,
                        fontWeight: 700,
                        color: 'var(--muted)',
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                      }}
                    >
                      <span>Your apps</span>
                      <span
                        aria-hidden="true"
                        style={{ flex: 1, height: 1, background: 'var(--line)' }}
                      />
                    </div>

                    <div
                      data-testid="studio-apps-grid"
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                        gap: 14,
                        marginBottom: 18,
                      }}
                    >
                      {apps.map((app) => (
                        <StudioAppCard key={app.slug} app={app} />
                      ))}
                    </div>

                    {/* Recent activity panel */}
                    {recentRuns && recentRuns.length > 0 && (
                      <RecentActivityPanel runs={recentRuns} />
                    )}
                  </>
                )}
              </>
            )}

            {/* Bottom CTA: + New app (issue #917 overlay deferred; links to /studio/build) */}
            <div data-testid="studio-apps-bottom-cta" style={{ marginTop: 4 }}>
              <Link
                to="/studio/build"
                style={{
                  padding: '8px 16px',
                  background: 'var(--ink)',
                  color: '#fff',
                  border: '1px solid var(--ink)',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  textDecoration: 'none',
                }}
              >
                + New app
              </Link>
            </div>
          </>
        )}
      </div>
    </WorkspacePageShell>
  );
}
