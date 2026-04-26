// /me — v23 apps-led 5-section IA. Federico-locked 2026-04-26.
//
// Section order (top → bottom):
//   1. Greeting + stats subtitle
//   2. Primary nav strip (Apps · Runs · BYOK keys · Agent tokens · Settings + Browse the store)
//   3. Your apps grid (with banner pattern, neutral palette only)
//   4. Running now + scheduled (rendered only when there's data)
//   5. Recent runs compact (5 rows, category-tinted icons per app)
//   6. Agent tokens demoted CTA (.muted-section)
//
// Vocabulary (Federico-locked): "BYOK keys" + "Agent tokens" — never
// "API keys". The legacy footer row of API keys · Profile · Sign out
// has been removed; those links live in the primary nav strip + the
// avatar dropdown (TopBar.tsx, already on main).
//
// Banner palette: NEUTRAL ONLY. The .banner-research / .banner-content /
// .banner-writing / .banner-travel class names appear on the markup for
// parity with the wireframe + the apps-cards roadmap, but every banner
// resolves to the same neutral gradient (var(--studio) → var(--card)).
// Run-row icons DO carry per-app cat-* tints — that's the identity
// marker in a long list and it's allowed.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppIcon } from '../components/AppIcon';
import { MeLayout } from '../components/me/MeLayout';
import { runPreviewText } from '../components/me/runPreview';
import { Tour } from '../components/onboarding/Tour';
import { hasOnboarded } from '../lib/onboarding';
import { useSession, clearSession, refreshSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
import * as api from '../api/client';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;
const APP_PREVIEW_LIMIT = 5;
const RECENT_RUNS_PREVIEW = 5;

/**
 * App-slug → category mapping for run-row tints (per the v23 wireframe
 * + the launch-day brief). The /me banner pattern stays neutral; only
 * the run-row icon bubble carries category. Unknown slugs render with
 * no tint (default neutral icon).
 */
const APP_CATEGORY: Record<string, 'research' | 'writing' | 'content' | 'travel'> = {
  'competitor-lens': 'research',
  'ai-readiness-audit': 'research',
  'pitch-coach': 'writing',
  opendraft: 'content',
  flyfast: 'travel',
};

/**
 * Banner content per app slug — matches v23 wireframe + the /apps PR
 * roster (competitor-lens, ai-readiness-audit, pitch-coach). The
 * banner is the run-result preview shape, not a runtime metric.
 * Unknown slugs fall back to a generic banner with the slug + a
 * single line derived from the latest run preview.
 */
type BannerLine = { text: string; tone?: 'dim' | 'accent' };
const BANNER_CONTENT: Record<string, { title: string; lines: BannerLine[] }> = {
  'competitor-lens': {
    title: 'competitor-lens',
    lines: [
      { text: 'stripe vs adyen' },
      { text: 'fee 1.4% vs 1.6%', tone: 'dim' },
      { text: 'winner: stripe', tone: 'accent' },
    ],
  },
  'ai-readiness-audit': {
    title: 'ai-readiness',
    lines: [
      { text: 'floom.dev' },
      { text: 'score: 8.4/10', tone: 'dim' },
      { text: '3 risks · 3 wins', tone: 'accent' },
    ],
  },
  'pitch-coach': {
    title: 'pitch-coach',
    lines: [
      { text: 'harsh truth' },
      { text: '3 critiques', tone: 'dim' },
      { text: '3 rewrites', tone: 'accent' },
    ],
  },
};

const s: Record<string, CSSProperties> = {
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
  const { apps: myApps } = useMyApps();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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

  /**
   * Aggregated info per app slug from the user's run history.
   * Drives the Your-apps grid: name, last-run timestamp, total run
   * count, and the prefill ID for the Run-again link.
   */
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
        runCount: number;
      }
    >();
    for (const run of runs) {
      if (!run.app_slug) continue;
      const existing = seen.get(run.app_slug);
      if (existing) {
        existing.runCount += 1;
        continue;
      }
      seen.set(run.app_slug, {
        slug: run.app_slug,
        name: run.app_name || run.app_slug,
        lastUsedAt: run.started_at,
        lastRunId: run.id,
        lastRunAction: run.action,
        runCount: 1,
      });
    }
    return Array.from(seen.values()).slice(0, APP_PREVIEW_LIMIT);
  }, [runs]);

  const recentRuns = useMemo(
    () => (runs ? runs.slice(0, RECENT_RUNS_PREVIEW) : []),
    [runs],
  );

  /** Currently-running runs surfaced from the same /api/me/runs payload.
   * Backend doesn't yet expose a separate "scheduled" / "triggers"
   * collection, so the section renders only when there's a live
   * `running` or `pending` row. Empty → section is invisible
   * (Federico-locked Flag #2 default: option A). */
  const runningRuns = useMemo(() => {
    if (runs === null) return [];
    return runs.filter((r) => r.status === 'running' || r.status === 'pending');
  }, [runs]);

  /** Greeting subtitle counts. We bind real values where the API
   * supports it: apps installed comes from useMyApps (creator-side
   * installs) OR previewApps.length (consumer-side: apps the user
   * has actually run); pick whichever is larger so the count is
   * never wrong-direction. Total runs comes from runs.length (capped
   * at FETCH_LIMIT). Running-now is runningRuns.length. */
  const stats = useMemo(() => {
    const installedFromApps = myApps?.length ?? 0;
    const installedFromRuns = previewApps?.length ?? 0;
    const apps = Math.max(installedFromApps, installedFromRuns);
    const totalRuns = runs?.length ?? 0;
    const running = runningRuns.length;
    return { apps, totalRuns, running };
  }, [myApps, previewApps, runs, runningRuns]);

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
  // Sign-out callback retained for the Tour component (which can also
  // surface a "Sign out" affordance during onboarding). The legacy
  // footer-row trigger is removed from the page itself.
  void handleSignOut;

  const greetingName = greetingFirstName(sessionData?.user);
  const greetingHeading = greetingName ? `Hi, ${greetingName}.` : 'Hi, there.';
  const subtitleText = formatStatsSubtitle(stats);

  return (
    <MeLayout
      title="My account · Floom"
      allowSignedOutShell={signedOutPreview}
      headerVariant="none"
    >
      <div className="me-page" data-testid="me-page">
        <div className="me-greet" data-testid="me-greet">
          <h1 data-testid="me-greeting-name">{greetingHeading}</h1>
          <p data-testid="me-greeting-subtitle">{subtitleText}</p>
        </div>

        {showWelcome && !subtitleText && <WelcomeBanner onDismiss={dismissWelcome} />}
        {showNotice && <AppNotFound slug={noticeSlug} onDismiss={dismissNotice} />}

        {runsError ? (
          <ErrorPanel message={runsError} />
        ) : (
          <main>
            {/* 1 — Primary nav strip */}
            <nav
              className="me-primary-nav"
              data-testid="me-primary-nav"
              aria-label="My account primary nav"
            >
              <Link to="/me/apps" data-testid="me-nav-apps">
                Apps <span className="ct">{stats.apps}</span>
              </Link>
              <Link to="/me/runs" data-testid="me-nav-runs">
                Runs <span className="ct">{stats.totalRuns}</span>
              </Link>
              <Link to="/me/secrets" data-testid="me-nav-byok">
                BYOK keys
              </Link>
              <Link to="/me/agent-keys" data-testid="me-nav-agent-tokens">
                Agent tokens
              </Link>
              <Link to="/me/settings" data-testid="me-nav-settings">
                Settings
              </Link>
              <Link to="/apps" className="browse-store" data-testid="me-nav-browse-store">
                Browse the store →
              </Link>
            </nav>

            {/* 2 — Your apps */}
            <section
              className="your-apps-section"
              data-testid="me-apps-preview"
              data-section="your-apps"
              aria-label="Your apps"
              id="your-apps"
            >
              <h2>Your apps</h2>
              <p className="lede">
                {previewApps && previewApps.length > 0
                  ? `${previewApps.length} installed. Pinned to /me, available in Claude.`
                  : 'Pinned to /me, available in Claude.'}
              </p>

              {previewApps === null ? (
                <div
                  data-testid="me-apps-preview-loading"
                  style={{
                    padding: 18,
                    color: 'var(--muted)',
                    fontSize: 13.5,
                    border: '1px solid var(--line)',
                    borderRadius: 14,
                    background: 'var(--card)',
                  }}
                >
                  Loading your apps…
                </div>
              ) : previewApps.length === 0 ? (
                <HomeEmptyState signedOutPreview={signedOutPreview} testId="me-apps-preview-empty" />
              ) : (
                <>
                  <div className="your-apps-grid" data-testid="me-apps-preview-grid">
                    {previewApps.map((app) => (
                      <AppCard
                        key={app.slug}
                        slug={app.slug}
                        name={app.name}
                        lastUsedAt={app.lastUsedAt}
                        runCount={app.runCount}
                        latestRun={
                          recentRuns.find((r) => r.app_slug === app.slug) ?? null
                        }
                      />
                    ))}
                  </div>
                  <div className="your-apps-foot" data-testid="me-apps-foot">
                    <Link to="/me/apps">Show all {stats.apps} →</Link>
                    <Link to="/apps">Browse the store →</Link>
                  </div>
                </>
              )}
            </section>

            {/* 3 — Running now + scheduled (conditional render) */}
            {runningRuns.length > 0 && (
              <section
                className="running-section"
                data-testid="me-running-section"
                aria-label="Running now and scheduled"
                id="whats-running"
              >
                <h2>Running now + scheduled</h2>
                <div className="running-card" data-testid="me-running-card">
                  {runningRuns.slice(0, 5).map((run) => (
                    <RunningRow key={run.id} run={run} />
                  ))}
                </div>
              </section>
            )}

            {/* 4 — Recent runs compact */}
            {(runs === null || recentRuns.length > 0) && (
              <section
                className="recent-runs-compact"
                id="recent-runs-compact"
                data-testid="me-runs-preview"
                aria-label="Recent runs"
              >
                <div className="runs-compact-card" data-testid="me-runs-preview-list">
                  <header>
                    <span>
                      Recent runs · last {Math.min(RECENT_RUNS_PREVIEW, recentRuns.length || RECENT_RUNS_PREVIEW)}
                    </span>
                    <Link to="/me/runs" data-testid="me-runs-see-all">
                      See all{stats.totalRuns ? ` ${stats.totalRuns}` : ''} →
                    </Link>
                  </header>
                  {runs === null ? (
                    <div
                      style={{
                        padding: 18,
                        color: 'var(--muted)',
                        fontSize: 13.5,
                      }}
                    >
                      Loading runs…
                    </div>
                  ) : (
                    recentRuns.map((run) => <RunRow key={run.id} run={run} />)
                  )}
                </div>
              </section>
            )}

            {/* 5 — Agent tokens demoted CTA */}
            <section
              className="muted-section"
              id="agent-tokens-cta"
              data-testid="me-agent-tokens-cta"
              aria-label="Agent tokens"
            >
              <div>
                <h3>Use Floom from Claude, Cursor, or your CLI</h3>
                <p>
                  One token works across MCP, REST, CLI. Scope it to read, run, publish, or
                  update secrets.
                </p>
              </div>
              <Link to="/me/agent-keys" data-testid="me-agent-tokens-link">
                Manage agent tokens →
              </Link>
            </section>
          </main>
        )}
      </div>

      {tourOpen ? <Tour onClose={closeTour} /> : null}
    </MeLayout>
  );
}

