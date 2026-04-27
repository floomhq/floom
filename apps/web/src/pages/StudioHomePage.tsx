// /studio + /studio/apps.
// Canonical split: creator home lives at /studio; app index lives at /studio/apps.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { StudioDashboardHome } from '../components/studio/StudioDashboardHome';
import { StudioSignedOutState } from '../components/studio/StudioSignedOutState';
import * as api from '../api/client';
import { refreshMyApps, useMyApps } from '../hooks/useMyApps';
import { useSession } from '../hooks/useSession';
import { useDeployEnabled } from '../lib/flags';
import { formatTime } from '../lib/time';
import type {
  CreatorApp,
  MeRunSummary,
} from '../lib/types';
import { WaitlistModal } from '../components/WaitlistModal';
import {
  AppsList,
  studioAppsFromCreatorApps,
  type AppsListActivityRow,
} from '../components/workspace/AppsList';

export function StudioHomePage() {
  const { data: session } = useSession();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;

  return (
    <StudioLayout
      title="Studio · Floom"
      allowSignedOutShell={signedOutPreview}
      contentStyle={{
        maxWidth: 1240,
        padding: '24px 28px 96px',
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

  // Activity rows for the secondary panel
  const activityRows = useMemo((): AppsListActivityRow[] => {
    if (!recentRuns || recentRuns.length === 0) return [];
    return recentRuns.map((run) => ({
      id: run.id,
      title: run.app_name || run.app_slug || 'App',
      snippet: run.action || '',
      duration: run.duration_ms != null
        ? run.duration_ms < 1000
          ? `${Math.round(run.duration_ms)}ms`
          : `${(run.duration_ms / 1000).toFixed(1)}s`
        : '—',
      when: formatTime(run.started_at),
      href: `/studio/${run.app_slug}`,
      fast: run.duration_ms != null && run.duration_ms < 2000,
    }));
  }, [recentRuns]);

  // Convert CreatorApp[] → AppsListAppItem[] for the shared AppsList component
  const appsListItems = useMemo(
    () => (apps ? studioAppsFromCreatorApps(apps) : null),
    [apps],
  );

  const primaryCta = waitlistMode ? (
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
      + New app
    </Link>
  );

  return (
    <StudioLayout
      title="Studio apps · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      <div data-testid="studio-apps-page">
        {signedOutPreview ? (
          <StudioSignedOutState />
        ) : (
          <AppsList
            mode="studio"
            heading="Apps"
            subtitle={
              apps && apps.length > 0
                ? `Published and draft apps owned by this workspace.`
                : 'Ship your first app.'
            }
            primaryCta={primaryCta}
            stats={[
              {
                label: 'Runs · total',
                value: totalRuns.toLocaleString(),
                sub: 'all time',
              },
              {
                label: 'Apps',
                value: apps ? String(apps.length) : '—',
                sub: `${liveCount} live${draftCount > 0 ? ` · ${draftCount} draft` : ''}`,
              },
              {
                label: 'Last run',
                value: apps ? lastRunLabel(apps) : '—',
              },
              {
                label: 'P95',
                value: '—',
                sub: 'workspace',
              },
            ]}
            filters={[
              { label: 'All', active: true },
              { label: 'Active' },
              { label: 'Drafts' },
              { label: 'Pending review' },
            ]}
            apps={appsListItems}
            activityTitle="Recent activity"
            activityAllHref="/studio/runs"
            activityRows={activityRows}
            stripCta={primaryCta}
            loading={!apps && !error}
          />
        )}

        {/* Delete confirmation dialog — page-specific, not in AppsList */}
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

function lastRunLabel(apps: CreatorApp[]): string {
  const latest = apps
    .map((a) => a.last_run_at)
    .filter((v): v is string => !!v)
    .sort((a, b) => (a < b ? 1 : -1))[0];
  if (!latest) return 'never';
  return formatTime(latest);
}

