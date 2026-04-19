// /studio — Studio home. Grid of owned apps + "+ New app" CTA.
// Derived from CreatorPage but ported into the Studio shell so the
// creator workspace has a single coherent context (sidebar +
// darker surface + breadcrumb TopBar). Delete + edit affordances
// preserved.
//
// v6-align 2026-04-20 (Federico visual audit):
//   - Added hero stat bar: Total runs · 7d · Success rate · Last activity.
//   - App cards now carry a 7-day sparkline (real runs, grouped by day).
//   - Status pill (live / draft / never-run) reads at a glance.
//   - Per-card actions condensed to Open + Delete; "View" folded under Open
//     since the Open affordance already includes a View link next to it.
//
// Data source: sparkline histograms use real data via getAppRuns(slug, 50).
// Up to 50 recent runs per app, bucketed into 7 daily bins for display.
// This is N requests per app but fine for the owner view (creators see
// their own apps only, typically 1-20). No mocked data anywhere.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { StudioSignedOutState } from '../components/studio/StudioSignedOutState';
import * as api from '../api/client';
import { refreshMyApps, useMyApps } from '../hooks/useMyApps';
import { useSession } from '../hooks/useSession';
import { formatTime } from '../lib/time';
import type { CreatorApp, CreatorRun } from '../lib/types';

// Number of daily bins in the per-app sparkline.
const SPARKLINE_DAYS = 7;
// Cap per-app run fetches so a creator with 1,000s of runs doesn't blow
// the initial page load. 50 gives ~7 days of detail for active apps.
const SPARKLINE_SAMPLE = 50;

/**
 * Bucket an array of CreatorRun records (started_at DESC) into a fixed
 * array of SPARKLINE_DAYS counts, oldest-first. Returns all-zero array
 * when there are no runs. Day boundaries are local midnight.
 */
function buildDailyHistogram(runs: CreatorRun[]): number[] {
  const bins = new Array<number>(SPARKLINE_DAYS).fill(0);
  const now = new Date();
  // Reset to local midnight so we bucket by full calendar day.
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const msPerDay = 24 * 60 * 60 * 1000;
  const earliest = todayStart - (SPARKLINE_DAYS - 1) * msPerDay;
  for (const r of runs) {
    const t = Date.parse(r.started_at);
    if (Number.isNaN(t)) continue;
    if (t < earliest) continue;
    const dayIndex = Math.floor((t - earliest) / msPerDay);
    if (dayIndex < 0 || dayIndex >= SPARKLINE_DAYS) continue;
    bins[dayIndex] += 1;
  }
  return bins;
}