/**
 * Your-apps card — v23 banner pattern. Neutral palette only (Federico-
 * locked). The .banner-{research,writing,content,travel} class is set
 * on the markup for wireframe parity but every variant resolves to the
 * same neutral gradient via wireframe.css.
 */
function AppCard({
  slug,
  name,
  lastUsedAt,
  runCount,
  latestRun,
}: {
  slug: string;
  name: string;
  lastUsedAt: string | null;
  runCount: number;
  latestRun: MeRunSummary | null;
}) {
  const category = APP_CATEGORY[slug] ?? null;
  const bannerVariant = category ? `banner-${category}` : 'banner-research';
  const lastRel = lastUsedAt ? formatRelative(lastUsedAt) : null;
  const meta = lastRel
    ? `last run ${lastRel} · ${runCount} run${runCount === 1 ? '' : 's'}`
    : `${runCount} run${runCount === 1 ? '' : 's'}`;

  return (
    <Link
      to={`/p/${slug}`}
      className="ya-card"
      data-testid={`me-app-card-${slug}`}
    >
      <div className="ya-head">
        <span aria-hidden className="ya-icon">
          <AppIcon slug={slug} size={18} />
        </span>
        <div>
          <div className="ya-name">{name}</div>
          <div className="ya-meta">{meta}</div>
        </div>
      </div>
      <div
        className={`app-banner ${bannerVariant}`}
        data-testid={`me-app-banner-${slug}`}
      >
        <BannerCard slug={slug} latestRun={latestRun} />
      </div>
      <span className="ya-cta">Run again →</span>
    </Link>
  );
}

