// v15.1 /me — Claude/ChatGPT shape (anchor: /tmp/v15-local/me.html).
//
// Desktop: MeRail on the left (+ New thread, Your apps, Today / Yesterday
// / Earlier threads, profile footer) + right pane showing the active
// thread with turn-by-turn prompt + result + inline composer.
// Mobile (<= 640px): MeMobile with two tabs, Threads / Apps · N.
// Empty state (no apps, no runs): slim rail + centered hero CTA to
// /apps and /build.
//
// "Threads" currently 1:1 map to `me_runs` rows — the threads table
// doesn't exist yet. The composer deep-links to /me/apps/:slug/run with a
// ?prompt= hint which that page uses to prefill the default input.
//
// Legacy tabs (Folders, Saved results, Schedules, My tickets, Shared
// with me) and the Install tab have been removed. The Install-to-Claude
// UI now lives at /me/install.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
import { Logo } from '../components/Logo';
import { MeRail } from '../components/me/MeRail';
import { MeThreadPane } from '../components/me/MeThreadPane';
import {
  MeComposer,
  type MeComposerHandle,
} from '../components/me/MeComposer';
import { MeMobile } from '../components/me/MeMobile';
import * as api from '../api/client';
import type { MeRunDetail, MeRunSummary } from '../lib/types';

const INITIAL_THREAD_LIMIT = 20;
const LOAD_MORE_STEP = 20;

function useIsMobile(breakpoint = 640): boolean {
  const getMatch = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(`(max-width: ${breakpoint}px)`).matches
      : false;
  const [isMobile, setIsMobile] = useState<boolean>(getMatch);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
      return;
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

export function MePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: session, loading: sessionLoading } = useSession();
  const { apps } = useMyApps();
  const composerRef = useRef<MeComposerHandle | null>(null);
  const isMobile = useIsMobile();

  // App-not-found notice (ported from main): surfaced when a user lands
  // here from a removed/inaccessible app permalink (e.g. /me/apps/:slug/run).
  const showAppNotFoundNotice = searchParams.get('notice') === 'app_not_found';
  const appNotFoundSlug = searchParams.get('slug');

  const dismissAppNotFoundNotice = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('notice');
    next.delete('slug');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (typeof document !== 'undefined') document.title = 'Your workspace | Floom';
  }, []);

  useEffect(() => {
    if (sessionLoading || !session) return;
    if (session.cloud_mode && session.user.is_local) {
      const next = `${window.location.pathname}${window.location.search}`;
      navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
    }
  }, [session, sessionLoading, navigate]);

  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [threadLimit, setThreadLimit] = useState(INITIAL_THREAD_LIMIT);

  useEffect(() => {
    let cancelled = false;
    api
      .getMyRuns(100)
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

  const activeThreadId = searchParams.get('thread');
  const activeThread = useMemo<MeRunSummary | null>(() => {
    if (!runs || runs.length === 0) return null;
    if (activeThreadId) {
      const found = runs.find((r) => r.id === activeThreadId);
      if (found) return found;
    }
    return runs[0] ?? null;
  }, [runs, activeThreadId]);

  const activeApp = useMemo(() => {
    if (!activeThread || !apps) return null;
    return apps.find((a) => a.slug === activeThread.app_slug) || null;
  }, [activeThread, apps]);

  const [detail, setDetail] = useState<MeRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    if (!activeThread) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setDetail(null);
    setDetailError(null);
    let cancelled = false;
    api
      .getMyRun(activeThread.id)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (!cancelled) setDetailError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [activeThread]);

  const handleNewThread = useCallback(() => {
    if (activeThread && activeThread.app_slug) {
      composerRef.current?.focus();
    } else if (apps && apps.length > 0) {
      navigate(`/me/apps/${apps[0].slug}/run`);
    } else {
      navigate('/apps');
    }
  }, [activeThread, apps, navigate]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewThread();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleNewThread]);

  if (sessionLoading || (!runs && !runsError)) return <LoadingPane />;

  const hasApps = !!apps && apps.length > 0;
  const hasThreads = !!runs && runs.length > 0;

  if (isMobile) {
    return (
      <MeMobile
        threads={runs ?? []}
        apps={apps ?? []}
        onNewThread={handleNewThread}
      />
    );
  }

  if (!hasApps && !hasThreads) {
    return (
      <div
        data-testid="me-page"
        style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}
      >
        <MeRail onNewThread={handleNewThread} />
        <EmptyHero />
      </div>
    );
  }

  if (!hasThreads) {
    return (
      <div
        data-testid="me-page"
        style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}
      >
        <MeRail
          threads={[]}
          onNewThread={handleNewThread}
          threadLimit={threadLimit}
        />
        <NoThreadYet
          firstAppSlug={apps?.[0]?.slug || null}
          firstAppName={apps?.[0]?.name || null}
          onNewThread={handleNewThread}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="me-page"
      style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}
    >
      <MeRail
        activeAppSlug={activeThread?.app_slug ?? undefined}
        threads={runs ?? []}
        activeThreadId={activeThread?.id}
        onNewThread={handleNewThread}
        threadLimit={threadLimit}
        onLoadMoreThreads={() => setThreadLimit((n) => n + LOAD_MORE_STEP)}
      />

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
        }}
      >
        {showAppNotFoundNotice && (
          <div
            role="alert"
            data-testid="me-app-not-found-notice"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '12px 16px',
              margin: '16px 20px 0',
              borderRadius: 10,
              border: '1px solid #f4b7b1',
              background: '#fdecea',
              color: '#5c2d26',
            }}
          >
            <div style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.55 }}>
              <strong style={{ color: '#c2321f' }}>App not found</strong>
              <span style={{ display: 'block', marginTop: 4 }}>
                We couldn&rsquo;t open that app
                {appNotFoundSlug ? (
                  <>
                    {' '}
                    (<span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>{appNotFoundSlug}</span>
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
              onClick={dismissAppNotFoundNotice}
              style={{
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
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        {activeThread ? (
          <>
            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <MeThreadPane
                thread={activeThread}
                detail={detail}
                detailError={detailError}
                appVisibility={activeApp?.visibility}
              />
            </div>
            <MeComposer
              ref={composerRef}
              targetSlug={activeThread.app_slug}
              targetName={activeThread.app_name || undefined}
            />
          </>
        ) : (
          <NoThreadYet
            firstAppSlug={apps?.[0]?.slug || null}
            firstAppName={apps?.[0]?.name || null}
            onNewThread={handleNewThread}
          />
        )}
      </div>

      {runsError && (
        <div
          data-testid="me-runs-error"
          style={{
            position: 'fixed',
            bottom: 16,
            right: 16,
            background: '#fdecea',
            border: '1px solid #f4b7b1',
            color: '#c2321f',
            padding: '10px 14px',
            borderRadius: 8,
            fontSize: 13,
            maxWidth: 360,
          }}
        >
          {runsError}
        </div>
      )}
    </div>
  );
}

function LoadingPane() {
  return (
    <div
      data-testid="me-loading"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--muted)',
        fontSize: 14,
        background: 'var(--bg)',
      }}
    >
      Loading…
    </div>
  );
}