export function StudioHomePage() {
  const { apps, error: loadError } = useMyApps();
  const { data: session } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;

  // v6-align: per-app recent runs, fetched after apps load. Map from slug
  // to the runs array. Undefined entry = still loading, empty array =
  // fetch finished with zero runs (the two states render differently —
  // loading shows skeleton bars, empty shows flat baseline).
  const [runsByApp, setRunsByApp] = useState<Record<string, CreatorRun[] | undefined>>({});

  useEffect(() => {
    if (signedOutPreview) {
      setError(null);
      return;
    }
    if (loadError) setError(loadError.message);
  }, [loadError, signedOutPreview]);

  // Fetch per-app run samples once the apps list resolves. Runs in
  // parallel; any individual failure degrades that app's card to the
  // baseline sparkline without breaking the page.
  useEffect(() => {
    if (!apps || apps.length === 0 || signedOutPreview) return;
    let cancelled = false;
    const slugs = apps.map((a) => a.slug);
    Promise.all(
      slugs.map((slug) =>
        api
          .getAppRuns(slug, SPARKLINE_SAMPLE)
          .then((res) => ({ slug, runs: res.runs }))
          .catch(() => ({ slug, runs: [] as CreatorRun[] })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, CreatorRun[]> = {};
      for (const r of results) next[r.slug] = r.runs;
      setRunsByApp(next);
    });
    return () => {
      cancelled = true;
    };
  }, [apps, signedOutPreview]);

  // Aggregated hero stats: totals, last-7-day totals, success rate, last
  // activity. Derived from the per-app run samples we already fetch for
  // the sparklines, so the hero costs zero additional requests.
  const aggregate = useMemo(() => {
    if (!apps || apps.length === 0) return null;
    const totalRuns = apps.reduce((sum, a) => sum + (a.run_count ?? 0), 0);
    let runs7d = 0;
    let successes = 0;
    let finishedCount = 0;
    let lastAt: number | null = null;
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    for (const slug of Object.keys(runsByApp)) {
      const runs = runsByApp[slug] ?? [];
      for (const r of runs) {
        const t = Date.parse(r.started_at);
        if (Number.isNaN(t)) continue;
        if (t >= sevenDaysAgo) runs7d += 1;
        if (r.status === 'success' || r.status === 'error' || r.status === 'timeout') {
          finishedCount += 1;
          if (r.status === 'success') successes += 1;
        }
        if (lastAt === null || t > lastAt) lastAt = t;
      }
    }
    const successRate = finishedCount > 0 ? Math.round((successes / finishedCount) * 100) : null;
    return {
      totalRuns,
      runs7d,
      successRate,
      lastAt,
      appCount: apps.length,
    };
  }, [apps, runsByApp]);

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

  return (
    <StudioLayout
      title="Studio · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      <div data-testid="studio-home">
        {signedOutPreview ? (
          <StudioSignedOutState />
        ) : (
          <>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            marginBottom: 20,
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 10.5,
                fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--accent)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              Your apps{aggregate ? ` · ${aggregate.appCount}` : ''}
            </div>
            <h1
              style={{
                fontFamily: "'DM Serif Display', Georgia, serif",
                fontSize: 34,
                fontWeight: 400,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                margin: 0,
                color: 'var(--ink)',
              }}
            >
              {aggregate && aggregate.appCount > 0
                ? `${aggregate.appCount} app${aggregate.appCount === 1 ? '' : 's'} published.`
                : 'Studio'}
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', margin: '8px 0 0', maxWidth: 520 }}>
              Publish, manage, and monitor every app you own.
            </p>
          </div>
          <Link
            to="/studio/build"
            data-testid="studio-new-app-cta"
            className="btn-ink"
            style={{ textDecoration: 'none' }}
          >
            + New app
          </Link>
        </div>

        {/* v6-align stats row. Real data when available; explicit "—"
            placeholder when an app has zero runs so the card never
            fabricates numbers. */}
        {apps && apps.length > 0 && aggregate && (
          <div
            data-testid="studio-stats-row"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 12,
              marginBottom: 24,
            }}
          >
            <StatPill label="Runs · total" value={aggregate.totalRuns.toLocaleString()} />
            <StatPill label="Runs · 7d" value={aggregate.runs7d.toLocaleString()} />
            <StatPill
              label="Success rate"
              value={aggregate.successRate === null ? '—' : `${aggregate.successRate}%`}
            />
            <StatPill
              label="Last activity"
              value={aggregate.lastAt ? formatTime(new Date(aggregate.lastAt).toISOString()) : '—'}
            />
          </div>
        )}

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

        {apps && apps.length === 0 && (
          <div
            data-testid="studio-empty"
            style={{
              textAlign: 'center',
              padding: '64px 24px',
              background: 'var(--card)',
              border: '1px dashed var(--line)',
              borderRadius: 12,
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                background: 'var(--accent-soft, #d7f1e0)',
                color: 'var(--accent)',
                margin: '0 auto 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 28,
                fontWeight: 700,
              }}
              aria-hidden="true"
            >
              +
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', margin: '0 0 8px' }}>
              Ship your first app in 2 minutes
            </h3>
            <p
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                margin: '0 auto 20px',
                maxWidth: 380,
                lineHeight: 1.55,
              }}
            >
              Paste your app's link. Floom gives you a Claude tool, a page to share, a CLI, and a URL your teammates can hit.
            </p>
            <Link to="/studio/build" className="btn-ink">
              Start publishing
            </Link>
          </div>
        )}

        {apps && apps.length > 0 && (
          <div
            data-testid="studio-apps-list"
            style={{
              display: 'grid',
              gap: 14,
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            }}
          >
            {apps.map((a) => (
              <AppCard
                key={a.slug}
                app={a}
                runs={runsByApp[a.slug]}
                onDelete={() => setConfirmSlug(a.slug)}
              />
            ))}
          </div>
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
    </StudioLayout>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--muted)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          fontFamily: 'JetBrains Mono, monospace',
          letterSpacing: '-0.01em',
          color: 'var(--ink)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function AppCard({
  app,
  runs,
  onDelete,
}: {
  app: CreatorApp;
  runs: CreatorRun[] | undefined;
  onDelete: () => void;
}) {
  const histogram = useMemo(
    () => (runs ? buildDailyHistogram(runs) : null),
    [runs],
  );
  // Runs in last 7 days for the card caption. Derived from the same data
  // set as the histogram so the two never disagree.
  const runs7d = histogram ? histogram.reduce((a, b) => a + b, 0) : null;
  // Status pill: live if the app has any runs in the last 7 days, idle
  // otherwise. Draft/paused states would come from a future `status`
  // column; we don't invent one.
  const statusLabel = runs7d === null ? null : runs7d > 0 ? 'ACTIVE' : 'IDLE';

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
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginBottom: 3 }}>
            {app.name}
          </div>
          <div style={{ fontSize: 11.5, fontFamily: 'JetBrains Mono, monospace', color: 'var(--muted)' }}>
            /p/{app.slug}
          </div>
        </div>
        {statusLabel && (
          <span
            style={{
              fontSize: 10,
              fontFamily: 'JetBrains Mono, monospace',
              fontWeight: 600,
              letterSpacing: '0.08em',
              padding: '3px 7px',
              borderRadius: 999,
              background: statusLabel === 'ACTIVE' ? 'var(--accent-soft, #ecfdf5)' : 'var(--bg)',
              color: statusLabel === 'ACTIVE' ? 'var(--accent)' : 'var(--muted)',
              border: `1px solid ${statusLabel === 'ACTIVE' ? 'var(--accent)' : 'var(--line)'}`,
              flexShrink: 0,
            }}
          >
            {statusLabel}
          </span>
        )}
      </div>
      <p
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
        {app.description || '(no description)'}
      </p>

      {/* v6-align sparkline block. Shows real 7-day histogram; degrades
          gracefully to a flat baseline when there are no runs so the
          card shape is consistent across all apps. */}
      <div data-testid={`studio-app-sparkline-${app.slug}`}>
        <Sparkline bins={histogram} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11.5,
            color: 'var(--muted)',
            marginTop: 6,
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          <span>7d</span>
          <span>
            {runs7d === null ? '—' : runs7d.toLocaleString()} run{runs7d === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 10,
          fontSize: 12,
          color: 'var(--muted)',
          paddingTop: 8,
          borderTop: '1px solid var(--line)',
        }}
      >
        <span>
          <strong style={{ color: 'var(--ink)' }}>{app.run_count}</strong> total
        </span>
        <span aria-hidden="true">·</span>
        <span>{app.last_run_at ? `last ${formatTime(app.last_run_at)}` : 'never run'}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
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
        <button
          type="button"
          onClick={onDelete}
          data-testid={`studio-delete-${app.slug}`}
          style={dangerBtnStyle}
          aria-label={`Delete ${app.name}`}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * Inline SVG sparkline. Renders SPARKLINE_DAYS bars, height scaled to
 * the largest bin. Bins of 0 render as a flat baseline for visual
 * continuity. Peak bars get the solid accent color; others get a
 * lighter tint so the trend reads at a glance.
 */