function BannerCard({
  slug,
  latestRun,
}: {
  slug: string;
  latestRun: MeRunSummary | null;
}) {
  const content = BANNER_CONTENT[slug] ?? {
    title: slug,
    lines: latestRun
      ? [
          {
            text: truncateBanner(runPreviewText(latestRun)),
            tone: 'dim' as const,
          },
        ]
      : [{ text: `${slug}`, tone: 'dim' as const }],
  };
  return (
    <div className="banner-card">
      <span className="banner-title">{content.title}</span>
      {content.lines.map((line, idx) => (
        <span
          key={idx}
          className={`banner-line${line.tone ? ` ${line.tone}` : ''}`}
        >
          {line.text}
        </span>
      ))}
    </div>
  );
}

function truncateBanner(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 32) return clean;
  return `${clean.slice(0, 31).trimEnd()}…`;
}

/**
 * Recent-runs row — compact pattern with category-tinted icon, rich
 * .nm line built from the same runPreviewText helper as the legacy
 * row, meta row, and a duration pill.
 */
function RunRow({ run }: { run: MeRunSummary }) {
  const appSlug = run.app_slug || '';
  const appName = run.app_name || run.app_slug || 'App';
  const category = appSlug ? APP_CATEGORY[appSlug] : undefined;
  const href = `/r/${encodeURIComponent(run.id)}`;

  const isFail = run.status === 'error' || run.status === 'timeout';
  const dur = formatDuration(run.duration_ms);
  const rel = formatRelative(run.started_at);
  const preview = runPreviewText(run);
  const nm = appSlug
    ? `${appSlug} · ${preview}`
    : preview;

  return (
    <Link
      to={href}
      className="run-row"
      data-testid={`me-run-row-${run.id}`}
    >
      <div className={`ic${category ? ` cat-${category}` : ''}`}>
        {appSlug ? <AppIcon slug={appSlug} size={16} /> : null}
      </div>
      <div className="body">
        <div className="nm" title={nm}>{nm}</div>
        <div className="meta">
          <span>{rel}</span>
          {appName && appName !== appSlug ? (
            <>
              <span aria-hidden>·</span>
              <span>{appName}</span>
            </>
          ) : null}
        </div>
      </div>
      <span className={`dur${isFail ? ' fail' : ''}`}>{isFail ? 'fail' : dur}</span>
    </Link>
  );
}

