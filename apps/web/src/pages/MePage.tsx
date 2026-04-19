// /me — user surface. Answers: "What can I run, and what have I run?"
//
// v18 shape (2026-04-20): /me is strictly the USER surface. Creator
// inventory ("apps you've published") has moved out entirely and lives on
// /studio, which is the creator surface. The two pages no longer overlap.
//
// Sections top to bottom:
//   1. Greeting header — "Hey {name}" + avatar, then an "Me" H1 is dropped
//      in favour of the greeting carrying the identity. A single "Browse
//      apps" link sits in the header.
//   2. "Your apps" — tiles for the apps the user has actually run before
//      (distinct slugs from run history, most-recent first, top 8).
//      Empty state = one "Try an app →" CTA pointing at /apps. No
//      "Publish your first app" CTA on /me (that's a creator action and
//      belongs in /studio).
//   3. "Recent runs" — full run history. Rows carry the first 8 chars of
//      the run id so two runs of the same slug within the same relative
//      minute render as visually distinct events.
//
// Prior v17 kept a second "apps you've published" block here which
// duplicated /studio and muddied the IA — users asked "why do I have my
// own apps here AND in studio?". Fix: remove the creator block from /me
// entirely. The TopBar "Studio" link covers that job.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { AppIcon } from '../components/AppIcon';
import { ToolTile } from '../components/me/ToolTile';
import { useSession } from '../hooks/useSession';
import * as api from '../api/client';
import { formatTime } from '../lib/time';
import type { HubApp, MeRunSummary, RunStatus } from '../lib/types';

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
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
    marginBottom: 28,
  },
  greetingWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    border: '1px solid var(--line)',
    flexShrink: 0,
    background: 'var(--bg)',
  },
  avatarInitials: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '1px solid var(--line)',
    background: 'var(--bg)',
    color: 'var(--ink)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.02em',
    flexShrink: 0,
  },
  greetingText: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    minWidth: 0,
  },
  greetingHello: {
    fontSize: 13,
    color: 'var(--muted)',
    lineHeight: 1.2,
  },
  greetingName: {
    fontFamily: "'DM Serif Display', Georgia, serif",
    fontSize: 22,
    fontWeight: 500,
    lineHeight: 1.2,
    color: 'var(--ink)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 440,
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

// Apps grid: 2 cols on narrow (375px), 3-4 cols on tablet, 4 cols on
// desktop at 820px max. Uses auto-fit with a minmax so the layout stays
// sane at any width without media queries.
const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
  gap: 12,
};

const USED_APPS_LIMIT = 8;
const CURATED_LIMIT = 6;

type UsedApp = {
  slug: string;
  name: string;
  lastUsedAt: string | null;
};

