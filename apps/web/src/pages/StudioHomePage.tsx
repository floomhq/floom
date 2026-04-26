// /studio + /studio/apps.
// Canonical split: creator home lives at /studio; app index lives at /studio/apps.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { StudioDashboardHome } from '../components/studio/StudioDashboardHome';
import { StudioSignedOutState } from '../components/studio/StudioSignedOutState';
import { Sparkline } from '../components/studio/Sparkline';
import * as api from '../api/client';
import { refreshMyApps, useMyApps } from '../hooks/useMyApps';
import { useSession } from '../hooks/useSession';
import { useDeployEnabled } from '../lib/flags';
import { formatTime } from '../lib/time';
import type {
  AppVisibility,
  CreatorApp,
  MeRunSummary,
} from '../lib/types';
import { DescriptionMarkdown } from '../components/DescriptionMarkdown';
import { WaitlistModal } from '../components/WaitlistModal';

export function StudioHomePage() {
  const { data: session } = useSession();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;

  return (
    <StudioLayout
      title="Studio · Floom"
      allowSignedOutShell={signedOutPreview}
      // v23 PR-H: outer padding is owned by .studio-page (22px 28px 96px).
      // Layout sets a slim baseline; .studio-page overrides to v23 spec.
      contentStyle={{
        maxWidth: 1240,
        padding: '0',
      }}
    >
      <StudioDashboardHome />
    </StudioLayout>
  );
}