function EmptyHero() {
  return (
    <div
      data-testid="me-empty-hero"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 64,
          height: 64,
          borderRadius: 16,
          background: 'var(--card)',
          border: '1px solid var(--line)',
          marginBottom: 22,
        }}
      >
        <Logo size={32} />
      </div>
      <h1
        style={{
          fontFamily: "'DM Serif Display', Georgia, serif",
          fontSize: 34,
          lineHeight: 1.15,
          margin: '0 0 10px',
          color: 'var(--ink)',
          maxWidth: 520,
        }}
      >
        Welcome — pick or build your first app.
      </h1>
      <p
        style={{
          fontSize: 14.5,
          color: 'var(--muted)',
          maxWidth: 440,
          margin: '0 auto 28px',
          lineHeight: 1.55,
        }}
      >
        Floom apps live here once you save or build them. Public apps are at{' '}
        <Link
          to="/apps"
          style={{ color: 'var(--accent)', textDecoration: 'underline' }}
        >
          /apps
        </Link>
        .
      </p>
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        <Link
          to="/apps"
          data-testid="me-empty-browse"
          style={{
            padding: '10px 18px',
            background: 'var(--ink)',
            color: '#fff',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Browse public apps →
        </Link>
        <Link
          to="/build"
          data-testid="me-empty-build"
          style={{
            padding: '10px 18px',
            background: 'var(--card)',
            color: 'var(--ink)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Build your own →
        </Link>
      </div>
    </div>
  );
}

function NoThreadYet({
  firstAppSlug,
  firstAppName,
  onNewThread,
}: {
  firstAppSlug: string | null;
  firstAppName: string | null;
  onNewThread: () => void;
}) {
  return (
    <div
      data-testid="me-no-threads-pane"
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 32px',
        background: 'var(--bg)',
      }}
    >
      <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
        <h1
          style={{
            fontFamily: "'DM Serif Display', Georgia, serif",
            fontSize: 28,
            fontWeight: 500,
            lineHeight: 1.2,
            margin: '0 0 10px',
            color: 'var(--ink)',
          }}
        >
          No threads yet.
        </h1>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted)',
            margin: '0 0 22px',
            lineHeight: 1.6,
          }}
        >
          Start your first thread by running one of your apps.
        </p>
        {firstAppSlug ? (
          <Link
            to={`/me/apps/${firstAppSlug}/run`}
            data-testid="me-no-threads-start"
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
            Run {firstAppName || firstAppSlug} →
          </Link>
        ) : (
          <button
            type="button"
            onClick={onNewThread}
            style={{
              padding: '10px 18px',
              background: 'var(--ink)',
              color: '#fff',
              border: 0,
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Browse apps →
          </button>
        )}
      </div>
    </div>
  );
}
