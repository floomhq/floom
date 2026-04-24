// /me — Overview tab of the Studio-tabbed dashboard (issue #547).
//
// Four at-a-glance cards across the top (runs last 7d, apps count,
// free-runs-remaining, BYOK status) then a short "Your apps" mini-tile
// row and the 5 most-recent runs. Full history + full apps list live on
// /me/runs and /me/apps respectively. Settings and Secrets are their
// own tabs (see MeLayout).
//
// Why the split? Earlier /me was a flat "greeting + used apps + run
// history" scroll. It worked fine as a single page but did not answer
// "what's the state of my account?" at a glance. The Overview layout
// surfaces the four numbers that matter (how active I've been, how much
// I've built, whether I'm going to hit the free-tier wall, whether I've
// brought my own key) and pushes the lists to their own tabs.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MeLayout } from '../components/me/MeLayout';
import { AppIcon } from '../components/AppIcon';
import { ToolTile } from '../components/me/ToolTile';
import { Tour } from '../components/onboarding/Tour';
import { hasOnboarded, resetOnboarding } from '../lib/onboarding';
import { useSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
import { useDeployEnabled } from '../lib/flags';
import { WaitlistModal } from '../components/WaitlistModal';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { MeRunSummary, RunStatus } from '../lib/types';

// BYOK key is written by BYOKModal under this localStorage entry. Read it
// (never write it) to drive the BYOK status card on the overview tab.
const BYOK_KEY = 'floom_user_gemini_key';
// Matches apps/server/src/lib/byok-gate.ts — 5 free Gemini runs per anon
// session. Surfaced here so users don't get surprised at run 6 with a
// modal. If this constant drifts on the server, update both in the same PR.
const FREE_RUNS_LIMIT = 5;
const FETCH_LIMIT = 200;
const RECENT_RUNS_PREVIEW = 5;
const APPS_TILE_PREVIEW = 4;

const s: Record<string, CSSProperties> = {
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 12,
    marginBottom: 32,
  },
  statCard: {
    border: '1px solid var(--line)',
    borderRadius: 12,
    background: 'var(--card)',
    padding: '16px 18px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--muted)',
    letterSpacing: '0.01em',
    textTransform: 'uppercase' as const,
    margin: 0,
  },
  statValue: {
    fontFamily: 'var(--font-display)',
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    color: 'var(--ink)',
    lineHeight: 1.1,
    margin: 0,
  },
  statHint: {
    fontSize: 12,
    color: 'var(--muted)',
    lineHeight: 1.45,
    margin: 0,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  sectionH2: {
    fontFamily: 'var(--font-display)',
    fontSize: 18,
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
  card: {
    border: '1px solid var(--line)',
    borderRadius: 12,
    background: 'var(--card)',
    overflow: 'hidden',
  },
  appsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
    gap: 12,
    marginBottom: 36,
  },
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '12px 16px',
    marginBottom: 20,
    borderRadius: 10,
    border: '1px solid #f4b7b1',
    background: '#fdecea',
    color: '#5c2d26',
  },
  welcome: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '14px 16px',
    marginBottom: 20,
    borderRadius: 10,
    border: '1px solid var(--accent)',
    background: 'rgba(34, 197, 94, 0.08)',
    color: 'var(--ink)',
  },
  noticeDismiss: {
    flexShrink: 0,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--ink)',
    background: 'rgba(255,255,255,0.6)',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  appIconWrap: {
    width: 26,
    height: 26,
    borderRadius: 6,
    background: 'var(--bg)',
    border: '1px solid var(--line)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  footerLink: {
    marginTop: 28,
    paddingTop: 18,
    borderTop: '1px solid var(--line)',
    fontSize: 12,
    color: 'var(--muted)',
    textAlign: 'center' as const,
  },
};

