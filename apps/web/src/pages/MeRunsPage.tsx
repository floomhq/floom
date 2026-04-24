import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../components/AppIcon';
import { MeLayout } from '../components/me/MeLayout';
import { runIdShort, runPreviewText } from '../components/me/runPreview';
import { useMeCompactLayout } from '../components/me/useMeCompactLayout';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { MeRunSummary, RunStatus } from '../lib/types';

const INITIAL_LIMIT = 25;
const LOAD_STEP = 25;
const FETCH_LIMIT = 200;

const s: Record<string, CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14,
    flexWrap: 'wrap',
  },
  h2: {
    fontFamily: 'var(--font-display)',
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: '-0.03em',
    lineHeight: 1.15,
    margin: 0,
    color: 'var(--ink)',
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--muted)',
    margin: '0 0 20px',
    lineHeight: 1.6,
    maxWidth: 620,
  },
  card: {
    border: '1px solid var(--line)',
    borderRadius: 20,
    background: 'var(--card)',
    overflow: 'hidden',
    boxShadow: '0 1px 0 rgba(17, 24, 39, 0.02)',
  },
  runRow: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 14,
    padding: '15px 18px',
    textDecoration: 'none',
    color: 'var(--ink)',
    borderBottom: '1px solid var(--line)',
  },
  appIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    background: 'rgba(250, 248, 243, 0.92)',
    border: '1px solid var(--line)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  previewStack: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 3,
    minWidth: 0,
  },
  appTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
    flexWrap: 'wrap',
  },
  appName: {
    fontSize: 14,
    fontWeight: 700,
    lineHeight: 1.3,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  runMeta: {
    fontSize: 11,
    color: 'var(--muted)',
    fontFamily: 'JetBrains Mono, monospace',
    letterSpacing: '0.02em',
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
  rightMeta: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-end',
    gap: 6,
    flexShrink: 0,
  },
  whenText: {
    fontSize: 12.5,
    color: 'var(--muted)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap' as const,
  },
  loadMoreWrap: {
    padding: 14,
    textAlign: 'center' as const,
    borderTop: '1px solid var(--line)',
    background: 'rgba(250, 248, 243, 0.82)',
  },
  loadMoreBtn: {
    padding: '9px 16px',
    border: '1px solid var(--line)',
    background: 'var(--card)',
    color: 'var(--ink)',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  emptyCard: {
    border: '1px solid var(--line)',
    borderRadius: 24,
    background:
      'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(250,248,243,0.94) 100%)',
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

export function MeRunsPage() {
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_LIMIT);
  const compactLayout = useMeCompactLayout();

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
      .catch((err) => {
        if (!cancelled) setRunsError((err as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionPending, signedOutPreview]);

  const visibleRuns = useMemo(
    () => (runs ? runs.slice(0, visibleCount) : []),
    [runs, visibleCount],
  );
  const hasMore = runs ? runs.length > visibleCount : false;

  return (
    <MeLayout
      activeTab="runs"
      title="Run history · Me · Floom"
      allowSignedOutShell={signedOutPreview}
      eyebrow="History"
      heading="Recent runs"
      subtitle="Everything you’ve run on Floom, ordered from newest to oldest."
      actions={
        <Link to="/me" style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--accent)', textDecoration: 'none' }}>
          Back home →
        </Link>
      }
    >
      <div data-testid="me-runs-page">
        <header style={s.header}>
          <h2 style={s.h2}>Run history</h2>
          {runs && runs.length > 0 ? (
            <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {runs.length} total
            </span>
          ) : null}
        </header>
        <p style={s.subtitle}>
          Open any row to inspect the full run permalink with inputs, outputs, and logs.
        </p>

        {runs === null && !runsError ? (
          <div style={{ ...s.card, padding: 18, color: 'var(--muted)', fontSize: 13.5 }}>
            Loading runs…
          </div>
        ) : runsError ? (
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
            <strong style={{ color: '#c2321f' }}>Couldn&rsquo;t load runs.</strong> {runsError}
          </section>
        ) : visibleRuns.length === 0 ? (
          <EmptyRuns signedOutPreview={signedOutPreview} />
        ) : (
          <div data-testid="me-runs-list" style={s.card}>
            {visibleRuns.map((run, index) => (
              <RunRow
                key={run.id}
                run={run}
                isLast={index === visibleRuns.length - 1}
                compact={compactLayout}
              />
            ))}
            {hasMore ? (
              <div style={s.loadMoreWrap}>
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + LOAD_STEP)}
                  data-testid="me-load-more"
                  style={s.loadMoreBtn}
                >
                  Load more
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </MeLayout>
  );
}

function RunRow({
  run,
  isLast,
  compact,
}: {
  run: MeRunSummary;
  isLast: boolean;
  compact: boolean;
}) {
  const appName = run.app_name || run.app_slug || 'App';

  return (
    <Link
      to={`/me/runs/${encodeURIComponent(run.id)}`}
      data-testid={`me-run-row-${run.id}`}
      style={{
        ...s.runRow,
        gridTemplateColumns: compact
          ? 'minmax(0, 1fr)'
          : (s.runRow.gridTemplateColumns as string),
        borderBottom: isLast ? 'none' : s.runRow.borderBottom,
      }}
    >
      {run.app_slug ? (
        <span aria-hidden style={s.appIconWrap}>
          <AppIcon slug={run.app_slug} size={16} />
        </span>
      ) : (
        <span aria-hidden style={s.appIconWrap}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>•</span>
        </span>
      )}
      <div style={s.previewStack}>
        <div style={s.appTitle}>
          <span style={s.appName}>{appName}</span>
          <StatusPill status={run.status} />
          <span style={s.runMeta}>{runIdShort(run.id)}</span>
        </div>
        <span style={s.previewText}>{runPreviewText(run)}</span>
      </div>
      <div
        style={{
          ...s.rightMeta,
          alignItems: compact ? 'flex-start' : s.rightMeta.alignItems,
        }}
      >
        <span
          style={{
            ...s.whenText,
            whiteSpace: compact ? 'normal' : s.whenText.whiteSpace,
          }}
        >
          {formatTime(run.started_at)}
        </span>
      </div>
    </Link>
  );
}

function StatusPill({ status }: { status: RunStatus }) {
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
          borderRadius: 999,
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
          borderRadius: 999,
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
        borderRadius: 999,
        background: 'color-mix(in srgb, var(--muted) 12%, transparent)',
        color: 'var(--muted)',
      }}
    >
      {status === 'running' ? 'Run' : 'Queued'}
    </span>
  );
}

function EmptyRuns({ signedOutPreview = false }: { signedOutPreview?: boolean }) {
  return (
    <section data-testid="me-runs-empty" style={s.emptyCard}>
      <h2 style={s.emptyTitle}>
        {signedOutPreview ? 'Nothing to pick up yet.' : 'You haven’t run anything yet.'}
      </h2>
      <p style={s.emptyBody}>
        {signedOutPreview
          ? 'Browse the store, try an app, and your history will show up here after you sign in.'
          : 'Run any app from the store and its history will show up here.'}
      </p>
      <Link to="/apps" data-testid="me-empty-browse" style={s.button}>
        Browse the store →
      </Link>
    </section>
  );
}
