import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppIcon } from '../components/AppIcon';
import { MeLayout } from '../components/me/MeLayout';
import { ToolTile } from '../components/me/ToolTile';
import { buildRerunHref, runPreviewText } from '../components/me/runPreview';
import { useMeCompactLayout } from '../components/me/useMeCompactLayout';
import { Tour } from '../components/onboarding/Tour';
import { hasOnboarded } from '../lib/onboarding';
import { useSession, clearSession, refreshSession } from '../hooks/useSession';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;
const APP_PREVIEW_LIMIT = 6;
const RECENT_RUNS_PREVIEW = 5;

const s: Record<string, CSSProperties> = {
  section: {
    marginBottom: 30,
  },
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
  sectionCopy: {
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
  card: {
    border: '1px solid var(--line)',
    borderRadius: 20,
    background: 'var(--card)',
    boxShadow: '0 1px 0 rgba(17, 24, 39, 0.02)',
  },
  appsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 14,
  },
  tableWrap: {
    overflow: 'hidden',
  },
  tableHeader: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 0.95fr) minmax(0, 1.35fr) auto',
    gap: 12,
    padding: '12px 52px 12px 18px',
    borderBottom: '1px solid var(--line)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: 'var(--muted)',
    background: 'rgba(250, 248, 243, 0.82)',
  },
  runRowWrap: {
    position: 'relative',
    borderBottom: '1px solid var(--line)',
  },
  runRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 0.95fr) minmax(0, 1.35fr) auto',
    gap: 12,
    alignItems: 'center',
    padding: '15px 52px 15px 18px',
    textDecoration: 'none',
    color: 'var(--ink)',
  },
  runRerun: {
    position: 'absolute',
    top: '50%',
    right: 14,
    transform: 'translateY(-50%)',
    width: 30,
    height: 30,
    borderRadius: 999,
    border: '1px solid var(--line)',
    background: 'rgba(255,255,255,0.92)',
    color: 'var(--muted)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    textDecoration: 'none',
    cursor: 'pointer',
    transition: 'opacity .12s, color .12s, border-color .12s',
  },
  runRerunCompact: {
    position: 'static',
    transform: 'none',
    flexShrink: 0,
  },
  appCell: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  appIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    background: 'rgba(250, 248, 243, 0.92)',
    border: '1px solid var(--line)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  appName: {
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1.3,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  previewText: {
    fontSize: 13.5,
    lineHeight: 1.55,
    color: 'var(--muted)',
    minWidth: 0,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
  },
  whenText: {
    fontSize: 12.5,
    lineHeight: 1.4,
    color: 'var(--muted)',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right' as const,
    whiteSpace: 'nowrap' as const,
  },
  emptyCard: {
    ...{
      border: '1px solid var(--line)',
      borderRadius: 24,
      background:
        'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,248,243,0.94) 100%)',
      boxShadow: '0 1px 0 rgba(17, 24, 39, 0.02)',
    },
    padding: '40px 28px',
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
  primaryButton: {
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
  settingsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    paddingTop: 20,
    borderTop: '1px solid var(--line)',
    flexWrap: 'wrap',
  },
  settingsLink: {
    fontSize: 13.5,
    fontWeight: 600,
    color: 'var(--muted)',
    textDecoration: 'none',
  },
  settingsSeparator: {
    fontSize: 13.5,
    color: 'var(--muted)',
  },
  settingsButton: {
    padding: 0,
    border: 'none',
    background: 'none',
    fontSize: 13.5,
    fontWeight: 600,
    color: 'var(--muted)',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '12px 16px',
    marginBottom: 20,
    borderRadius: 14,
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
    borderRadius: 14,
    border: '1px solid rgba(4, 120, 87, 0.18)',
    background: 'rgba(236, 253, 245, 0.9)',
    color: 'var(--ink)',
  },
  noticeDismiss: {
    flexShrink: 0,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--ink)',
    background: 'rgba(255,255,255,0.72)',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: 999,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};

