// /me — consumer home. v16 shape (kills v15 chat-turn/thread UI).
//
// Single-column Recent Runs list. Each row deep-links to
// /p/:slug?run=<id> so the user opens the run read-only on the app's
// permalink. No rail, no composer, no turn bubbles, no "New thread"
// button, no "Message X…" placeholder — the prior v15 shape conditioned
// users to treat /me as a chat transcript, which it is not.
//
// Optional footer "Open Studio →" link surfaces when the user has
// published apps of their own (creator overlap).

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { AppIcon } from '../components/AppIcon';
import { useMyApps } from '../hooks/useMyApps';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { MeRunSummary, RunStatus } from '../lib/types';

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

export function MePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { apps } = useMyApps();

  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
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

  const showNotice = searchParams.get('notice') === 'app_not_found';
  const noticeSlug = searchParams.get('slug');

  function dismissNotice() {
    const next = new URLSearchParams(searchParams);
    next.delete('notice');
    next.delete('slug');
    setSearchParams(next, { replace: true });
  }

  const visibleRuns = useMemo(
    () => (runs ? runs.slice(0, visibleCount) : []),
    [runs, visibleCount],
  );
  const hasMore = runs ? runs.length > visibleCount : false;
  const publishedAppCount = apps ? apps.length : 0;

  function openRun(run: MeRunSummary) {
    if (!run.app_slug) return;
    navigate(`/p/${run.app_slug}?run=${encodeURIComponent(run.id)}`);
  }

  return (
    <PageShell
      requireAuth="cloud"
      title="Your runs · Floom"
      contentStyle={{ padding: 0, maxWidth: 'none', minHeight: 'auto' }}
    >
      <main data-testid="me-page" style={s.main}>
        <header style={s.header}>
          <h1 style={s.h1}>Your runs</h1>
          <Link to="/apps" data-testid="me-browse-apps" style={s.headerLink}>
            Browse apps →
          </Link>
        </header>

        {showNotice && (
          <AppNotFound slug={noticeSlug} onDismiss={dismissNotice} />
        )}

        {runs === null && !runsError ? (
          <RunsSkeleton />
        ) : runsError ? (
          <ErrorPanel message={runsError} />
        ) : runs && runs.length === 0 ? (
          <EmptyRuns />
        ) : (
          <section data-testid="me-runs-list" style={s.card}>
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
          </section>
        )}

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
