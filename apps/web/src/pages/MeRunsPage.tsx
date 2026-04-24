// /me/runs — Runs tab of the Studio-tabbed dashboard.
//
// Full chronological list of the user's own runs across every app. The
// Overview tab shows a 5-run preview; this page shows everything with
// "Load more" pagination. Status pill + app icon + row-level click to
// open the run permalink — same interaction as the prior /me Recent
// runs section, extracted so /me/runs is no longer a redirect stub.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MeLayout } from '../components/me/MeLayout';
import { AppIcon } from '../components/AppIcon';
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
  },
  h2: {
    fontFamily: 'var(--font-display)',
    fontSize: 20,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 1.2,
    margin: 0,
    color: 'var(--ink)',
  },
  subtitle: {
    fontSize: 13,
    color: 'var(--muted)',
    margin: '4px 0 20px',
    lineHeight: 1.5,
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

export function MeRunsPage() {
  const navigate = useNavigate();
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_LIMIT);

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

  function openRun(run: MeRunSummary) {
    if (!run.app_slug) return;
    navigate(`/p/${run.app_slug}?run=${encodeURIComponent(run.id)}`);
  }

  return (
    <MeLayout activeTab="runs" title="Runs · Me · Floom" allowSignedOutShell={signedOutPreview}>
      <div data-testid="me-runs-page">
        <header style={s.header}>
          <h2 style={s.h2}>All runs</h2>
          {runs && runs.length > 0 ? (
            <span style={{ fontSize: 12, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
              {runs.length} total
            </span>
          ) : null}
        </header>
        <p style={s.subtitle}>
          Every Floom app you&rsquo;ve run. Most-recent first. Click any row to open the run detail.
        </p>

        {runs === null && !runsError ? (
          <div style={{ ...s.card, padding: 18, color: 'var(--muted)', fontSize: 13 }}>
            Loading runs…
          </div>
        ) : runsError ? (
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
            <strong style={{ color: '#c2321f' }}>Couldn&rsquo;t load runs.</strong> {runsError}
          </section>
        ) : visibleRuns.length === 0 ? (
          <EmptyRuns signedOutPreview={signedOutPreview} />
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
      </div>
    </MeLayout>
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
      <StatusPill status={run.status} />
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
              maxWidth: 'min(220px, 40%)',
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

function EmptyRuns({ signedOutPreview = false }: { signedOutPreview?: boolean }) {
  return (
    <section
      data-testid="me-runs-empty"
      style={{
        border: '1px dashed var(--line)',
        borderRadius: 12,
        background: 'var(--card)',
        padding: '40px 24px',
        textAlign: 'center' as const,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 20,
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
          margin: '0 auto 20px',
          color: 'var(--muted)',
          fontSize: 14,
          lineHeight: 1.55,
          maxWidth: 380,
        }}
      >
        {signedOutPreview
          ? 'Your run history appears here after you sign in. You can still try apps from the public directory right now.'
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

/* ---------- helpers ---------- */

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
