// /me/apps — v23 PR-J. Installed apps, editorial staggered layout.
//
// Wireframe: https://wireframes.floom.dev/v23/me-apps.html
// Decision doc: /tmp/wireframe-react/me-apps-decision.md
//
// What changed from the v22 ToolTile grid:
//   - H1 lede + count-bound subtitle ("N apps you've installed from /apps").
//   - Shared 5-tab MeTabStrip under the H1 (matches v23 IA across /me/*).
//   - Staggered grid: first card spans 2 cols with a 240px banner,
//     rest are 1-col with a 140px banner.
//   - Each card has a BannerCard mini-preview (mono "run-state" lines)
//     in the thumb. Federico-locked: no category tints — neutral surface.
//   - Per-card sparkline (reuses /studio Sparkline component).
//   - Tag-filter strip (local-only category filter, backend tags deferred).
//   - Mobile (≤560px) collapses to a single-column compact list.
//
// Hero card selection: most-recent installed app (decision doc Flag #1
// recommended default). Order from API is started_at DESC, so the first
// distinct slug is the most-recently used.
//
// Tab counts: apps comes from previewApps (distinct slugs from runs
// history), runs.length from runs, secrets/agentKeys via shared hooks.
// We avoid duplicating the agent-keys fetch — leave that pill blank
// here (`MeTabStrip` hides 0/undefined). Sibling pages (MeSecretsPage,
// MeAgentKeysPage) use useMyApps for the apps pill which is creator
// apps; that's a sibling-side miscount and not in scope for this PR.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MeLayout } from '../components/me/MeLayout';
import { MeTabStrip } from '../components/me/MeTabStrip';
import { InstalledAppCard } from '../components/me/InstalledAppCard';
import {
  resolveInstalledAppEntry,
  TAG_FILTER_CATEGORIES,
  type InstalledAppEntry,
} from '../components/me/installedAppContent';
import { Sparkline } from '../components/studio/Sparkline';
import { AppIcon } from '../components/AppIcon';
import { useMeCompactLayout } from '../components/me/useMeCompactLayout';
import { useSession } from '../hooks/useSession';
import { useSecrets } from '../hooks/useSecrets';
import { formatTime } from '../lib/time';
import * as api from '../api/client';
import type { MeRunSummary } from '../lib/types';

const FETCH_LIMIT = 200;

interface InstalledApp {
  slug: string;
  /** API-provided name; falls back to entry.name then slug. */
  apiName: string;
  lastUsedAt: string | null;
  lastRunId: string;
  lastRunAction: string;
  runCount: number;
  entry: InstalledAppEntry;
}

const s: Record<string, CSSProperties> = {
  // The MeLayout passes through `headerVariant="none"` so we own the
  // entire header block (H1 + tabs + filter strip). Keeping all chrome
  // in CSS classes; this object is only for the page wrapper margin.
  page: { width: '100%' },
};