function Sparkline({ bins }: { bins: number[] | null }) {
  const barGap = 3;
  const totalHeight = 32;
  // Loading state: skeleton bars at a flat baseline tint.
  if (bins === null) {
    return (
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: barGap,
          height: totalHeight,
        }}
      >
        {Array.from({ length: SPARKLINE_DAYS }).map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              background: 'var(--line)',
              borderRadius: 2,
              opacity: 0.5,
            }}
          />
        ))}
      </div>
    );
  }
  const peak = Math.max(...bins, 1);
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: barGap,
        height: totalHeight,
      }}
    >
      {bins.map((count, i) => {
        const ratio = count / peak;
        // Baseline 3px so empty days still read as a bar, not a gap.
        const height = Math.max(3, Math.round(ratio * totalHeight));
        const isPeak = count === peak && count > 0;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height,
              background: isPeak
                ? 'var(--accent)'
                : count > 0
                  ? 'var(--accent-soft, #d7f1e0)'
                  : 'var(--line)',
              borderRadius: 2,
              transition: 'height 0.3s ease',
            }}
          />
        );
      })}
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

const dangerBtnStyle: React.CSSProperties = {
  padding: '7px 12px',
  background: 'transparent',
  border: '1px solid #f4b7b1',
  borderRadius: 6,
  fontSize: 12,
  color: '#c2321f',
  fontFamily: 'inherit',
  cursor: 'pointer',
  flex: 1,
  textAlign: 'center',
  whiteSpace: 'nowrap',
};