export function MePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: sessionData } = useSession();

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

  // Derive "Your apps" from runs: group by slug, take N most-recent
  // distinct slugs. Runs arrive started_at DESC from the backend, so a
  // simple first-hit-wins pass yields the correct order without sorting.
  const usedApps: UsedApp[] | null = useMemo(() => {
    if (runs === null) return null;
    const seen = new Map<string, UsedApp>();
    for (const run of runs) {
      if (!run.app_slug) continue;
      if (seen.has(run.app_slug)) continue;
      seen.set(run.app_slug, {
        slug: run.app_slug,
        name: run.app_name || run.app_slug,
        lastUsedAt: run.started_at,
      });
      if (seen.size >= USED_APPS_LIMIT) break;
    }
    return Array.from(seen.values());
  }, [runs]);

  // If the user has no runs yet, fetch the public directory and surface a
  // curated row. /api/hub returns sorted by featured DESC, avg_run_ms ASC,
  // created_at DESC, name ASC — already the order we want.
  const needsCurated = usedApps !== null && usedApps.length === 0;
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

  function openRun(run: MeRunSummary) {
    if (!run.app_slug) return;
    navigate(`/p/${run.app_slug}?run=${encodeURIComponent(run.id)}`);
  }

  const appsLoading = usedApps === null;

  // Greeting derivation: prefer display name, fall back to the local
  // part of the email, then a neutral "there". Avatar uses the Better
  // Auth session `image` field when present; otherwise we render an
  // initials circle derived from the same display name.
  const greeting = deriveGreeting(sessionData?.user);

  return (
    <PageShell
      requireAuth="cloud"
      title="Me · Floom"
      contentStyle={{ padding: 0, maxWidth: 'none', minHeight: 'auto' }}
    >
      <main data-testid="me-page" style={s.main}>
        <header style={s.header}>
          <div style={s.greetingWrap}>
            <GreetingAvatar
              image={greeting.image}
              initials={greeting.initials}
            />
            <div style={s.greetingText}>
              <span data-testid="me-greeting-hello" style={s.greetingHello}>
                Hey
              </span>
              <span data-testid="me-greeting-name" style={s.greetingName}>
                {greeting.displayName}
              </span>
            </div>
          </div>
          <Link to="/apps" data-testid="me-browse-apps" style={s.headerLink}>
            Browse apps →
          </Link>
        </header>

        {showWelcome && <WelcomeBanner onDismiss={dismissWelcome} />}

        {showNotice && (
          <AppNotFound slug={noticeSlug} onDismiss={dismissNotice} />
        )}

        {/* Your apps — the only apps section on /me. These are the apps
            the user has actually RUN (distinct slugs from run history).
            Creator inventory lives in /studio and does not appear here. */}
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
              marginBottom: 12,
            }}
          >
            <h2 style={s.sectionH2}>Your apps</h2>
            <Link to="/apps" data-testid="me-apps-browse" style={s.headerLink}>
              Browse apps →
            </Link>
          </header>

          {appsLoading ? (
            <div
              data-testid="me-apps-loading"
              style={{
                ...s.card,
                padding: 20,
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              Loading your apps…
            </div>
          ) : usedApps && usedApps.length > 0 ? (
            <div data-testid="me-apps-grid" style={gridStyle}>
              {usedApps.map((a) => (
                <ToolTile
                  key={a.slug}
                  slug={a.slug}
                  name={a.name}
                  lastUsedAt={a.lastUsedAt}
                />
              ))}
            </div>
          ) : curated === null ? (
            <div
              data-testid="me-apps-loading"
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
            <div data-testid="me-apps-empty">
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  marginBottom: 10,
                  lineHeight: 1.55,
                }}
              >
                Try one →
              </div>
              <div data-testid="me-apps-grid" style={gridStyle}>
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
                  data-testid="me-apps-empty-cta"
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
              data-testid="me-apps-empty"
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
                You haven&rsquo;t run any Floom apps yet.
              </div>
              <Link
                to="/apps"
                data-testid="me-apps-empty-cta"
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

        {/* Recent runs — full history of past runs. Rows include a short
            run-id tag so two runs of the same app within the same relative
            window read as distinct events (fixes the "UUID Generator · v4 ·
            3h ago" duplication Federico flagged). */}
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
      </main>
    </PageShell>
  );
}

/**
 * Greeting derivation: Better Auth session carries `name`, `email`, and
 * `image`. Pick the best human-readable handle in that order; fall back
 * to the email local part, then a neutral "there". Initials are derived
 * from whichever string we end up using so the avatar never looks wrong.
 */
function deriveGreeting(user: {
  email: string | null;
  name: string | null;
  image: string | null;
} | undefined): {
  displayName: string;
  initials: string;
  image: string | null;
} {
  const nameRaw = (user?.name ?? '').trim();
  const email = (user?.email ?? '').trim();
  const emailLocal = email.includes('@') ? email.split('@')[0] : email;
  const displayName = nameRaw || emailLocal || 'there';
  const initials = initialsFrom(displayName);
  return { displayName, initials, image: user?.image ?? null };
}

function initialsFrom(s: string): string {
  const parts = s
    .split(/[\s._-]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function GreetingAvatar({
  image,
  initials,
}: {
  image: string | null;
  initials: string;
}) {
  const [broken, setBroken] = useState(false);
  if (image && !broken) {
    return (
      <img
        data-testid="me-greeting-avatar"
        src={image}
        alt=""
        style={s.avatar}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      data-testid="me-greeting-avatar-initials"
      aria-hidden="true"
      style={s.avatarInitials}
    >
      {initials}
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
  const runTag = runIdShort(run.id);
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

/**
 * First 8 chars of the run id so rows of the same slug render as distinct
 * events even when their relative time ("3h ago") collapses to the same
 * bucket. Falls back to empty string if the id is missing, which lets the
 * row degrade gracefully instead of showing a literal "undefined".
 */
function runIdShort(id: string | null | undefined): string {
  if (!id) return '';
  const trimmed = id.replace(/^run_/, '');
  return trimmed.slice(0, 8);
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