export function MeAppsPage() {
  const { data: session, loading: sessionLoading, error: sessionError } = useSession();
  const { entries: secretsEntries } = useSecrets();
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [activeFilter, setActiveFilter] = useState<
    'all' | 'research' | 'writing' | 'dev' | 'utility'
  >('all');
  const compact = useMeCompactLayout();

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
      .catch(() => {
        if (!cancelled) setRuns([]);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionPending, signedOutPreview]);

  /**
   * Distinct installed apps from the run history, ordered by most-recent
   * first (the API already sorts by started_at DESC). For each slug we
   * count total runs in the fetched window — that drives the
   * "{n} runs this week" meta line and the hero card's "of your runs
   * this week" copy.
   */
  const installedApps = useMemo<InstalledApp[] | null>(() => {
    if (runs === null) return null;
    const seen = new Map<string, InstalledApp>();
    for (const run of runs) {
      if (!run.app_slug) continue;
      const existing = seen.get(run.app_slug);
      if (existing) {
        existing.runCount += 1;
        continue;
      }
      const apiName = run.app_name || run.app_slug;
      seen.set(run.app_slug, {
        slug: run.app_slug,
        apiName,
        lastUsedAt: run.started_at,
        lastRunId: run.id,
        lastRunAction: run.action,
        runCount: 1,
        entry: resolveInstalledAppEntry(run.app_slug, apiName, 1),
      });
    }
    // Refresh runCount inside entry's resolver fallback for off-roster
    // slugs so the banner line reads correctly.
    return Array.from(seen.values()).map((app) => ({
      ...app,
      entry: resolveInstalledAppEntry(app.slug, app.apiName, app.runCount),
    }));
  }, [runs]);

  const filteredApps = useMemo<InstalledApp[] | null>(() => {
    if (installedApps === null) return null;
    if (activeFilter === 'all') return installedApps;
    return installedApps.filter((a) => a.entry.category === activeFilter);
  }, [installedApps, activeFilter]);

  const totalCount = installedApps?.length ?? 0;
  const totalRuns = runs?.length ?? 0;

  const lede = useMemo(() => {
    if (totalCount === 0) {
      return "You haven't installed any apps yet — pick one from /apps.";
    }
    return `${totalCount} app${totalCount === 1 ? '' : 's'} you've installed from /apps. Pinned to /me, available in Claude.`;
  }, [totalCount]);

  return (
    <MeLayout
      activeTab="apps"
      title="Installed apps · Me · Floom"
      allowSignedOutShell={signedOutPreview}
      headerVariant="none"
    >
      <div
        className="me-apps-page"
        data-testid="me-apps-page"
        style={s.page}
      >
        {compact ? (
          <MobileHeader totalCount={totalCount} />
        ) : (
          <DesktopHeader lede={lede} />
        )}

        <MeTabStrip
          active="apps"
          counts={{
            apps: totalCount,
            runs: totalRuns,
            secrets: secretsEntries?.length,
          }}
        />

        {compact ? (
          <MobileFilter active={activeFilter} onChange={setActiveFilter} />
        ) : (
          <DesktopFilter active={activeFilter} onChange={setActiveFilter} />
        )}

        {filteredApps === null ? (
          <div className="ma-loading" data-testid="me-apps-loading">
            Loading your apps…
          </div>
        ) : installedApps && installedApps.length === 0 ? (
          <EmptyState />
        ) : filteredApps.length === 0 ? (
          <div className="ma-loading" data-testid="me-apps-filter-empty">
            No installed apps match this filter.
          </div>
        ) : compact ? (
          <MobileList apps={filteredApps} />
        ) : (
          <DesktopGrid apps={filteredApps} />
        )}
      </div>
    </MeLayout>
  );
}

function DesktopHeader({ lede }: { lede: string }) {
  return (
    <div className="ma-head" data-testid="me-apps-head">
      <div>
        <h1>Installed apps</h1>
        <p className="lede" data-testid="me-apps-lede">
          {lede}
        </p>
      </div>
      <Link
        to="/apps"
        className="browse-store"
        data-testid="me-apps-browse-store"
      >
        Browse the store →
      </Link>
    </div>
  );
}

function MobileHeader({ totalCount }: { totalCount: number }) {
  return (
    <div data-testid="me-apps-mobile-head">
      <h1 className="ma-mobile-h1">Installed apps</h1>
      <p className="ma-mobile-meta" data-testid="me-apps-mobile-meta">
        {totalCount} app{totalCount === 1 ? '' : 's'} · pinned to /me, available
        in Claude
      </p>
    </div>
  );
}

function DesktopFilter({
  active,
  onChange,
}: {
  active: 'all' | 'research' | 'writing' | 'dev' | 'utility';
  onChange: (next: typeof active) => void;
}) {
  return (
    <div className="ma-filter" data-testid="me-apps-filter">
      <span className="ma-filter-label">Tags</span>
      <div className="ma-chips">
        {TAG_FILTER_CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`tag-chip${active === cat.id ? ' on' : ''}`}
            data-testid={`me-apps-filter-${cat.id}`}
            onClick={() => onChange(cat.id)}
            aria-pressed={active === cat.id}
          >
            {cat.label}
          </button>
        ))}
      </div>
      <div className="ma-folders">Folders · coming soon</div>
    </div>
  );
}