export function MePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: sessionData, loading: sessionLoading, error: sessionError } = useSession();
  const { apps: myApps } = useMyApps();

  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);

  const sessionPending = sessionLoading || (sessionData === null && !sessionError);
  const signedOutPreview = !!sessionData && sessionData.cloud_mode && sessionData.user.is_local;
  const canLoadPersonalData = !signedOutPreview;

  // Launch flag. Used to gate the publish CTA + waitlist modal; when
  // DEPLOY_ENABLED=false the Overview never surfaces the publish prompt,
  // just the free-tier hints.
  useDeployEnabled();
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  useEffect(() => {
    if (sessionPending) return;
    if (!canLoadPersonalData) {
      setRuns([]);
      setRunsError(null);
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
  }, [canLoadPersonalData, sessionPending]);

  // Used apps = distinct slugs the user has actually run, most-recent
  // first. Small preview row on the Overview tab; the full grid lives on
  // /me/apps (which also merges published apps from useMyApps).
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
      if (seen.size >= APPS_TILE_PREVIEW) break;
    }
    return Array.from(seen.values());
  }, [runs]);

  // Stats
  const runsLast7d = useMemo(() => {
    if (runs === null) return null;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return runs.filter((r) => {
      const t = r.started_at ? new Date(r.started_at).getTime() : NaN;
      return Number.isFinite(t) && t >= cutoff;
    }).length;
  }, [runs]);

  const appsCount = myApps ? myApps.length : null;

  // Free runs remaining: we don't have a session endpoint for usage (yet),
  // so surface the limit + a hint to BYOK. When BYOK is set, display
  // "Unlimited". See apps/server/src/lib/byok-gate.ts for the real counter.
  const [byokSet, setByokSet] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setByokSet(!!window.localStorage.getItem(BYOK_KEY));
    } catch {
      setByokSet(false);
    }
  }, []);

  // URL params: ?notice=app_not_found (from redirect), ?welcome=1 (post-signup),
  // ?tour=1 (restart tour), ?slug=<slug> (context for notice).
  const showNotice = searchParams.get('notice') === 'app_not_found';
  const noticeSlug = searchParams.get('slug');
  const showWelcome = searchParams.get('welcome') === '1';
  const forceTour = searchParams.get('tour') === '1';
  const [tourOpen, setTourOpen] = useState(false);

  function dismissNotice() {
    const next = new URLSearchParams(searchParams);
    next.delete('notice');
    next.delete('slug');
    setSearchParams(next, { replace: true });
  }

  function dismissWelcome() {
    const next = new URLSearchParams(searchParams);
    next.delete('welcome');
    setSearchParams(next, { replace: true });
  }

  useEffect(() => {
    if (forceTour) {
      setTourOpen(true);
      return;
    }
    if (sessionPending || !canLoadPersonalData) return;
    if (runs !== null && runs.length === 0 && !hasOnboarded()) {
      setTourOpen(true);
    }
  }, [forceTour, runs, sessionPending, canLoadPersonalData]);

  function closeTour() {
    setTourOpen(false);
    if (forceTour) {
      const next = new URLSearchParams(searchParams);
      next.delete('tour');
      setSearchParams(next, { replace: true });
    }
  }

  function openRun(run: MeRunSummary) {
    if (!run.app_slug) return;
    navigate(`/p/${run.app_slug}?run=${encodeURIComponent(run.id)}`);
  }

  const recentRuns = useMemo(
    () => (runs ? runs.slice(0, RECENT_RUNS_PREVIEW) : []),
    [runs],
  );

  return (
    <MeLayout activeTab="overview" title="Me · Floom" allowSignedOutShell={signedOutPreview}>
      <div data-testid="me-page">
        {showWelcome && <WelcomeBanner onDismiss={dismissWelcome} />}

        {showNotice && <AppNotFound slug={noticeSlug} onDismiss={dismissNotice} />}

        {/* Overview stats — runs last 7d, apps count, free runs left,
            BYOK status. Each card is a flat neutral surface; the one
            exception is the BYOK card turning green when set, because
            that is a state change the user actively cares about. */}
        <div data-testid="me-overview-stats" style={s.statsGrid}>
          <StatCard
            testid="stat-runs-7d"
            label="Runs · last 7 days"
            value={runsLast7d === null ? '…' : String(runsLast7d)}
            hint={
              runs && runs.length > 0
                ? `${runs.length} total`
                : 'Your runs will show up here.'
            }
          />
          <StatCard
            testid="stat-apps"
            label="Apps you publish"
            value={appsCount === null ? '…' : String(appsCount)}
            hint={
              appsCount === 0
                ? 'Ship your first one.'
                : appsCount === 1
                  ? '1 live app.'
                  : `${appsCount} live apps.`
            }
          />
          <StatCard
            testid="stat-free-runs"
            label="Free runs"
            value={byokSet ? 'Unlimited' : `${FREE_RUNS_LIMIT}/day`}
            hint={
              byokSet
                ? 'Your Gemini key is set. No rate limit.'
                : 'Then add your own Gemini key to keep going.'
            }
          />
          <StatCard
            testid="stat-byok"
            label="Gemini key"
            value={byokSet ? 'Connected' : 'Not set'}
            hint={
              byokSet
                ? 'Stored in your browser, never sent to us.'
                : 'Set it in Settings to unlock unlimited runs.'
            }
            accent={byokSet === true}
          />
        </div>

        {signedOutPreview && (
          <section
            data-testid="me-signed-out-shell"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: '16px 18px',
              marginBottom: 24,
              borderRadius: 12,
              border: '1px solid var(--line)',
              background: 'var(--card)',
            }}
          >
            <strong style={{ fontSize: 14, color: 'var(--ink)' }}>
              Sign in to load your runs.
            </strong>
            <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              Browse apps or preview how this page works without signing in.
            </span>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link
                to="/login?next=%2Fme"
                style={{
                  padding: '9px 16px',
                  background: 'var(--ink)',
                  color: '#fff',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Sign in
              </Link>
              <Link
                to="/apps"
                style={{
                  padding: '9px 16px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: 'none',
                  color: 'var(--ink)',
                }}
              >
                Browse apps
              </Link>
            </div>
          </section>
        )}

        {/* Your apps preview — first 4 distinct slugs from run history.
            Full apps + published grid on /me/apps. */}
        <section data-testid="me-apps-preview" aria-label="Your apps preview">
          <header style={s.sectionHeader}>
            <h2 style={s.sectionH2}>Your apps</h2>
            <Link to="/me/apps" data-testid="me-apps-see-all" style={s.headerLink}>
              See all →
            </Link>
          </header>

          {usedApps === null ? (
            <div style={{ ...s.card, padding: 18, color: 'var(--muted)', fontSize: 13, marginBottom: 36 }}>
              Loading your apps…
            </div>
          ) : usedApps.length === 0 ? (
            <div
              data-testid="me-apps-preview-empty"
              style={{
                border: '1px dashed var(--line)',
                borderRadius: 12,
                background: 'var(--card)',
                padding: '22px 20px',
                textAlign: 'center' as const,
                marginBottom: 36,
              }}
            >
              <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
                Nothing here yet. Try one from the public directory to get started.
              </div>
              <Link
                to="/apps"
                style={{
                  display: 'inline-block',
                  padding: '9px 16px',
                  background: 'var(--ink)',
                  color: '#fff',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Browse apps →
              </Link>
            </div>
          ) : (
            <div data-testid="me-apps-preview-grid" style={s.appsGrid}>
              {usedApps.map((a) => (
                <ToolTile
                  key={a.slug}
                  slug={a.slug}
                  name={a.name}
                  lastUsedAt={a.lastUsedAt}
                />
              ))}
            </div>
          )}
        </section>

        {/* Recent runs preview — most-recent 5. Full history on /me/runs. */}
        <section id="recent-runs" data-testid="me-runs-preview" aria-label="Recent runs">
          <header style={s.sectionHeader}>
            <h2 style={s.sectionH2}>Recent runs</h2>
            <Link to="/me/runs" data-testid="me-runs-see-all" style={s.headerLink}>
              See all →
            </Link>
          </header>

          {runs === null && !runsError ? (
            <div style={{ ...s.card, padding: 18, color: 'var(--muted)', fontSize: 13 }}>
              Loading runs…
            </div>
          ) : runsError ? (
            <ErrorPanel message={runsError} />
          ) : recentRuns.length === 0 ? (
            <EmptyRuns signedOutPreview={signedOutPreview} />
          ) : (
            <div data-testid="me-runs-preview-list" style={s.card}>
              {recentRuns.map((run, i) => (
                <RunRow
                  key={run.id}
                  run={run}
                  onOpen={openRun}
                  isLast={i === recentRuns.length - 1}
                />
              ))}
            </div>
          )}
        </section>

        {/* Footer affordance: let users re-trigger the onboarding tour. */}
        <div data-testid="me-restart-tour" style={s.footerLink}>
          <button
            type="button"
            onClick={() => {
              resetOnboarding();
              setTourOpen(true);
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--muted)',
              textDecoration: 'underline',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          >
            Restart tour
          </button>
        </div>
      </div>

      {tourOpen && <Tour onClose={closeTour} />}
      <WaitlistModal
        open={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
        source="me-publish"
      />
    </MeLayout>
  );
}

/* ---------- subcomponents ---------- */

function StatCard({
  testid,
  label,
  value,
  hint,
  accent = false,
}: {
  testid: string;
  label: string;
  value: string;
  hint?: string;
  /** When true, highlight the value in brand green (for BYOK=connected). */
  accent?: boolean;
}) {
  return (
    <section
      data-testid={testid}
      style={{
        ...s.statCard,
        borderColor: accent ? 'var(--accent, #10b981)' : 'var(--line)',
        background: accent ? 'rgba(16, 185, 129, 0.06)' : 'var(--card)',
      }}
    >
      <span style={s.statLabel}>{label}</span>
      <strong
        style={{
          ...s.statValue,
          color: accent ? 'var(--accent, #10b981)' : 'var(--ink)',
        }}
      >
        {value}
      </strong>
      {hint ? <p style={s.statHint}>{hint}</p> : null}
    </section>
  );
}

function RunRow({
  run,
  onOpen,
  isLast,
}: {
  run: MeRunSummary;
  onOpen: (run: MeRunSummary) => void;
  isLast: boolean;
}) {
  const [rowHover, setRowHover] = useState(false);
  const appName = run.app_name || run.app_slug || 'App';
  const summary = runSummary(run);
  const outPreview = runOutputPreviewLine(run);
  const previewLine = [summary, outPreview].filter(Boolean).join(' → ');
  const time = formatTime(run.started_at);
  const runTag = runIdShort(run.id);
  const disabled = !run.app_slug;
  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      disabled={disabled}
      data-testid={`me-run-row-${run.id}`}
      onMouseEnter={() => setRowHover(true)}
      onMouseLeave={() => setRowHover(false)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        minHeight: 56,
        border: 'none',
        borderBottom: isLast ? 'none' : '1px solid var(--line)',
        background:
          rowHover && !disabled
            ? 'color-mix(in srgb, var(--line) 32%, transparent)'
            : 'transparent',
        transition: 'background 0.12s ease',
        textAlign: 'left' as const,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        color: 'var(--ink)',
      }}
    >
      <MeRunStatusPill status={run.status} />
      {run.app_slug && (
        <span aria-hidden style={s.appIconWrap}>
          <AppIcon slug={run.app_slug} size={14} />
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            fontSize: 14,
            minWidth: 0,
            width: '100%',
          }}
        >
          <span
            style={{
              fontWeight: 600,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 'min(200px, 40%)',
              flexShrink: 0,
            }}
          >
            {appName}
          </span>
          {previewLine ? (
            <span
              style={{
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
              }}
            >
              {previewLine}
            </span>
          ) : null}
        </div>
      </div>
      <span
        data-testid={`me-run-tag-${run.id}`}
        aria-hidden="true"
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          flexShrink: 0,
          fontFamily: 'JetBrains Mono, monospace',
          fontVariantNumeric: 'tabular-nums',
          marginRight: 8,
          opacity: 0.75,
        }}
      >
        {runTag}
      </span>
      <span
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {time}
      </span>
    </button>
  );
}