export function StudioAppsPage() {
  const { apps, error: loadError } = useMyApps();
  const { data: session } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [recentRuns, setRecentRuns] = useState<MeRunSummary[] | null>(null);
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;
  // Launch flag. Null while session loads → fall back to showing the
  // original + New app / Start publishing CTAs rather than flickering.
  // A cold-load user who clicks before the session resolves would go to
  // /studio/build, which in turn runs through the same gate at render.
  const deployEnabled = useDeployEnabled();
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const waitlistMode = deployEnabled === false;

  useEffect(() => {
    if (signedOutPreview) {
      setError(null);
      return;
    }
    if (loadError) setError(loadError.message);
  }, [loadError, signedOutPreview]);

  // Fetch the cross-app activity feed. Only runs when we have a real
  // signed-in session (not the signed-out preview). Falls back to an
  // empty array on error so the panel shows an honest "no runs yet"
  // empty state instead of faking data.
  //
  // Recent runs feed. Scoping caveat (codex rounds 3 + 4 together
   // established ground truth): BOTH /me/runs AND /api/hub/:slug/runs
   // filter by the CALLER's user_id/device_id on the server. There is
   // currently no public endpoint that returns "runs OTHER users
   // triggered on your apps". Until such an endpoint exists we scope
   // honestly to the owner's own runs (the label below says "Your
   // recent runs" — not "Latest across callers"), and fetch in a single
   // /me/runs request filtered client-side to owned slugs. This
   // preserves: (a) truthful labeling, (b) no fan-out of N per-app
   // requests with full inputs/outputs payloads, (c) no fake data.
   // Follow-up: expose a server-side `GET /api/hub/mine/activity` that
   // joins runs across owned apps and returns a slim summary, then
   // switch the feed to that + rename the panel to match the wireframe.
  useEffect(() => {
    if (signedOutPreview) return;
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
  }, [apps, signedOutPreview]);

  async function handleDelete() {
    if (!confirmSlug) return;
    setDeleting(true);
    try {
      await api.deleteApp(confirmSlug);
      setConfirmSlug(null);
      setConfirmInput('');
      await refreshMyApps();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  // Client-side metrics derived from the apps list. We deliberately
  // only show numbers we can verify — total run count summed from the
  // per-app counters, and the live/draft split. Success rate, p50
  // latency, unique users appear in the wireframe but require hub-level
  // aggregates the API doesn't expose yet; per
  // memory/feedback_never_fabricate.md we leave them out rather than
  // hardcode an "illustrative" number.
  //
  // Live semantics: the backend only treats `published` apps as publicly
  // visible (pending_review / rejected / draft all 404 for non-owners).
  // BUT `publish_status` is optional on CreatorApp — older hub API
  // responses omit it, and those apps are the already-published fleet.
  // So: treat `published` OR undefined as live, and only the three
  // explicit non-published states (draft / pending_review / rejected)
  // as drafts. Preserves back-compat with older servers while still
  // refusing to claim a pending app is live.
  const liveCount = apps?.filter(isLiveApp).length ?? 0;
  const draftCount = apps?.filter((a) => !isLiveApp(a)).length ?? 0;
  const totalRuns = apps?.reduce((sum, a) => sum + (a.run_count || 0), 0) ?? 0;

  return (
    <StudioLayout
      title="Studio apps · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      <div data-testid="studio-apps-page">
        {signedOutPreview ? (
          <StudioSignedOutState />
        ) : (
          <>
            {/* Hero: eyebrow + DM-serif headline + primary CTA. Headline
                adapts to the app list so the page reads like it knows
                you: "Ship your first app." when empty, "One app live."
                etc when populated. Mirrors v17/studio-my-apps.html. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                gap: 20,
                marginBottom: 26,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ minWidth: 0, flex: '1 1 420px' }}>
                <div
                  style={{
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--accent)',
                    marginBottom: 6,
                  }}
                >
                  My apps
                </div>
                <h1
                  data-testid="studio-home-headline"
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 30,
                    fontWeight: 400,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.1,
                    margin: 0,
                    color: 'var(--ink)',
                  }}
                >
                  {studioHeadline(apps, liveCount, draftCount)}
                </h1>
                {apps && apps.length > 0 && (
                  <p
                    style={{
                      fontSize: 13.5,
                      color: 'var(--muted)',
                      lineHeight: 1.55,
                      margin: '8px 0 0',
                      maxWidth: 520,
                    }}
                  >
                    Apps you&rsquo;ve built and published. Installed apps live on your{' '}
                    <Link to="/me/apps" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                      Me · Installed
                    </Link>{' '}
                    page.
                  </p>
                )}
              </div>
              {waitlistMode ? (
                <button
                  type="button"
                  onClick={() => setWaitlistOpen(true)}
                  data-testid="studio-new-app-waitlist"
                  className="btn-ink"
                  style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}
                >
                  Join waitlist
                </button>
              ) : (
                <Link
                  to="/studio/build"
                  data-testid="studio-new-app-cta"
                  className="btn-ink"
                  style={{ textDecoration: 'none' }}
                >
                  + Deploy new app
                </Link>
              )}
            </div>

            {error && (
              <div
                style={{
                  background: '#fdecea',
                  border: '1px solid #f4b7b1',
                  color: '#c2321f',
                  borderRadius: 10,
                  padding: '14px 18px',
                  marginBottom: 20,
                }}
              >
                {error}
              </div>
            )}

            {!apps && !error && (
              <div data-testid="studio-loading" style={{ color: 'var(--muted)', padding: 32 }}>
                Loading...
              </div>
            )}

            {/* Metrics row. Two honest cells (Runs · total, Apps live) —
                see note above re: deliberate omission of success/latency/
                users until we have a real aggregates endpoint. */}
            {apps && apps.length > 0 && (
              <div
                data-testid="studio-metrics-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 12,
                  marginBottom: 28,
                }}
              >
                <MetricCell label="Runs · total" value={totalRuns.toLocaleString()} />
                <MetricCell
                  label="Apps"
                  value={String(apps.length)}
                  sub={`${liveCount} live${draftCount > 0 ? ` · ${draftCount} draft` : ''}`}
                />
                <MetricCell
                  label="Last run"
                  value={lastRunLabel(apps)}
                />
              </div>
            )}

            {apps && apps.length === 0 && <StudioEmptyState waitlistMode={waitlistMode} onWaitlist={() => setWaitlistOpen(true)} />}

            {apps && apps.length > 0 && (
              <>
                {/* Section rail. Mirrors wireframe: mono eyebrow + hairline. */}
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
                  data-testid="studio-apps-list"
                  style={{
                    display: 'grid',
                    gap: 14,
                    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                    marginBottom: 28,
                  }}
                >
                  {apps.map((a) => (
                    <AppCard
                      key={a.slug}
                      app={a}
                      onDelete={() => setConfirmSlug(a.slug)}
                    />
                  ))}
                </div>

                {/* Cross-app activity feed. Lifted from v17 studio-home +
                    studio-my-apps wireframes. Hidden when there are no
                    runs yet. */}
                {recentRuns && recentRuns.length > 0 && (
                  <ActivityFeed runs={recentRuns} />
                )}
              </>
            )}
          </>
        )}

        {confirmSlug && (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1000,
              background: 'rgba(0,0,0,0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
            }}
            onClick={() => setConfirmSlug(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'var(--card)',
                borderRadius: 12,
                padding: 24,
                maxWidth: 440,
                width: '100%',
              }}
            >
              <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--ink)' }}>
                Delete {confirmSlug}?
              </h3>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
                This removes the app from the store. Run history remains.
                Type <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>{confirmSlug}</code> to confirm.
              </p>
              <input
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                autoFocus
                data-testid="studio-delete-confirm"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--card)',
                  fontSize: 14,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: 'var(--ink)',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmSlug(null);
                    setConfirmInput('');
                  }}
                  style={{
                    padding: '8px 16px',
                    background: 'transparent',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    fontSize: 13,
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={confirmInput !== confirmSlug || deleting}
                  data-testid="studio-delete-submit"
                  style={{
                    padding: '8px 16px',
                    background: '#c2321f',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: confirmInput === confirmSlug && !deleting ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit',
                    opacity: confirmInput === confirmSlug && !deleting ? 1 : 0.6,
                  }}
                >
                  {deleting ? 'Deleting...' : 'Delete forever'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <WaitlistModal
        open={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
        source="studio-deploy"
      />
    </StudioLayout>
  );
}

function isLiveApp(app: CreatorApp): boolean {
  return !app.publish_status || app.publish_status === 'published';
}

// ------------------------------------------------------------------
// Headline + metric helpers
// ------------------------------------------------------------------

function studioHeadline(
  apps: CreatorApp[] | null | undefined,
  liveCount: number,
  draftCount: number,
): string {
  if (!apps) return 'Your apps';
  if (apps.length === 0) return 'Ship your first app.';
  const liveLabel =
    liveCount === 0
      ? 'No apps live yet'
      : liveCount === 1
        ? 'One app live'
        : `${liveCount} apps live`;
  if (draftCount === 0) return `${liveLabel}.`;
  const draftLabel =
    draftCount === 1 ? 'one draft' : `${draftCount} drafts`;
  return `${liveLabel}. ${capitalize(draftLabel)}.`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lastRunLabel(apps: CreatorApp[]): string {
  const latest = apps
    .map((a) => a.last_run_at)
    .filter((v): v is string => !!v)
    .sort((a, b) => (a < b ? 1 : -1))[0];
  if (!latest) return 'never';
  return formatTime(latest);
}

function MetricCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          letterSpacing: '-0.01em',
          color: 'var(--ink)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Empty state — 2 entry cards (GitHub / OpenAPI)
// Mirrors v17/studio-empty.html entry-grid shape. The wireframe shows
// a third "Docker image" card, but the current build flow only
// accepts GitHub refs and OpenAPI URLs (BuildPage.detectApp), so
// surfacing a Docker affordance would dead-end first-run creators.
// Add the Docker card back when the build flow supports image tags.
// ------------------------------------------------------------------

function StudioEmptyState({
  waitlistMode,
  onWaitlist,
}: {
  waitlistMode: boolean;
  onWaitlist: () => void;
}) {
  const entries: Array<{ title: string; desc: string }> = [
    { title: 'From GitHub', desc: 'Paste a repo URL. We read the Dockerfile.' },
    { title: 'OpenAPI spec', desc: 'Paste the spec URL. We wrap the API.' },
  ];
  return (
    <div
      data-testid="studio-empty"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: '48px 24px 56px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent-border, #a7f3d0)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
        }}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </div>
      <h3
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 28,
          fontWeight: 400,
          letterSpacing: '-0.02em',
          lineHeight: 1.1,
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
          margin: '0 auto 24px',
          maxWidth: 480,
          lineHeight: 1.55,
        }}
      >
        Paste a GitHub URL or an OpenAPI spec. Floom packages it as a runnable app with a public page, an MCP endpoint, and a JSON API. Under 60 seconds.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 10,
          maxWidth: 620,
          width: '100%',
          marginBottom: 20,
        }}
      >
        {entries.map((e) => {
          const common = {
            display: 'flex',
            flexDirection: 'column' as const,
            gap: 6,
            padding: 14,
            textAlign: 'left' as const,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            color: 'inherit',
            textDecoration: 'none',
            fontFamily: 'inherit',
          };
          return waitlistMode ? (
            <button
              key={e.title}
              type="button"
              onClick={onWaitlist}
              data-testid={`studio-empty-entry-${slugify(e.title)}`}
              style={{ ...common, cursor: 'pointer' }}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{e.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{e.desc}</div>
            </button>
          ) : (
            <Link
              key={e.title}
              to="/studio/build"
              data-testid={`studio-empty-entry-${slugify(e.title)}`}
              style={common}
            >
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{e.title}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{e.desc}</div>
            </Link>
          );
        })}
      </div>
      {waitlistMode ? (
        <button
          type="button"
          onClick={onWaitlist}
          data-testid="studio-empty-waitlist"
          className="btn-ink"
          style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}
        >
          Join waitlist
        </button>
      ) : (
        <Link to="/studio/build" data-testid="studio-empty-cta" className="btn-ink">
          Deploy from GitHub
        </Link>
      )}
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ------------------------------------------------------------------
// Cross-app activity feed
// ------------------------------------------------------------------