function MobileFilter({
  active,
  onChange,
}: {
  active: 'all' | 'research' | 'writing' | 'dev' | 'utility';
  onChange: (next: typeof active) => void;
}) {
  return (
    <div className="m-filter" data-testid="me-apps-mobile-filter">
      {TAG_FILTER_CATEGORIES.map((cat) => (
        <button
          key={cat.id}
          type="button"
          className={`tag-chip${active === cat.id ? ' on' : ''}`}
          data-testid={`me-apps-mobile-filter-${cat.id}`}
          onClick={() => onChange(cat.id)}
          aria-pressed={active === cat.id}
        >
          {cat.label}
        </button>
      ))}
    </div>
  );
}

function DesktopGrid({ apps }: { apps: InstalledApp[] }) {
  if (apps.length === 0) return null;
  const [hero, ...rest] = apps;
  return (
    <div className="ma-grid" data-testid="me-apps-grid">
      <InstalledAppCard
        slug={hero.slug}
        name={hero.entry.name || hero.apiName}
        description={hero.entry.description}
        categoryLabel={hero.entry.categoryLabel}
        bannerTitle={hero.entry.bannerTitle}
        bannerLines={hero.entry.bannerLines}
        runCountThisWeek={hero.runCount}
        lastUsedAt={hero.lastUsedAt}
        tags={hero.entry.tags}
        lastRunId={hero.lastRunId}
        lastRunAction={hero.lastRunAction}
        variant="hero"
      />
      {rest.map((app) => (
        <InstalledAppCard
          key={app.slug}
          slug={app.slug}
          name={app.entry.name || app.apiName}
          description={app.entry.description}
          categoryLabel={app.entry.categoryLabel}
          bannerTitle={app.entry.bannerTitle}
          bannerLines={app.entry.bannerLines}
          runCountThisWeek={app.runCount}
          lastUsedAt={app.lastUsedAt}
          tags={app.entry.tags}
          lastRunId={app.lastRunId}
          lastRunAction={app.lastRunAction}
          variant="compact"
        />
      ))}
    </div>
  );
}

function MobileList({ apps }: { apps: InstalledApp[] }) {
  return (
    <div className="m-card" data-testid="me-apps-mobile-list">
      <div className="m-list">
        {apps.map((app) => {
          const rel = app.lastUsedAt ? formatTime(app.lastUsedAt) : null;
          const subText = rel
            ? `${app.runCount} run${app.runCount === 1 ? '' : 's'} · ${rel}`
            : `${app.runCount} run${app.runCount === 1 ? '' : 's'}`;
          return (
            <Link
              key={app.slug}
              to={`/p/${app.slug}`}
              className="m-list-item"
              data-testid={`me-apps-mobile-row-${app.slug}`}
            >
              <span className="ic" aria-hidden>
                <AppIcon slug={app.slug} size={18} />
              </span>
              <div className="body">
                <div className="nm">{app.entry.name || app.apiName}</div>
                <div className="sub">{subText}</div>
                {app.entry.tags.length > 0 ? (
                  <div className="tag-chips">
                    {app.entry.tags.slice(0, 3).map((t) => (
                      <span key={t} className="tag-chip">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <span className="ma-spark" aria-hidden>
                <Sparkline slug={app.slug} />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="ma-empty" data-testid="me-apps-used-empty">
      <h2>You haven't installed any apps yet.</h2>
      <p>
        Browse the store, install one from /apps, and it will show up here —
        pinned to /me, available in Claude.
      </p>
      <Link to="/apps" className="btn btn-accent btn-sm">
        Browse the store →
      </Link>
    </div>
  );
}
