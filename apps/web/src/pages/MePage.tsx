// /me — consumer home.
//
// v17 shape (2026-04-19): "run apps" is the primary job on /me. Sections
// are ordered so that non-dev users (Federico's ICP) land on a grid of
// their recent tools with one-tap Run CTAs. Creator inventory ("Your
// apps") is secondary; runs history is tertiary.
//
// Sections top to bottom:
//   1. "Me" greeting header
//   2. "Your tools"    — grid of up to 8 recent tools (from run history);
//                        empty-state is a curated row of public apps.
//   3. "Your apps"     — creator inventory (was "Apps you've published").
//   4. "Recent runs"   — full run history (was "Runs history").
//
// Prior v16 put creator inventory first, which hid the primary action
// (running) behind an empty section for users with no published apps.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { AppIcon } from '../components/AppIcon';
import { ToolTile } from '../components/me/ToolTile';
import { useMyApps } from '../hooks/useMyApps';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { CreatorApp, HubApp, MeRunSummary, RunStatus } from '../lib/types';

const INITIAL_LIMIT = 25;
const LOAD_STEP = 25;
const FETCH_LIMIT = 200;

const s: Record<string, CSSProperties> = {
  main: {
    maxWidth: 820,
    margin: '0 auto',
    padding: '32px 24px 96px',
    width: '100%',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
    marginBottom: 24,
  },
  h1: {
    fontFamily: "'DM Serif Display', Georgia, serif",
    fontSize: 28,
    fontWeight: 500,
    lineHeight: 1.2,
    margin: 0,
    color: 'var(--ink)',
  },
  sectionH2: {
    fontFamily: "'DM Serif Display', Georgia, serif",
    fontSize: 20,
    fontWeight: 500,
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
  loadMoreWrap: {
    padding: 14,
    textAlign: 'center' as const,
    borderTop: '1px solid var(--line)',
    background: 'var(--bg)',
  },
  loadMoreBtn: {
    padding: '8px 16px',
    border: '1px solid var(--line)',
    background: 'var(--card)',
    color: 'var(--ink)',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  footer: {
    marginTop: 32,
    padding: '16px 20px',
    border: '1px solid var(--line)',
    borderRadius: 12,
    background: 'var(--card)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
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
};

// Tools grid: 2 cols on narrow (375px), 3-4 cols on tablet, 4 cols on
// desktop at 820px max. Uses auto-fit with a minmax so the layout stays
// sane at any width without media queries.
const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
  gap: 12,
};

const TOOLS_LIMIT = 8;
const CURATED_LIMIT = 6;

type Tool = {
  slug: string;
  name: string;
  lastUsedAt: string | null;
  /** True when the tile came from the curated fallback (no run history). */
  curated: boolean;
};

export function MePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { apps } = useMyApps();

  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [curated, setCurated] = useState<HubApp[] | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_LIMIT);

  useEffect(() => {
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
  }, []);

  // Derive "Your tools" from runs: group by slug, take N most-recent
  // distinct slugs. Runs arrive started_at DESC from the backend, so a
  // simple first-hit-wins pass yields the correct order without sorting.
  const tools: Tool[] | null = useMemo(() => {
    if (runs === null) return null;
    const seen = new Map<string, Tool>();
    for (const run of runs) {
      if (!run.app_slug) continue;
      if (seen.has(run.app_slug)) continue;
      seen.set(run.app_slug, {
        slug: run.app_slug,
        name: run.app_name || run.app_slug,
        lastUsedAt: run.started_at,
        curated: false,
      });
      if (seen.size >= TOOLS_LIMIT) break;
    }
    return Array.from(seen.values());
  }, [runs]);

  // If the user has no runs yet, fetch the public directory and surface a
  // curated row. /api/hub returns sorted by featured DESC, avg_run_ms ASC,
  // created_at DESC, name ASC — already the order we want.
  const needsCurated = tools !== null && tools.length === 0;
  useEffect(() => {
    if (!needsCurated || curated !== null) return;
    let cancelled = false;
    api
      .getHub()
      .then((hub) => {
        if (cancelled) return;
        setCurated(hub.slice(0, CURATED_LIMIT));
      })
      .catch(() => {
        if (!cancelled) setCurated([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsCurated, curated]);

  const showNotice = searchParams.get('notice') === 'app_not_found';
  const noticeSlug = searchParams.get('slug');
  // /onboarding redirects to /me?welcome=1 (no standalone onboarding page).
  // Show a one-shot welcome banner so users who just finished signup have
  // a clear next step instead of landing on a bare runs list.
  const showWelcome = searchParams.get('welcome') === '1';

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

  const visibleRuns = useMemo(
    () => (runs ? runs.slice(0, visibleCount) : []),
    [runs, visibleCount],
  );
  const hasMore = runs ? runs.length > visibleCount : false;
  const publishedAppCount = apps ? apps.length : 0;
  const hasApps = apps !== null && apps.length > 0;

  function openRun(run: MeRunSummary) {
    if (!run.app_slug) return;
    navigate(`/p/${run.app_slug}?run=${encodeURIComponent(run.id)}`);
  }

  const appsLoading = apps === null;
  const toolsLoading = tools === null;

  return (
    <PageShell
      requireAuth="cloud"
      title="Me · Floom"
      contentStyle={{ padding: 0, maxWidth: 'none', minHeight: 'auto' }}
    >
      <main data-testid="me-page" style={s.main}>
        <header style={s.header}>
          <h1 style={s.h1}>Me</h1>
          <Link to="/apps" data-testid="me-browse-apps" style={s.headerLink}>
            Browse apps →
          </Link>
        </header>

        {showWelcome && <WelcomeBanner onDismiss={dismissWelcome} />}

        {showNotice && (
          <AppNotFound slug={noticeSlug} onDismiss={dismissNotice} />
        )}

        {/* Your tools — FIRST on /me as of 2026-04-19. Primary job on /me
            is "run an app", so the top surface is a grid of tiles with
            Run CTAs. Tiles come from the user's past runs (grouped by
            slug); empty state falls back to a curated row. */}
        <section
          data-testid="me-tools-section"
          style={{ marginBottom: 36 }}
          aria-label="Your tools"
        >
          <header
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <h2 style={s.sectionH2}>Your tools</h2>
            <Link to="/apps" data-testid="me-tools-browse" style={s.headerLink}>
              Browse apps →
            </Link>
          </header>

          {toolsLoading ? (
            <div
              data-testid="me-tools-loading"
              style={{
                ...s.card,
                padding: 20,
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              Loading your tools…
            </div>
          ) : tools && tools.length > 0 ? (
            <div data-testid="me-tools-grid" style={gridStyle}>
              {tools.map((t) => (
                <ToolTile
                  key={t.slug}
                  slug={t.slug}
                  name={t.name}
                  lastUsedAt={t.lastUsedAt}
                />
              ))}
            </div>
          ) : curated === null ? (
            <div
              data-testid="me-tools-loading"
              style={{
                ...s.card,
                padding: 20,
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              Loading suggestions…
            </div>
          ) : curated.length > 0 ? (
            <div data-testid="me-tools-empty">
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  marginBottom: 10,
                  lineHeight: 1.55,
                }}
              >
                Try these →
              </div>
              <div data-testid="me-tools-grid" style={gridStyle}>
                {curated.map((a) => (
                  <ToolTile
                    key={a.slug}
                    slug={a.slug}
                    name={a.name}
                    lastUsedAt={null}
                    badge="New"
                  />
                ))}
              </div>
              <div style={{ marginTop: 14 }}>
                <Link
                  to="/apps"
                  data-testid="me-tools-empty-cta"
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
            </div>
          ) : (
            <section
              data-testid="me-tools-empty"
              style={{
                border: '1px dashed var(--line)',
                borderRadius: 12,
                background: 'var(--card)',
                padding: '24px 20px',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: 14,
                  color: 'var(--muted)',
                  marginBottom: 12,
                  lineHeight: 1.55,
                }}
              >
                You haven’t run any Floom apps yet.
              </div>
              <Link
                to="/apps"
                data-testid="me-tools-empty-cta"
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
            </section>
          )}
        </section>

        {/* Your apps — creator inventory. Was "Apps you've published";
            the sub line keeps the original meaning for creators. */}
        <section
          data-testid="me-apps-section"
          style={{ marginBottom: 36 }}
          aria-label="Your apps"
        >
          <header
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 4,
            }}
          >
            <h2 style={s.sectionH2}>Your apps</h2>
            {hasApps && (
              <Link
                to="/studio/build"
                data-testid="me-publish-another"
                style={s.headerLink}
              >
                Publish another →
              </Link>
            )}
          </header>
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              marginBottom: 12,
              lineHeight: 1.55,
            }}
          >
            Apps you’ve built on Floom
          </div>

          {appsLoading ? (
            <div
              data-testid="me-apps-loading"
              style={{ ...s.card, padding: 20, color: 'var(--muted)', fontSize: 13 }}
            >
              Loading apps…
            </div>
          ) : hasApps && apps ? (
            <div data-testid="me-apps-list" style={s.card}>
              {apps.map((app, i) => (
                <AppRow
                  key={app.slug}
                  app={app}
                  isLast={i === apps.length - 1}
                />
              ))}
            </div>
          ) : (
            <section
              data-testid="me-apps-empty"
              style={{
                border: '1px dashed var(--line)',
                borderRadius: 12,
                background: 'var(--card)',
                padding: '18px 20px',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  marginBottom: 10,
                  lineHeight: 1.55,
                }}
              >
                You haven’t published any apps yet.
              </div>
              <Link
                to="/studio/build"
                data-testid="me-empty-publish"
                style={{
                  display: 'inline-block',
                  padding: '8px 14px',
                  background: 'var(--card)',
                  color: 'var(--ink)',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Publish your first app →
              </Link>
            </section>
          )}
        </section>

        {/* Recent runs — tertiary. Renamed from "Runs history" (too
            archival) to match the "latest activity" mental model. */}
        <section data-testid="me-runs-section" aria-label="Recent runs">
          <header
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <h2 style={s.sectionH2}>Recent runs</h2>
          </header>

          {runs === null && !runsError ? (
            <RunsSkeleton />
          ) : runsError ? (
            <ErrorPanel message={runsError} />
          ) : runs && runs.length === 0 ? (
            <EmptyRuns />
          ) : (
            <div data-testid="me-runs-list" style={s.card}>
              {visibleRuns.map((run, i) => (
                <RunRow
                  key={run.id}
                  run={run}
                  onOpen={openRun}
                  isLast={i === visibleRuns.length - 1}
                />
              ))}
              {hasMore && (
                <div style={s.loadMoreWrap}>
                  <button
                    type="button"
                    onClick={() => setVisibleCount((n) => n + LOAD_STEP)}
                    data-testid="me-load-more"
                    style={s.loadMoreBtn}
                  >
                    Load more
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {publishedAppCount > 0 && (
          <footer style={s.footer}>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
              You have {publishedAppCount}{' '}
              {publishedAppCount === 1 ? 'app' : 'apps'} you built.
            </div>
            <Link
              to="/creator"
              data-testid="me-open-studio"
              style={s.headerLink}
            >
              Open Studio →
            </Link>
          </footer>
        )}
      </main>
    </PageShell>
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
          </Link>
          {' '}to get started.
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

function RunRow({
  run,
  onOpen,
  isLast,
}: {
  run: MeRunSummary;
  onOpen: (run: MeRunSummary) => void;
  isLast: boolean;
}) {
  const appName = run.app_name || run.app_slug || 'App';
  const summary = runSummary(run);
  const tooltip = runRowTooltip(run, summary);
  const time = formatTime(run.started_at);
  const disabled = !run.app_slug;
  return (
    <button
      type="button"
      onClick={() => onOpen(run)}
      disabled={disabled}
      data-testid={`me-run-row-${run.id}`}
      title={tooltip}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        minHeight: 56,
        border: 'none',
        borderBottom: isLast ? 'none' : '1px solid var(--line)',
        background: 'transparent',
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'inherit',
        color: 'var(--ink)',
      }}
    >
      <StatusDot status={run.status} />
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
          }}
        >
          <span
            style={{
              fontWeight: 600,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 200,
            }}
          >
            {appName}
          </span>
          {summary && (
            <span
              style={{
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
                fontFamily: 'inherit',
              }}
            >
              {summary}
            </span>
          )}
        </div>
      </div>
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

// Upgrade 1 (2026-04-19): AppRow — one row per owned app. Shows icon +
// name + version + visibility pill + updated-at + "Open in Studio" CTA.
// Clicking anywhere on the row opens /studio/:slug. Matches RunRow
// visual weight so /me reads as one unified dashboard.
function AppRow({ app, isLast }: { app: CreatorApp; isLast: boolean }) {
  const navigate = useNavigate();
  const version = appVersion(app);
  const updated = formatTime(app.updated_at);
  const visibility = app.visibility ?? 'public';
  return (
    <button
      type="button"
      onClick={() => navigate(`/studio/${app.slug}`)}
      data-testid={`me-app-row-${app.slug}`}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        minHeight: 56,
        border: 'none',
        borderBottom: isLast ? 'none' : '1px solid var(--line)',
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: 'var(--ink)',
      }}
    >
      <span aria-hidden style={s.appIconWrap}>
        <AppIcon slug={app.slug} size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            fontSize: 14,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontWeight: 600,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 240,
            }}
          >
            {app.name}
          </span>
          <span
            data-testid={`me-app-version-${app.slug}`}
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              fontFamily: 'JetBrains Mono, monospace',
            }}
          >
            {version}
          </span>
          <VisibilityPill visibility={visibility} />
        </div>
      </div>
      <span
        style={{
          fontSize: 12,
          color: 'var(--muted)',
          flexShrink: 0,
          fontVariantNumeric: 'tabular-nums',
          marginRight: 12,
        }}
      >
        {updated}
      </span>
      <span
        data-testid={`me-app-open-${app.slug}`}
        aria-hidden="true"
        style={{
          fontSize: 12,
          color: 'var(--accent)',
          fontWeight: 600,
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        Open in Studio →
      </span>
    </button>
  );
}

function appVersion(app: CreatorApp): string {
  // CreatorApp doesn't carry a version field today; AppDetail does. For
  // /me we fall back to the app.status when non-active (e.g. "draft")
  // and a canonical "v0.1.0" otherwise. When a real version pipeline
  // lands on CreatorApp, swap this for app.version.
  const status = (app.status || '').trim();
  if (status && status !== 'active') return status;
  return 'v0.1.0';
}

function VisibilityPill({ visibility }: { visibility: string }) {
  const label =
    visibility === 'private'
      ? 'private'
      : visibility === 'auth-required'
        ? 'auth only'
        : visibility === 'invite-only'
          ? 'invite only'
          : visibility === 'public'
            ? 'public'
            : visibility;
  const isPrivate = visibility !== 'public';
  return (
    <span
      data-testid={`me-app-visibility-${visibility}`}
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 4,
        background: isPrivate ? 'var(--bg)' : 'var(--accent-soft, rgba(16,185,129,0.08))',
        color: isPrivate ? 'var(--muted)' : 'var(--accent)',
        border: isPrivate ? '1px solid var(--line)' : '1px solid transparent',
      }}
    >
      {label}
    </span>
  );
}

function StatusDot({ status }: { status: RunStatus }) {
  const color =
    status === 'success'
      ? 'var(--accent)'
      : status === 'error' || status === 'timeout'
        ? '#c2321f'
        : 'var(--muted)';
  return (
    <span
      aria-label={`Status: ${status}`}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

function runSummary(run: MeRunSummary): string | null {
  const inputs = run.inputs;
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    // Heuristic order: prefer the canonical prompt field, then the first
    // non-trivial string, then a compact "key: value" pair for scalar
    // inputs. Never fall through to a raw JSON dump — round 2 audit found
    // rows rendering {"foo":"bar"} because apps with object-only inputs
    // had no string field for the previous heuristic to surface.
    const prompt = inputs['prompt'];
    if (typeof prompt === 'string' && prompt.trim()) {
      return truncate(prompt.trim(), 90);
    }
    for (const value of Object.values(inputs)) {
      if (typeof value === 'string' && value.trim()) {
        return truncate(value.trim(), 90);
      }
    }
    // Scalar fallback: first primitive (number, boolean) rendered as
    // "key: value". Covers hash/uuid/base64-style apps whose first input
    // is "text" or "input" plus scalar options.
    const entries = Object.entries(inputs).filter(
      ([, v]) => v !== null && (typeof v === 'number' || typeof v === 'boolean'),
    );
    if (entries.length > 0) {
      const [k, v] = entries[0];
      return truncate(`${k}: ${v}`, 90);
    }
    // Last resort: count keys so the row reads "3 inputs" rather than
    // empty or a JSON blob. Keeps the row skimmable while preserving the
    // full payload in the hover title (renderer attaches it above).
    const keyCount = Object.keys(inputs).length;
    if (keyCount > 0) return `${keyCount} input${keyCount === 1 ? '' : 's'}`;
  }
  if (run.action && run.action !== 'run') return run.action;
  return null;
}

/**
 * Round 2 polish: hover tooltip showing the full input JSON. Previously
 * the title attr held just the truncated summary, so there was no way to
 * see what actually ran without opening the run detail. Stringifies
 * inputs for the title only — the visible row copy still uses the
 * human-readable heuristic above.
 */
function runRowTooltip(run: MeRunSummary, summary: string | null): string {
  if (!run.inputs || typeof run.inputs !== 'object') return summary ?? '';
  try {
    const raw = JSON.stringify(run.inputs, null, 2);
    if (raw.length <= 400) return raw;
    return `${raw.slice(0, 397)}...`;
  } catch {
    return summary ?? '';
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}

function RunsSkeleton() {
  return (
    <section
      data-testid="me-runs-loading"
      style={{ ...s.card, padding: 20, color: 'var(--muted)', fontSize: 13 }}
    >
      Loading runs…
    </section>
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
      <strong style={{ color: '#c2321f' }}>Couldn&rsquo;t load runs.</strong>{' '}
      {message}
    </section>
  );
}

function EmptyRuns() {
  return (
    <section
      data-testid="me-runs-empty"
      style={{
        border: '1px dashed var(--line)',
        borderRadius: 12,
        background: 'var(--card)',
        padding: '40px 24px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: "'DM Serif Display', Georgia, serif",
          fontSize: 20,
          color: 'var(--ink)',
          marginBottom: 8,
        }}
      >
        No runs yet.
      </div>
      <p
        style={{
          margin: '0 auto 20px',
          color: 'var(--muted)',
          fontSize: 14,
          lineHeight: 1.55,
          maxWidth: 380,
        }}
      >
        Run any Floom app and it will show up here. Try one from the public
        directory.
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