function ActivityFeed({ runs }: { runs: MeRunSummary[] }) {
  return (
    <div
      data-testid="studio-activity-feed"
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '16px 18px 6px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
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
          <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', marginTop: 2 }}>
            Your recent runs across your apps
          </div>
        </div>
        <Link
          to="/me/runs"
          data-testid="studio-activity-see-all"
          style={{
            fontSize: 12.5,
            color: 'var(--muted)',
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          See all →
        </Link>
      </div>
      <div style={{ borderTop: '1px solid var(--line)', margin: '0 -18px' }}>
        {runs.map((run) => (
          <ActivityRow key={run.id} run={run} />
        ))}
      </div>
    </div>
  );
}

function ActivityRow({ run }: { run: MeRunSummary }) {
  const failed = run.status === 'error' || run.status === 'timeout';
  const dotColor = failed ? '#ef4444' : 'var(--accent)';
  const dotHalo = failed ? '#fef2f2' : 'var(--accent-soft)';
  const durationLabel = run.duration_ms != null ? formatDuration(run.duration_ms) : '—';
  const appLabel = run.app_name || run.app_slug || 'app';
  const viewHref = `/me/runs/${run.id}`;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '16px minmax(0,1fr) auto auto auto',
        gap: 12,
        alignItems: 'center',
        padding: '10px 18px',
        borderBottom: '1px solid var(--line)',
        fontSize: 12.5,
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
        {failed && run.error && (
          <span
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 11,
              color: '#ef4444',
              marginLeft: 6,
            }}
          >
            · {truncate(run.error, 40)}
          </span>
        )}
      </div>
      <span
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          color: 'var(--muted)',
          fontSize: 11.5,
        }}
      >
        {durationLabel}
      </span>
      <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>
        {formatTime(run.started_at)}
      </span>
      <Link
        to={viewHref}
        style={{
          fontSize: 12,
          color: 'var(--accent)',
          textDecoration: 'none',
          fontWeight: 500,
        }}
      >
        View →
      </Link>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