export function MePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: sessionData, loading: sessionLoading, error: sessionError } = useSession();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const compactLayout = useMeCompactLayout();

  const sessionPending = sessionLoading || (sessionData === null && !sessionError);
  const signedOutPreview = !!sessionData && sessionData.cloud_mode && sessionData.user.is_local;
  const canLoadPersonalData = !signedOutPreview;

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

  const showNotice = searchParams.get('notice') === 'app_not_found';
  const noticeSlug = searchParams.get('slug');
  const showWelcome = searchParams.get('welcome') === '1';
  const forceTour = searchParams.get('tour') === '1';

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

  const previewApps = useMemo(() => {
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
      if (seen.size >= APP_PREVIEW_LIMIT) break;
    }
    return Array.from(seen.values());
  }, [runs]);

  const recentRuns = useMemo(
    () => (runs ? runs.slice(0, RECENT_RUNS_PREVIEW) : []),
    [runs],
  );

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

  function closeTour() {
    setTourOpen(false);
    if (forceTour) {
      const next = new URLSearchParams(searchParams);
      next.delete('tour');
      setSearchParams(next, { replace: true });
    }
  }

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api.signOut();
    } catch {
      // Clear local auth state even if the network request fails.
    }
    clearSession();
    await refreshSession();
    navigate('/', { replace: true });
  }

  return (
    <MeLayout
      title="Me · Floom"
      allowSignedOutShell={signedOutPreview}
      headerVariant="inline"
    >
      <div data-testid="me-page">
        {showWelcome && <WelcomeBanner onDismiss={dismissWelcome} />}
        {showNotice && <AppNotFound slug={noticeSlug} onDismiss={dismissNotice} />}

        {runsError ? (
          <ErrorPanel message={runsError} />
        ) : (
          <>
            <section data-testid="me-apps-preview" aria-label="Your apps preview" style={s.section}>
              <header style={s.sectionHeader}>
                <div>
                  <h2 style={s.sectionH2}>Your apps</h2>
                  <p style={s.sectionCopy}>
                    Re-run the apps you already know, without digging through the store.
                  </p>
                </div>
                <Link to="/me/apps" data-testid="me-apps-see-all" style={s.headerLink}>
                  See all →
                </Link>
              </header>

              {previewApps === null ? (
                <div style={{ ...s.card, padding: 18, color: 'var(--muted)', fontSize: 13.5 }}>
                  Loading your apps…
                </div>
              ) : previewApps.length === 0 ? (
                <HomeEmptyState signedOutPreview={signedOutPreview} testId="me-apps-preview-empty" />
              ) : (
                <div
                  data-testid="me-apps-preview-grid"
                  style={{
                    ...s.appsGrid,
                    gridTemplateColumns: compactLayout
                      ? 'minmax(0, 1fr)'
                      : (s.appsGrid.gridTemplateColumns as string),
                  }}
                >
                  {previewApps.map((app) => (
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

            {(runs === null || recentRuns.length > 0) && (
              <section id="recent-runs" data-testid="me-runs-preview" aria-label="Recent runs">
                <header style={s.sectionHeader}>
                  <div>
                    <h2 style={s.sectionH2}>Recent runs</h2>
                    <p style={s.sectionCopy}>
                      The last few things you ran across every app.
                    </p>
                  </div>
                  <Link to="/me/runs" data-testid="me-runs-see-all" style={s.headerLink}>
                    See all →
                  </Link>
                </header>

                {runs === null ? (
                  <div style={{ ...s.card, padding: 18, color: 'var(--muted)', fontSize: 13.5 }}>
                    Loading runs…
                  </div>
                ) : (
                  <div data-testid="me-runs-preview-list" style={{ ...s.card, ...s.tableWrap }}>
                    {!compactLayout ? (
                      <div style={s.tableHeader}>
                        <span>App</span>
                        <span>Output preview</span>
                        <span style={{ textAlign: 'right' }}>When</span>
                      </div>
                    ) : null}
                    {recentRuns.map((run, index) => (
                      <HomeRunRow
                        key={run.id}
                        run={run}
                        isLast={index === recentRuns.length - 1}
                        compact={compactLayout}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            <div style={s.settingsRow}>
              <Link to="/me/secrets" style={s.settingsLink}>
                API keys
              </Link>
              <span aria-hidden style={s.settingsSeparator}>
                ·
              </span>
              <Link to="/me/settings" style={s.settingsLink}>
                Profile
              </Link>
              <span aria-hidden style={s.settingsSeparator}>
                ·
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                data-testid="me-sign-out"
                disabled={signingOut}
                style={s.settingsButton}
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </>
        )}
      </div>

      {tourOpen ? <Tour onClose={closeTour} /> : null}
    </MeLayout>
  );
}

function HomeRunRow({
  run,
  isLast,
  compact,
}: {
  run: MeRunSummary;
  isLast: boolean;
  compact: boolean;
}) {
  const appName = run.app_name || run.app_slug || 'App';
  const href = `/r/${encodeURIComponent(run.id)}`;
  const rerunHref = run.app_slug
    ? buildRerunHref(run.app_slug, run.id, run.action)
    : null;

  return (
    <div
      style={{
        ...s.runRowWrap,
        borderBottom: isLast ? 'none' : s.runRowWrap.borderBottom,
        display: compact ? 'flex' : 'block',
        alignItems: compact ? 'center' : undefined,
        gap: compact ? 12 : undefined,
        padding: compact ? '15px 18px' : undefined,
      }}
      onMouseEnter={(e) => {
        const btn = e.currentTarget.querySelector<HTMLAnchorElement>(
          '[data-rerun-btn]',
        );
        if (btn) btn.style.opacity = '1';
      }}
      onMouseLeave={(e) => {
        const btn = e.currentTarget.querySelector<HTMLAnchorElement>(
          '[data-rerun-btn]',
        );
        if (btn && !compact) btn.style.opacity = '0';
      }}
    >
      <Link
        to={href}
        data-testid={`me-run-row-${run.id}`}
        style={{
          ...s.runRow,
          gridTemplateColumns: compact
            ? 'minmax(0, 1fr)'
            : (s.runRow.gridTemplateColumns as string),
          padding: compact ? 0 : s.runRow.padding,
          flex: compact ? 1 : undefined,
          minWidth: compact ? 0 : undefined,
        }}
      >
        <div style={s.appCell}>
          {run.app_slug ? (
            <span aria-hidden style={s.appIconWrap}>
              <AppIcon slug={run.app_slug} size={16} />
            </span>
          ) : null}
          <span style={s.appName}>{appName}</span>
        </div>
        <span style={s.previewText}>{runPreviewText(run)}</span>
        <span
          style={{
            ...s.whenText,
            textAlign: compact ? 'left' : s.whenText.textAlign,
            whiteSpace: compact ? 'normal' : s.whenText.whiteSpace,
          }}
        >
          {formatTime(run.started_at)}
        </span>
      </Link>
      {rerunHref ? (
        <Link
          to={rerunHref}
          data-rerun-btn
          data-testid={`me-run-rerun-${run.id}`}
          aria-label={`Re-run ${appName}`}
          title={`Re-run ${appName}`}
          style={{
            ...s.runRerun,
            ...(compact ? s.runRerunCompact : {}),
            opacity: compact ? 1 : 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--accent)';
            e.currentTarget.style.borderColor = 'var(--accent)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--muted)';
            e.currentTarget.style.borderColor = 'var(--line)';
          }}
          onFocus={(e) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.color = 'var(--accent)';
            e.currentTarget.style.borderColor = 'var(--accent)';
          }}
          onBlur={(e) => {
            if (!compact) e.currentTarget.style.opacity = '0';
            e.currentTarget.style.color = 'var(--muted)';
            e.currentTarget.style.borderColor = 'var(--line)';
          }}
        >
          <RerunIcon />
        </Link>
      ) : null}
    </div>
  );
}

function RerunIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="1.5 3 1.5 7.5 6 7.5" />
      <path d="M3.2 11A6 6 0 1 0 4.6 4.4L1.5 7.5" />
    </svg>
  );
}

function WelcomeBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div role="status" data-testid="me-welcome-banner" style={s.welcome}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--accent)' }}>Welcome to Floom</strong>
        <span style={{ display: 'block', marginTop: 4 }}>
          Browse the app store, try something useful, and your recent activity will land here.
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
      <div style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.6 }}>
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
          ) : null}
          . It may have been removed or you may not have access anymore.
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
        borderRadius: 16,
        background: '#fdecea',
        padding: '16px 20px',
        color: '#5c2d26',
        fontSize: 13.5,
        lineHeight: 1.6,
      }}
    >
      <strong style={{ color: '#c2321f' }}>Couldn&rsquo;t load your dashboard.</strong> {message}
    </section>
  );
}

function HomeEmptyState({
  signedOutPreview = false,
  testId = 'me-runs-empty',
}: {
  signedOutPreview?: boolean;
  testId?: string;
}) {
  return (
    <section data-testid={testId} style={s.emptyCard}>
      <h2 style={s.emptyTitle}>Nothing here yet.</h2>
      <p style={s.emptyBody}>
        {signedOutPreview
          ? 'Try one from the public directory and your recent activity will show up here after you sign in.'
          : 'Try one from the public directory.'}
      </p>
      <Link to="/apps" data-testid="me-empty-browse" style={s.primaryButton}>
        Browse apps →
      </Link>
    </section>
  );
}