function RunningRow({ run }: { run: MeRunSummary }) {
  const appName = run.app_name || run.app_slug || 'App';
  const rel = formatRelative(run.started_at);
  const isPending = run.status === 'pending';
  return (
    <div
      className="running-row"
      data-testid={`me-running-row-${run.id}`}
    >
      <span aria-hidden className={`ic${isPending ? ' scheduled' : ''}`} />
      <div className="body">
        <div className="nm">
          {appName} · {isPending ? 'queued' : 'running'}
        </div>
        <div className="meta">
          <span>started {rel}</span>
        </div>
      </div>
      <Link
        to={`/r/${encodeURIComponent(run.id)}`}
        className="act"
        aria-label={`View run ${run.id}`}
      >
        View
      </Link>
    </div>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 10) return `${sec.toFixed(2)}s`;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  return `${min}m ${remSec}s`;
}

/** Compact relative time used in run-row meta + Your-apps card meta.
 * Returns "2m" / "14m" / "2h" / "1d" — no "ago" suffix because the
 * surrounding markup ("last run X ago", "started X") supplies it. */
function formatRelative(iso: string | null): string {
  if (!iso) return 'unknown';
  try {
    const d = new Date(iso);
    const t = d.getTime();
    if (Number.isNaN(t)) return iso;
    const now = Date.now();
    const diff = Math.max(0, now - t);
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function greetingFirstName(
  user: { email: string | null; name: string | null } | undefined | null,
): string {
  if (!user) return '';
  const nameRaw = (user.name ?? '').trim();
  if (nameRaw) {
    const first = nameRaw.split(/\s+/)[0] || '';
    if (first) return first;
  }
  const email = (user.email ?? '').trim();
  const local = email.includes('@') ? email.split('@')[0] : email;
  if (!local) return '';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function formatStatsSubtitle(stats: { apps: number; totalRuns: number; running: number }): string {
  const parts: string[] = [];
  parts.push(`${stats.apps} app${stats.apps === 1 ? '' : 's'} installed`);
  parts.push(`${stats.totalRuns} run${stats.totalRuns === 1 ? '' : 's'}`);
  if (stats.running > 0) {
    parts.push(`${stats.running} running now`);
  }
  return parts.join(' · ');
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
    <section
      data-testid={testId}
      style={{
        border: '1px solid var(--line)',
        borderRadius: 14,
        background: 'var(--card)',
        padding: '40px 28px',
        textAlign: 'center',
      }}
    >
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: '-0.025em',
          lineHeight: 1.1,
          color: 'var(--ink)',
          margin: '0 0 10px',
        }}
      >
        Nothing here yet.
      </h2>
      <p
        style={{
          margin: '0 auto 22px',
          maxWidth: 420,
          fontSize: 14.5,
          lineHeight: 1.6,
          color: 'var(--muted)',
        }}
      >
        {signedOutPreview
          ? 'Try one from the public directory and your recent activity will show up here after you sign in.'
          : 'Try one from the public directory.'}
      </p>
      <Link
        to="/apps"
        data-testid="me-empty-browse"
        style={{
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
        }}
      >
        Browse apps →
      </Link>
    </section>
  );
}