// ------------------------------------------------------------------
// AppCard — v17 shape
// ------------------------------------------------------------------

function AppCard({
  app,
  onDelete,
}: {
  app: CreatorApp;
  onDelete: () => void;
}) {
  // Pill logic mirrors the page-level `isLive` helper: treat
  // `published` OR missing as live (so apps from older hub-API
  // responses that never emit publish_status still read as LIVE, not
  // DRAFT — back-compat), and the three explicit non-published states
  // (draft / pending_review / rejected) as DRAFT. The pending_review
  // card renders its own inline note below for context.
  const isPublished =
    !app.publish_status || app.publish_status === 'published';
  const initials = app.slug.slice(0, 2).toUpperCase();
  return (
    <div
      data-testid={`studio-app-card-${app.slug}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--muted)';
        e.currentTarget.style.boxShadow = '0 4px 16px rgba(15, 23, 42, 0.04)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line)';
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.transform = 'none';
      }}
    >
      {/* Row 1: monochrome letter chip + name/last-run + LIVE/DRAFT pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 15,
            fontWeight: 700,
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            color: 'var(--ink)',
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>
              {app.name}
            </div>
            {app.visibility && <VisibilityBadge value={app.visibility} />}
            {app.publish_status && app.publish_status !== 'published' && app.publish_status !== 'draft' && (
              <PublishStatusBadge value={app.publish_status} />
            )}
          </div>
          <div
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 10.5,
              color: 'var(--muted)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              marginTop: 2,
            }}
          >
            /p/{app.slug}
          </div>
        </div>
        {isPublished ? (
          <span
            data-testid={`studio-app-card-live-${app.slug}`}
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
            data-testid={`studio-app-card-draft-${app.slug}`}
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

      {app.publish_status === 'pending_review' && (
        <div
          data-testid={`studio-app-card-pending-review-${app.slug}`}
          style={{
            fontSize: 12,
            color: '#92400e',
            lineHeight: 1.4,
          }}
        >
          Pending review — Federico will take a look before this appears on the public Store.
        </div>
      )}

      {/* 2026-04-23: Fix #413 — app descriptions are markdown-enabled
          (per DescriptionMarkdown component). Previously rendered as
          plain text, so `## Heading\n` strings showed up literally in
          Studio cards. Clamp to 2 lines with line-clamp wrapper so the
          markdown render still respects card height. */}
      <div
        data-testid={`studio-app-card-desc-${app.slug}`}
        style={{
          fontSize: 13,
          color: 'var(--muted)',
          lineHeight: 1.5,
          margin: 0,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: 39,
        }}
      >
        {app.description ? (
          <DescriptionMarkdown
            description={app.description}
            testId={`studio-app-card-desc-md-${app.slug}`}
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              lineHeight: 1.5,
              margin: 0,
              maxWidth: 'none',
            }}
          />
        ) : (
          '(no description)'
        )}
      </div>

      {/* 2026-04-23 wireframe parity: per-card 7-day sparkline. Bars
          come from GET /api/hub/:slug/runs-by-day?days=7 (zero-filled
          server-side). Muted when the app has never run so the
          flat-empty strip reads as absence not failure. */}
      <Sparkline slug={app.slug} days={7} muted={app.run_count === 0} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
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
          runs{' '}
          <span aria-hidden="true" style={{ margin: '0 2px' }}>·</span>{' '}
          {app.last_run_at ? `last ${formatTime(app.last_run_at)}` : 'never run'}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          justifyContent: 'space-between',
          rowGap: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
          <Link
            to={`/studio/${app.slug}`}
            style={primaryBtnStyle}
            data-testid={`studio-open-${app.slug}`}
          >
            Open
          </Link>
          <Link to={`/p/${app.slug}`} style={secondaryBtnStyle}>
            View
          </Link>
        </div>
        <button
          type="button"
          onClick={onDelete}
          data-testid={`studio-delete-${app.slug}`}
          style={studioDeleteTertiaryStyle}
          aria-label={`Delete ${app.name}`}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '7px 12px',
  background: 'var(--ink)',
  color: '#fff',
  border: '1px solid var(--ink)',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
  textDecoration: 'none',
  flex: 1,
  textAlign: 'center',
  whiteSpace: 'nowrap',
  boxShadow: '0 1px 2px rgba(22, 21, 18, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '7px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--muted)',
  fontFamily: 'inherit',
  textDecoration: 'none',
  flex: 1,
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

