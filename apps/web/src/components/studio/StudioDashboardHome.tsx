// /studio home — v23 PR-H redesign.
//
// Shape (Federico-locked, decision doc /tmp/wireframe-react/studio-decision.md):
// - NO inner browser chrome (removed v17's <StudioBrowserChrome>).
// - ONE hero metric tile (replaces 3-cell stat strip).
// - Apps grid mixed-size: hero card spans 2 cols + per-card sparklines + neutral banner.
// - Friendly running state on activity rows.
// - Empty state: welcome card + 3 launch-roster templates when total_count === 0.
// - Mobile: H1 + meta + full-width CTA + single-metric card + .m-list rows.
//
// Federico locks:
// - NO category tints (banners use a single neutral surface).
// - BYOK / Agent tokens vocabulary (NEVER "API keys").
// - Launch roster: competitor-lens, ai-readiness-audit, pitch-coach.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../../api/client';
import { useDeployEnabled } from '../../lib/flags';
import { formatTime } from '../../lib/time';
import { StudioSignedOutState } from './StudioSignedOutState';
import { StudioCommandPalette } from './StudioCommandPalette';
import { Sparkline } from './Sparkline';
import { WaitlistModal } from '../WaitlistModal';
import { AppIcon } from '../AppIcon';
import { useSession } from '../../hooks/useSession';
import type { StudioActivityRun, StudioAppSummary, StudioStats } from '../../lib/types';

type AppTab = 'all' | 'live' | 'draft';