function MeRunStatusPill({ status }: { status: RunStatus }) {
  if (status === 'success') {
    return (
      <span
        aria-label="Status: success"
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase' as const,
          padding: '3px 6px',
          borderRadius: 4,
          background: 'rgba(4, 120, 87, 0.12)',
          color: 'var(--accent, #047857)',
        }}
      >
        OK
      </span>
    );
  }
  if (status === 'error' || status === 'timeout') {
    return (
      <span
        aria-label={`Status: ${status}`}
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase' as const,
          padding: '3px 6px',
          borderRadius: 4,
          background: '#fdecea',
          color: '#c2321f',
        }}
      >
        Error
      </span>
    );
  }
  return (
    <span
      aria-label={`Status: ${status}`}
      style={{
        flexShrink: 0,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.03em',
        textTransform: 'uppercase' as const,
        padding: '3px 6px',
        borderRadius: 4,
        background: 'color-mix(in srgb, var(--muted) 12%, transparent)',
        color: 'var(--muted)',
      }}
    >
      {status === 'running' ? 'Run' : '…'}
    </span>
  );
}

function WelcomeBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="status" data-testid="me-welcome-banner" style={s.welcome}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.55 }}>
        <strong style={{ color: 'var(--accent)' }}>Welcome to Floom</strong>
        <span style={{ display: 'block', marginTop: 4 }}>
          Try an app below, or{' '}
          <Link to="/apps" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
            browse the directory
          </Link>{' '}
          to get started.
        </span>
      </div>
      <button
        type="button"
        aria-label="Dismiss welcome"
        data-testid="me-welcome-dismiss"
        onClick={onDismiss}
        style={s.noticeDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

function AppNotFound({
  slug,
  onDismiss,
}: {
  slug: string | null;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" data-testid="me-app-not-found-notice" style={s.notice}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.55 }}>
        <strong style={{ color: '#c2321f' }}>App not found</strong>
        <span style={{ display: 'block', marginTop: 4 }}>
          We couldn&rsquo;t open that app
          {slug ? (
            <>
              {' '}
              (
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>
                {slug}
              </span>
              )
            </>
          ) : (
            ''
          )}
          . It may have been removed or you don&rsquo;t have access.
        </span>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        data-testid="me-app-not-found-dismiss"
        onClick={onDismiss}
        style={s.noticeDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <section
      data-testid="me-runs-error"
      style={{
        border: '1px solid #f4b7b1',
        borderRadius: 12,
        background: '#fdecea',
        padding: '16px 20px',
        color: '#5c2d26',
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      <strong style={{ color: '#c2321f' }}>Couldn&rsquo;t load runs.</strong> {message}
    </section>
  );
}

function EmptyRuns({ signedOutPreview = false }: { signedOutPreview?: boolean }) {
  return (
    <section
      data-testid="me-runs-empty"
      style={{
        border: '1px dashed var(--line)',
        borderRadius: 12,
        background: 'var(--card)',
        padding: '32px 24px',
        textAlign: 'center' as const,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: '-0.025em',
          color: 'var(--ink)',
          marginBottom: 8,
        }}
      >
        {signedOutPreview ? 'Sign in to see your runs.' : 'No runs yet.'}
      </div>
      <p
        style={{
          margin: '0 auto 18px',
          color: 'var(--muted)',
          fontSize: 14,
          lineHeight: 1.55,
          maxWidth: 380,
        }}
      >
        {signedOutPreview
          ? 'Your run history appears here after you sign in.'
          : 'Run any Floom app and it will show up here.'}
      </p>
      <Link
        to="/apps"
        data-testid="me-empty-browse"
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
        Browse apps →
      </Link>
    </section>
  );
}

/* ---------- helpers (ported from prior MePage) ---------- */

function runIdShort(id: string | null | undefined): string {
  if (!id) return '';
  const trimmed = id.replace(/^run_/, '');
  return trimmed.slice(0, 8);
}

function runOutputPreviewLine(run: MeRunSummary): string | null {
  const o = run.outputs;
  if (o == null || o === '') return null;
  if (typeof o === 'string') {
    const t = o.replace(/\s+/g, ' ').trim();
    return t ? truncate(t, 72) : null;
  }
  if (typeof o === 'object' && o !== null && !Array.isArray(o)) {
    const rec = o as Record<string, unknown>;
    const direct =
      typeof rec['text'] === 'string'
        ? rec['text']
        : typeof rec['message'] === 'string'
          ? rec['message']
          : typeof rec['result'] === 'string'
            ? rec['result']
            : null;
    if (direct && String(direct).trim()) {
      return truncate(String(direct).replace(/\s+/g, ' ').trim(), 72);
    }
  }
  try {
    const raw = JSON.stringify(o);
    if (raw.length <= 80) return raw;
    return `${raw.slice(0, 77)}…`;
  } catch {
    return null;
  }
}

function runSummary(run: MeRunSummary): string | null {
  const inputs = run.inputs;
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    const prompt = inputs['prompt'];
    if (typeof prompt === 'string' && prompt.trim()) {
      return truncate(prompt.trim(), 90);
    }
    for (const value of Object.values(inputs)) {
      if (typeof value === 'string' && value.trim()) {
        return truncate(value.trim(), 90);
      }
    }
    const entries = Object.entries(inputs).filter(
      ([, v]) => v !== null && (typeof v === 'number' || typeof v === 'boolean'),
    );
    if (entries.length > 0) {
      const [k, v] = entries[0];
      return truncate(`${k}: ${v}`, 90);
    }
    const keyCount = Object.keys(inputs).length;
    if (keyCount > 0) return `${keyCount} input${keyCount === 1 ? '' : 's'}`;
  }
  if (run.action && run.action !== 'run') return run.action;
  return null;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}