/** Tertiary — demoted vs Open / View (issue #110). */
const studioDeleteTertiaryStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  color: 'var(--muted)',
  background: 'transparent',
  border: 'none',
  fontFamily: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
  textDecorationColor: 'rgba(88, 85, 80, 0.35)',
  textUnderlineOffset: '2px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

/**
 * Small text pill showing the app's visibility state. Colours mirror the
 * existing StudioAppPage VisibilityPill so the two surfaces read the
 * same. Only the three launch-scope states get a coloured treatment;
 * any other AppVisibility value (unlisted, invite-only) falls back to
 * a neutral pill.
 */
function VisibilityBadge({ value }: { value: AppVisibility }) {
  const tones: Record<string, { bg: string; fg: string; label: string }> = {
    public: { bg: '#e6f4ea', fg: '#1a7f37', label: 'Public' },
    'auth-required': { bg: '#e0e7ff', fg: '#3730a3', label: 'Signed-in only' },
    private: { bg: '#fef3c7', fg: '#b45309', label: 'Private' },
  };
  const tone = tones[value] || { bg: 'var(--bg)', fg: 'var(--muted)', label: value };
  return (
    <span
      data-testid={`studio-app-card-visibility-${value}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {tone.label}
    </span>
  );
}

/**
 * Small text pill showing the app's publish-review state (#362). Only
 * non-'published' states get a pill so the Studio card stays clean once
 * an admin has approved the app. 'pending_review' is the launch case;
 * 'rejected' / 'draft' are reserved for future flows.
 */
function PublishStatusBadge({
  value,
}: {
  value: NonNullable<CreatorApp['publish_status']>;
}) {
  const tones: Record<string, { bg: string; fg: string; label: string }> = {
    pending_review: { bg: '#fef3c7', fg: '#92400e', label: 'Pending review' },
    rejected: { bg: '#fee2e2', fg: '#991b1b', label: 'Rejected' },
    draft: { bg: 'var(--bg)', fg: 'var(--muted)', label: 'Draft' },
  };
  const tone = tones[value] || { bg: 'var(--bg)', fg: 'var(--muted)', label: value };
  return (
    <span
      data-testid={`studio-app-card-publish-status-${value}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {tone.label}
    </span>
  );
}