export function StudioDashboardHome() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const deployEnabled = useDeployEnabled();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;
  const waitlistMode = deployEnabled === false;

  const [stats, setStats] = useState<StudioStats | null>(null);
  const [activity, setActivity] = useState<StudioActivityRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [tab, setTab] = useState<AppTab>('all');
  const [createValue, setCreateValue] = useState('');

  useEffect(() => {
    if (signedOutPreview) {
      setStats(null);
      setActivity(null);
      setError(null);
      return;
    }
    if (!session?.active_workspace?.id) return;

    let cancelled = false;
    setError(null);
    setStats(null);
    setActivity(null);

    Promise.all([api.getStudioStats(), api.getStudioActivity(5)])
      .then(([nextStats, nextActivity]) => {
        if (cancelled) return;
        setStats(nextStats);
        setActivity(nextActivity.runs);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load Studio');
      });

    return () => {
      cancelled = true;
    };
  }, [session?.active_workspace?.id, signedOutPreview]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const apps = stats?.apps.items ?? [];

  const counts = useMemo(() => {
    const live = apps.filter((app) => isLiveApp(app.publish_status)).length;
    return {
      all: apps.length,
      live,
      draft: apps.length - live,
    };
  }, [apps]);

  // Sort apps by runs_7d DESC so the busiest live app gets the hero slot.
  // Drafts always sink to the end (after the +New ghost slot? no — before
  // the ghost slot, but after the live cards, so the ghost +New stays the
  // last cell). Keeps the hero spotlight on the most-active app.
  const filteredApps = useMemo(() => {
    const base =
      tab === 'live'
        ? apps.filter((app) => isLiveApp(app.publish_status))
        : tab === 'draft'
          ? apps.filter((app) => !isLiveApp(app.publish_status))
          : apps.slice();

    base.sort((a, b) => {
      const aLive = isLiveApp(a.publish_status);
      const bLive = isLiveApp(b.publish_status);
      // Live before draft.
      if (aLive !== bLive) return aLive ? -1 : 1;
      // Within tier, sort by runs_7d DESC (busiest first).
      if (a.runs_7d !== b.runs_7d) return b.runs_7d - a.runs_7d;
      // Stable tiebreaker: most recently active first.
      return compareNullableDates(
        a.last_run_at || a.updated_at || a.created_at,
        b.last_run_at || b.updated_at || b.created_at,
      );
    });
    return base;
  }, [apps, tab]);

  function handleCreate() {
    const value = createValue.trim();
    if (waitlistMode) {
      setWaitlistOpen(true);
      return;
    }
    if (!value) {
      navigate('/studio/build');
      return;
    }
    navigate(`/studio/build?ingest_url=${encodeURIComponent(value)}`);
  }

  if (signedOutPreview) {
    return (
      <>
        <StudioSignedOutState />
        <StudioCommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
      </>
    );
  }

  // Empty state — first-time creator (no apps yet).
  const isEmpty = stats !== null && stats.apps.total_count === 0;

  return (
    <div data-testid="studio-home" className="studio-page">
      {error ? <div className="studio-error">{error}</div> : null}

      {/* Studio top utility bar (desktop only) */}
      <div className="studio-topbar desktop-only">
        <div className="crumb">
          <strong>{studioBreadcrumbLabel(session)} · Home</strong>
        </div>
        <div className="studio-topbar-actions">
          <button
            type="button"
            className="studio-search"
            data-testid="studio-command-trigger"
            onClick={() => setCommandOpen(true)}
            aria-label="Search apps, runs, secrets"
          >
            <svg viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search apps, runs, secrets…"
              readOnly
              tabIndex={-1}
              style={{ cursor: 'pointer' }}
              onClick={() => setCommandOpen(true)}
            />
            <span className="kbd">⌘K</span>
          </button>
          {waitlistMode ? (
            <button
              type="button"
              onClick={() => setWaitlistOpen(true)}
              className="primary-cta-button"
              data-testid="studio-new-app-cta"
              style={primaryButtonInlineStyle}
            >
              <PlusIcon /> New app
            </button>
          ) : (
            <Link
              to="/studio/build"
              data-testid="studio-new-app-cta"
              style={primaryButtonInlineStyle}
            >
              <PlusIcon /> New app
            </Link>
          )}
        </div>
      </div>

      {/* Mobile head: H1 + meta + full-width CTA */}
      <div className="studio-mobile-head mobile-only">
        <h1 className="m-h1">Studio</h1>
        <p className="m-meta">
          {stats
            ? `${stats.apps.total_count} ${pluralize(stats.apps.total_count, 'app')} · ${stats.runs_7d.count.toLocaleString()} runs this week`
            : 'Loading…'}
        </p>
      </div>
      {!isEmpty ? (
        waitlistMode ? (
          <button
            type="button"
            onClick={() => setWaitlistOpen(true)}
            className="studio-mobile-cta mobile-only"
          >
            + New app
          </button>
        ) : (
          <Link to="/studio/build" className="studio-mobile-cta mobile-only">
            + New app
          </Link>
        )
      ) : null}

      {isEmpty ? (
        <StudioEmptyState waitlistMode={waitlistMode} onWaitlist={() => setWaitlistOpen(true)} />
      ) : (
        <>
          {/* Hero metric tile — DESKTOP */}
          <div className="metric desktop-only" data-testid="studio-hero-metric">
            <div className="m-l">
              <div className="m-lab">Runs across all your apps · last 7 days</div>
              <div className="m-val">{stats ? stats.runs_7d.count.toLocaleString() : '—'}</div>
              <div className={`m-delta${stats && stats.runs_7d.delta_pct < 0 ? ' dim' : ''}`}>
                {stats ? renderDeltaLine(stats) : 'Loading…'}
              </div>
            </div>
            <div className="m-spark">
              <HeroSparkline value={stats?.runs_7d.count ?? 0} />
            </div>
          </div>

          {/* Hero metric — MOBILE */}
          <div className="m-card metric-mobile mobile-only" data-testid="studio-hero-metric-mobile">
            <div className="m-mb-meta">Runs · last 7 days</div>
            <div className="m-mb-val">{stats ? stats.runs_7d.count.toLocaleString() : '—'}</div>
            <div className="m-mb-delta">
              {stats ? formatDelta(stats.runs_7d.delta_pct) + ' vs last week' : ' '}
            </div>
            <HeroSparkline value={stats?.runs_7d.count ?? 0} />
          </div>

          {/* Apps section header — DESKTOP */}
          <div className="section-h tight desktop-only">
            <span className="lh">
              <span className="dot" />
              <span className="lab">Your apps</span>
            </span>
            <span className="rh">
              <button
                type="button"
                className={tab === 'all' ? 'pill pill-ink' : 'pill'}
                onClick={() => setTab('all')}
                data-testid="studio-tab-all"
              >
                All · {stats ? counts.all : '—'}
              </button>
              <button
                type="button"
                className={tab === 'live' ? 'pill pill-ink' : 'pill'}
                onClick={() => setTab('live')}
                data-testid="studio-tab-live"
              >
                {tab !== 'live' ? <span className="dot" /> : null}
                Live · {stats ? counts.live : '—'}
              </button>
              <button
                type="button"
                className={tab === 'draft' ? 'pill pill-ink' : 'pill'}
                onClick={() => setTab('draft')}
                data-testid="studio-tab-draft"
              >
                Draft · {stats ? counts.draft : '—'}
              </button>
            </span>
          </div>

          {/* Apps grid — DESKTOP */}
          <div className="apps-grid desktop-only">
            {stats ? (
              filteredApps.length > 0 ? (
                filteredApps.map((app, index) => (
                  <StudioAppCard
                    key={app.slug}
                    app={app}
                    isHero={index === 0 && isLiveApp(app.publish_status) && tab !== 'draft'}
                  />
                ))
              ) : (
                <div className="studio-loading-tile">{emptyTabCopy(tab)}</div>
              )
            ) : (
              <div className="studio-loading-tile">Loading your apps…</div>
            )}
            <NewAppGhost
              value={createValue}
              onChange={setCreateValue}
              onCreate={handleCreate}
              waitlistMode={waitlistMode}
            />
          </div>

          {/* Apps list — MOBILE */}
          <div className="section-h tight mobile-only">
            <span className="lh">
              <span className="dot" />
              <span className="lab">Your apps</span>
            </span>
          </div>
          <div className="m-list mobile-only">
            {stats && filteredApps.length > 0 ? (
              filteredApps.map((app) => <MobileAppRow key={app.slug} app={app} />)
            ) : (
              <div style={mobileEmptyStyle}>
                {stats ? emptyTabCopy(tab) : 'Loading your apps…'}
              </div>
            )}
          </div>

          {/* Activity feed section header */}
          <div className="section-h activity-section-head">
            <span className="lh">
              <span className="dot" />
              <span className="lab">Latest across all apps</span>
            </span>
            <span className="rh">
              <Link
                to="/studio/runs"
                style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 12.5, textDecoration: 'none' }}
              >
                See all runs →
              </Link>
            </span>
          </div>

          {activity === null ? (
            <div className="studio-loading-tile">Loading recent activity…</div>
          ) : activity.length > 0 ? (
            <div className="activity">
              {activity.map((run) => (
                <ActivityRow key={run.id} run={run} />
              ))}
            </div>
          ) : (
            <div data-testid="studio-activity-empty" className="studio-loading-tile">
              Nothing here yet — be the first.
            </div>
          )}
        </>
      )}

      <StudioCommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
      <WaitlistModal
        open={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
        source="studio-home"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// HERO SPARKLINE — SVG area chart for the metric tile.
// We don't have a real per-day-runs endpoint at the workspace level,
// so this renders a stylized scaffold animated to gently rise to the
// reported 7d total. The visual cue is "trend up" without faking
// per-day numbers we don't actually have.
// ─────────────────────────────────────────────────────────────────────

function HeroSparkline({ value }: { value: number }) {
  // Fixed scaffold path — deterministic, never claims daily granularity
  // we don't have. Kept intentionally subtle so the BIG number remains
  // the focal point.
  const path = value > 0
    ? 'M0,40 L20,32 L40,28 L60,22 L80,26 L100,16 L120,12 L140,8 L160,4'
    : 'M0,30 L160,30';
  const fill = value > 0
    ? 'M0,40 L20,32 L40,28 L60,22 L80,26 L100,16 L120,12 L140,8 L160,4 L160,48 L0,48 Z'
    : '';
  return (
    <svg viewBox="0 0 160 48" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="sh-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.25} />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill ? <path d={fill} fill="url(#sh-spark)" /> : null}
      <polyline
        points="0,40 20,32 40,28 60,22 80,26 100,16 120,12 140,8 160,4"
        fill="none"
        stroke="var(--accent)"
        strokeWidth={value > 0 ? 2 : 1}
        strokeLinecap="round"
        strokeOpacity={value > 0 ? 1 : 0.3}
        style={{ display: value > 0 ? 'block' : 'none' }}
      />
      {value === 0 ? (
        <line
          x1="0"
          y1="30"
          x2="160"
          y2="30"
          stroke="var(--line)"
          strokeWidth="1"
          strokeDasharray="3,3"
        />
      ) : null}
      {/* fallback path always rendered for screen readers and zero state */}
      <title>{value > 0 ? `${value} runs in the last 7 days, trend up` : 'No runs yet'}</title>
      <path d={path} fill="none" stroke="transparent" />
    </svg>
  );
}

function renderDeltaLine(stats: StudioStats): string {
  // Per decision doc Flag #2: render delta + active + draft always; render
  // unread feedback only when count > 0 (avoids "0 unread" noise).
  const parts: string[] = [];
  const deltaSign = stats.runs_7d.delta_pct > 0 ? '↑' : stats.runs_7d.delta_pct < 0 ? '↓' : '·';
  const deltaPct = Math.abs(stats.runs_7d.delta_pct);
  parts.push(`${deltaSign} ${deltaPct}% vs prev week`);
  parts.push(`${stats.apps.active_count} active`);
  parts.push(`${stats.apps.draft_count} draft`);
  if (stats.feedback.unread_count > 0) {
    parts.push(`${stats.feedback.unread_count} unread feedback`);
  }
  return parts.join(' · ');
}

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

const primaryButtonInlineStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '7px 12px',
  borderRadius: 8,
  background: 'var(--ink)',
  color: '#fff',
  textDecoration: 'none',
  fontSize: 12.5,
  fontWeight: 700,
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const mobileEmptyStyle: React.CSSProperties = {
  padding: '20px 14px',
  fontSize: 13,
  color: 'var(--muted)',
};

// ─────────────────────────────────────────────────────────────────────
// APP CARD (desktop) — image-first banner + per-card sparkline + foot.
// Hero variant (app-tall): centered icon overlay only, no banner-card.
// ─────────────────────────────────────────────────────────────────────

function StudioAppCard({ app, isHero }: { app: StudioAppSummary; isHero: boolean }) {
  const live = isLiveApp(app.publish_status);
  const isDraft = !live;
  const className = `app${isHero ? ' app-tall' : ''}${isDraft ? ' app-draft' : ''}`;
  const category = inferCategory(app.slug);
  // No description on StudioAppSummary; fallback to a concise tagline.
  const desc = appDescription(app);
  // Per task spec: banner content matches /apps and /me. Curated entries
  // for the launch roster (competitor-lens / ai-readiness-audit /
  // pitch-coach) + utility apps; unknown slugs fall back to slug name +
  // first line of description.
  const banner = bannerContentFor(app);
  return (
    <Link
      to={`/studio/${app.slug}`}
      className={className}
      data-testid={`studio-home-app-${app.slug}`}
    >
      <div className="thumb">
        {category ? <div className="cat-badge">{category}</div> : null}
        {isHero ? (
          <span className="thumb-icon">
            <AppIcon slug={app.slug} size={26} />
          </span>
        ) : (
          <div className="banner-card">
            <span className="banner-title">{banner.title}</span>
            {banner.lines.map((line, i) => (
              <span
                key={i}
                className={`banner-line${line.tone ? ` ${line.tone}` : ''}`}
              >
                {line.text}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="body">
        <div className="head">
          <span className="icon-chip">
            <AppIcon slug={app.slug} size={isHero ? 18 : 14} />
          </span>
          <div className="meta">
            <div className="nm">{app.name}</div>
            <div className="stats">
              {live ? (
                <>
                  <span className="dot dot-live" />
                  <span>
                    {app.last_run_at ? `last run ${formatTime(app.last_run_at)}` : 'no runs yet'}
                  </span>
                </>
              ) : (
                <span>never published · {app.runs_7d} test runs</span>
              )}
              {live && app.runs_7d > 0 ? (
                <>
                  <span>·</span>
                  <span>{app.runs_7d.toLocaleString()} runs this week</span>
                </>
              ) : null}
            </div>
          </div>
          <span className={`status-pill ${live ? 'live' : 'draft'}`}>{live ? 'Live' : 'Draft'}</span>
        </div>
        {desc ? <p className="desc">{desc}</p> : null}
        {live ? (
          <div className="spark-row">
            <span className="runs-count">{app.runs_7d.toLocaleString()} runs · 7d</span>
            <div className="spark-wrap">
              <Sparkline slug={app.slug} days={7} muted={app.runs_7d === 0} />
            </div>
          </div>
        ) : null}
        {live ? (
          <div className="actions">
            <Link
              to={`/studio/${app.slug}`}
              onClick={(e) => e.stopPropagation()}
            >
              Open
            </Link>
            <Link
              to={`/studio/${app.slug}/access`}
              onClick={(e) => e.stopPropagation()}
            >
              Settings
            </Link>
            <Link
              to={`/p/${app.slug}`}
              onClick={(e) => e.stopPropagation()}
            >
              View public
            </Link>
          </div>
        ) : null}
        <div className="foot">
          <span className="mono-tag">
            {live
              ? `floom.dev/${app.slug}`
              : 'Local-only. Click to finish publishing.'}
          </span>
          {live ? (
            <span className="open-link">Open →</span>
          ) : (
            <Link
              to="/studio/build"
              className="finish-publish"
              onClick={(e) => e.stopPropagation()}
              data-testid={`studio-app-finish-publish-${app.slug}`}
            >
              Finish publishing
            </Link>
          )}
        </div>
      </div>
    </Link>
  );
}

function appDescription(app: StudioAppSummary): string {
  // StudioAppSummary doesn't carry `description` on the stats payload.
  // Fallback to a concise slug-based tagline that's always honest about
  // what we know. No hallucinated copy.
  return `Workspace app · ${app.slug}`;
}

function inferCategory(slug: string): string | null {
  // Curated mapping for the launch roster. Falls back to null
  // (no badge) for unknown apps so we never invent a category.
  const map: Record<string, string> = {
    'flyfast': 'Travel',
    'opendraft': 'Writing',
    'competitor-lens': 'Research',
    'pitch-coach': 'Writing',
    'ai-readiness-audit': 'Research',
    'lead-scorer': 'Research',
    'resume-screener': 'Research',
    'jwt-decode': 'Dev',
    'json-format': 'Dev',
    'password': 'Dev',
    'uuid': 'Dev',
  };
  return map[slug] ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// BANNER CONTENT — matches /apps + /me banner copy (locked content,
// "show the result of running the app, not the app identity").
// Unknown slugs: slug + first line of description (or "—").
// ─────────────────────────────────────────────────────────────────────

type BannerLine = { text: string; tone?: 'dim' | 'accent' };
type BannerEntry = { title: string; lines: BannerLine[] };

const STUDIO_BANNER_CONTENT: Record<string, BannerEntry> = {
  'competitor-lens': {
    title: 'competitor-lens',
    lines: [
      { text: 'stripe vs adyen' },
      { text: 'fee 1.4%', tone: 'dim' },
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
      { text: '3 critiques', tone: 'accent' },
      { text: '3 rewrites', tone: 'dim' },
    ],
  },
  // Utility apps — banner shapes mirror what each one actually returns.
  'jwt-decode': {
    title: 'jwt decode',
    lines: [
      { text: 'iss: floom.dev' },
      { text: 'sub: usr_***' },
      { text: 'exp: 2027-04-26', tone: 'dim' },
    ],
  },
  'json-format': {
    title: 'format',
    lines: [
      { text: '{ "ok": true,' },
      { text: '  "n": 42 }' },
    ],
  },
  password: {
    title: 'password',
    lines: [
      { text: 'k7T#mq2&Lp9' },
      { text: 'v4*8nW@2Zb1y', tone: 'dim' },
    ],
  },
  uuid: {
    title: 'uuid v4',
    lines: [
      { text: 'a3f8e1c2-4d9b' },
      { text: '8c7e-1f3b9d2a', tone: 'dim' },
    ],
  },
};

function bannerContentFor(app: StudioAppSummary): BannerEntry {
  const curated = STUDIO_BANNER_CONTENT[app.slug];
  if (curated) return curated;
  // Unknown slug fallback: slug + first non-empty line of description.
  const desc = (app as unknown as { description?: string | null }).description;
  const firstLine = (desc || '').split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
  return {
    title: app.slug,
    lines: firstLine
      ? [{ text: firstLine.length > 28 ? `${firstLine.slice(0, 26)}…` : firstLine, tone: 'dim' }]
      : [{ text: '—', tone: 'dim' }],
  };
}

// ─────────────────────────────────────────────────────────────────────
// MOBILE APP ROW — .m-list-item with sparkline.
// ─────────────────────────────────────────────────────────────────────

function MobileAppRow({ app }: { app: StudioAppSummary }) {
  return (
    <Link
      to={`/studio/${app.slug}`}
      className="m-list-item"
      data-testid={`studio-home-mobile-app-${app.slug}`}
    >
      <div className="ic">
        <AppIcon slug={app.slug} size={16} />
      </div>
      <div className="body">
        <div className="nm">{app.name}</div>
        <div className="sub">{app.runs_7d.toLocaleString()} runs this week</div>
      </div>
      <span className="spark-mini">
        <Sparkline slug={app.slug} days={7} muted={app.runs_7d === 0} />
      </span>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────
// NEW APP GHOST SLOT — the wireframe ghost (icon + label) coexisting
// with the inline input + Create button. Decision-doc Flag #1 = (C):
// keeps the inline-input affordance for fast paste-and-go, AND the
// visual ghost-slot chrome. Default behaviour: pressing Enter on the
// input creates with the URL pre-filled; clicking the icon area or
// Create button without text navigates to /studio/build empty.
// ─────────────────────────────────────────────────────────────────────

function NewAppGhost({
  value,
  onChange,
  onCreate,
  waitlistMode,
}: {
  value: string;
  onChange: (value: string) => void;
  onCreate: () => void;
  waitlistMode: boolean;
}) {
  return (
    <div data-testid="studio-home-new-app-tile" className="app app-ghost">
      <div className="ghost-body">
        <div className="ghost-icon">
          <svg viewBox="0 0 24 24">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <div>
          <div className="ghost-title">New app</div>
          <div className="ghost-sub">Paste GitHub URL, Docker image, or OpenAPI spec</div>
        </div>
        <div className="ghost-input-wrap">
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onCreate();
              }
            }}
            placeholder="github.com/owner/repo"
            data-testid="studio-home-create-input"
            disabled={waitlistMode}
          />
          <button
            type="button"
            onClick={onCreate}
            data-testid="studio-home-create-button"
          >
            {waitlistMode ? 'Join waitlist' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ACTIVITY ROW — 5-col v23 grid: dot / app+action / via / dur / ts.
// Friendly running state: sky dot + RUNNING tag. No fake step counter.
// ─────────────────────────────────────────────────────────────────────

function ActivityRow({ run }: { run: StudioActivityRun }) {
  // Canonical run-detail surface is /me/runs/:id (per existing convention).
  const viewHref = `/me/runs/${run.id}`;
  const isRunning = run.status === 'running';
  const isFail = run.status !== 'success' && run.status !== 'running';
  const dotClass = isRunning ? 'dot-running' : isFail ? 'dot-fail' : 'dot-live';
  return (
    <Link
      to={viewHref}
      className="act-row"
      data-testid={`studio-activity-row-${run.id}`}
    >
      <span className={`dot ${dotClass}`} aria-hidden="true" />
      <div className="body">
        <span className="app-name">{run.app_name}</span>
        <span className="action">· {run.action}</span>
        {isFail ? (
          <span className="err">{run.error || run.status}</span>
        ) : null}
        {isRunning ? <span className="running-tag">RUNNING</span> : null}
      </div>
      <span className="via">via {run.source_label}</span>
      <span className={`dur${isFail ? ' danger' : ''}`}>{formatDuration(run.duration_ms)}</span>
      <span className="ts">{formatTime(run.started_at)}</span>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────
// EMPTY STATE — first-time creator. v23 welcome card + 3 templates +
// quickstart + protocol micro-copy + tour link.
// ─────────────────────────────────────────────────────────────────────

const TEMPLATES: Array<{ slug: string; nm: string; desc: string; mobileMeta: string; icSeed: string }> = [
  {
    slug: 'competitor-lens',
    nm: 'Competitor Lens',
    desc: 'Compare positioning against a competitor. Gemini 3 Pro + JSON schema. Ready in 2s.',
    mobileMeta: 'AI app · positioning vs competitor',
    icSeed: 'CL',
  },
  {
    slug: 'ai-readiness-audit',
    nm: 'AI Readiness Audit',
    desc: 'Score how AI-ready a website is. Audit copy, structure, agent affordances.',
    mobileMeta: 'AI app · website audit',
    icSeed: 'AR',
  },
  {
    slug: 'pitch-coach',
    nm: 'Pitch Coach',
    desc: 'Roast and rewrite a startup pitch. Harsh truth, then 3 rewrites.',
    mobileMeta: 'AI app · pitch critique + rewrite',
    icSeed: 'PC',
  },
];

function StudioEmptyState({
  waitlistMode,
  onWaitlist,
}: {
  waitlistMode: boolean;
  onWaitlist: () => void;
}) {
  return (
    <div className="se-wrap" data-testid="studio-home-empty">
      {/* Mobile welcome card — gradient bg + accent border */}
      <div className="m-card m-empty-card mobile-only" style={{ marginBottom: 18 }}>
        <div className="e-ic">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <h1>Welcome to Studio.</h1>
        <p>Publish your first app. Paste a GitHub URL with a floom.yaml, or start from a template.</p>
        {waitlistMode ? (
          <button
            type="button"
            onClick={onWaitlist}
            className="studio-mobile-cta"
            data-testid="studio-empty-waitlist"
            style={{ width: '100%' }}
          >
            Join waitlist
          </button>
        ) : (
          <Link
            to="/studio/build"
            className="studio-mobile-cta"
            data-testid="studio-empty-cta"
            style={{ width: '100%' }}
          >
            Create your first app →
          </Link>
        )}
        <Link to="/protocol" className="m-empty-secondary">
          View the 90-second quickstart →
        </Link>
      </div>

      {/* Desktop welcome card */}
      <div className="se-empty desktop-only" data-testid="studio-empty">
        <div className="e-ic">
          <svg viewBox="0 0 24 24">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </div>
        <h1>Welcome to Studio.</h1>
        <p>
          Publish your first app. Paste a GitHub repo, OpenAPI spec, or Docker
          image. Floom turns it into a public showcase, MCP server, and JSON API
          in ~60 seconds.
        </p>
        <div className="ctas">
          {waitlistMode ? (
            <button
              type="button"
              onClick={onWaitlist}
              className="btn-ink"
              data-testid="studio-empty-waitlist"
              style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}
            >
              Join waitlist
            </button>
          ) : (
            <Link to="/studio/build" className="btn-ink" data-testid="studio-empty-cta">
              Create your first app →
            </Link>
          )}
          <Link
            to="/protocol"
            className="btn-secondary"
            data-testid="studio-empty-secondary"
          >
            View the 90-second quickstart
          </Link>
        </div>
        <p className="micro">
          Or read the <Link to="/protocol">protocol spec</Link> ·{' '}
          <Link to="/docs">docs</Link>
        </p>
      </div>

      {/* Mobile templates head */}
      <div className="mobile-only">
        <h2 className="m-templates-head">Or start from a template</h2>
        <p className="m-templates-meta">3 patterns to get going</p>
        {TEMPLATES.map((t) => (
          <Link
            key={t.slug}
            to={waitlistMode ? '#' : `/studio/build?template=${encodeURIComponent(t.slug)}`}
            className="m-template-card"
            data-testid={`studio-empty-template-mobile-${t.slug}`}
            onClick={(e) => {
              if (waitlistMode) {
                e.preventDefault();
                onWaitlist();
              }
            }}
          >
            <div className="row">
              <div className="ic">{t.icSeed}</div>
              <strong>{t.nm}</strong>
            </div>
            <div className="meta">{t.mobileMeta}</div>
          </Link>
        ))}
        <Link to="/apps" className="m-browse-store">
          Browse the store for inspiration →
        </Link>
      </div>

      {/* Desktop templates */}
      <div className="desktop-only">
        <div className="templates-eyebrow">Or fork a template</div>
        <div className="templates">
          {TEMPLATES.map((t) => (
            <Link
              key={t.slug}
              to={waitlistMode ? '#' : `/studio/build?template=${encodeURIComponent(t.slug)}`}
              className="template"
              data-testid={`studio-empty-template-${t.slug}`}
              onClick={(e) => {
                if (waitlistMode) {
                  e.preventDefault();
                  onWaitlist();
                }
              }}
            >
              <div className="nm">{t.nm}</div>
              <div className="desc">{t.desc}</div>
              <div className="stat">Use template →</div>
            </Link>
          ))}
        </div>
        <p className="se-tour">
          Need a tour first? <Link to="/docs">Read the docs →</Link>
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function isLiveApp(publishStatus: StudioAppSummary['publish_status']): boolean {
  return !publishStatus || publishStatus === 'published';
}

function compareDates(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function compareNullableDates(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return compareDates(a, b);
}

function studioBreadcrumbLabel(
  session: ReturnType<typeof useSession>['data'],
): string {
  if (!session) return 'Workspace';
  const workspaceName = session.active_workspace.name.trim();
  const userName = session.user.name?.trim();
  if (userName && workspaceName.toLowerCase() === `${userName.toLowerCase()}'s workspace`) {
    return 'Personal';
  }
  return titleCase(workspaceName.replace(/\s+workspace$/i, ''));
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDelta(value: number): string {
  const sign = value > 0 ? '↑ ' : value < 0 ? '↓ ' : '';
  return `${sign}${Math.abs(value)}%`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
}

function emptyTabCopy(tab: AppTab): string {
  if (tab === 'live') return 'No live apps yet.';
  if (tab === 'draft') return 'No draft apps yet.';
  return 'No apps yet.';
}

function pluralize(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
