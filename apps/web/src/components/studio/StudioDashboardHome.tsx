import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../../api/client';
import { useDeployEnabled } from '../../lib/flags';
import { formatTime } from '../../lib/time';
import { StudioSignedOutState } from './StudioSignedOutState';
import { StudioCommandPalette } from './StudioCommandPalette';
import { WaitlistModal } from '../WaitlistModal';
import { AppIcon } from '../AppIcon';
import { useSession } from '../../hooks/useSession';
import type { StudioActivityRun, StudioAppSummary, StudioStats } from '../../lib/types';

type AppTab = 'all' | 'live' | 'draft';
type SortMode = 'last_run' | 'alphabetical' | 'recently_published';

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
  const [sortMode, setSortMode] = useState<SortMode>('last_run');
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

  const filteredApps = useMemo(() => {
    const base =
      tab === 'live'
        ? apps.filter((app) => isLiveApp(app.publish_status))
        : tab === 'draft'
          ? apps.filter((app) => !isLiveApp(app.publish_status))
          : apps.slice();

    base.sort((a, b) => {
      if (sortMode === 'alphabetical') {
        return a.name.localeCompare(b.name);
      }
      if (sortMode === 'recently_published') {
        return compareDates(a.created_at, b.created_at);
      }
      return compareNullableDates(
        a.last_run_at || a.updated_at || a.created_at,
        b.last_run_at || b.updated_at || b.created_at,
      );
    });
    return base;
  }, [apps, sortMode, tab]);

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

  return (
    <>
      <div
        data-testid="studio-home"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        {error ? (
          <div style={errorStyle}>{error}</div>
        ) : null}

        <div style={frameStyle}>
          <StudioBrowserChrome />
          <div style={frameBodyStyle}>
            <div style={topBarStyle}>
              <div>
                <div style={breadcrumbStyle}>
                  {studioBreadcrumbLabel(session)} · Home
                </div>
              </div>
              <div style={topBarActionsStyle}>
                <button
                  type="button"
                  data-testid="studio-command-trigger"
                  onClick={() => setCommandOpen(true)}
                  style={paletteTriggerStyle}
                >
                  <span>Command</span>
                  <kbd style={paletteKbdStyle}>⌘K</kbd>
                </button>
                {waitlistMode ? (
                  <button
                    type="button"
                    onClick={() => setWaitlistOpen(true)}
                    style={primaryButtonStyle}
                  >
                    New app
                  </button>
                ) : (
                  <Link to="/studio/build" style={primaryButtonStyle}>
                    New app
                  </Link>
                )}
              </div>
            </div>

            <div style={statsGridStyle}>
              <StatCard
                label="Runs · 7d"
                value={stats ? stats.runs_7d.count.toLocaleString() : '—'}
                sub={stats ? `${formatDelta(stats.runs_7d.delta_pct)} vs prev week` : 'Loading…'}
              />
              <StatCard
                label="Active apps"
                value={stats ? `${stats.apps.active_count} / ${stats.apps.total_count}` : '—'}
                sub={stats ? `${stats.apps.draft_count} draft` : 'Loading…'}
              />
              <StatCard
                label="Feedback · unread"
                value={stats ? String(stats.feedback.unread_count) : '—'}
                sub={stats ? `across ${stats.feedback.apps_count} apps` : 'Loading…'}
              />
            </div>

            <section style={sectionStyle}>
              <div style={sectionHeaderStyle}>
                <div>
                  <h2 style={sectionTitleStyle}>Your apps</h2>
                </div>
                <div style={sectionControlsStyle}>
                  <div style={tabsWrapStyle}>
                    <TabButton
                      active={tab === 'all'}
                      label={`All (${stats ? counts.all : '—'})`}
                      onClick={() => setTab('all')}
                    />
                    <TabButton
                      active={tab === 'live'}
                      label={`Live (${stats ? counts.live : '—'})`}
                      onClick={() => setTab('live')}
                    />
                    <TabButton
                      active={tab === 'draft'}
                      label={`Draft (${stats ? counts.draft : '—'})`}
                      onClick={() => setTab('draft')}
                    />
                  </div>
                  <label style={sortWrapStyle}>
                    <span style={sortLabelStyle}>Sort</span>
                    <select
                      value={sortMode}
                      onChange={(event) => setSortMode(event.target.value as SortMode)}
                      data-testid="studio-app-sort"
                      style={sortSelectStyle}
                    >
                      <option value="last_run">Last run</option>
                      <option value="alphabetical">Alphabetical</option>
                      <option value="recently_published">Recently published</option>
                    </select>
                  </label>
                </div>
              </div>

              <div style={appsGridStyle}>
                {stats ? (
                  filteredApps.length > 0 ? (
                    filteredApps.map((app) => (
                      <StudioAppCard key={app.slug} app={app} />
                    ))
                  ) : (
                    <div style={loadingTileStyle}>{emptyTabCopy(tab)}</div>
                  )
                ) : (
                  <div style={loadingTileStyle}>Loading your apps…</div>
                )}
                <NewAppTile
                  value={createValue}
                  onChange={setCreateValue}
                  onCreate={handleCreate}
                />
              </div>
            </section>

            <section style={activitySectionStyle}>
              <div style={activityHeaderStyle}>
                <div>
                  <h2 style={sectionTitleStyle}>Latest across all apps</h2>
                  <p style={activitySubheadStyle}>Who ran what · where · how long</p>
                </div>
                <Link to="/studio/runs" style={activityLinkStyle}>
                  See all runs →
                </Link>
              </div>

              {activity === null ? (
                <div style={emptyActivityStyle}>Loading recent activity…</div>
              ) : activity.length > 0 ? (
                <div style={activityListStyle}>
                  {activity.map((run) => (
                    <ActivityRow key={run.id} run={run} />
                  ))}
                </div>
              ) : (
                <div data-testid="studio-activity-empty" style={emptyActivityStyle}>
                  Nothing here yet — be the first.
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      <StudioCommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
      <WaitlistModal
        open={waitlistOpen}
        onClose={() => setWaitlistOpen(false)}
        source="studio-home"
      />
    </>
  );
}

function StudioBrowserChrome() {
  return (
    <div
      data-testid="studio-browser-chrome"
      aria-hidden="true"
      style={chromeStyle}
    >
      <span style={chromeDotStyle} />
      <span style={chromeDotStyle} />
      <span style={chromeDotStyle} />
      <div style={chromeUrlStyle}>floom.dev/studio</div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div style={statCardStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
      <div style={statSubStyle}>{sub}</div>
    </div>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={tabStyle(active)}
    >
      {label}
    </button>
  );
}

function StudioAppCard({ app }: { app: StudioAppSummary }) {
  const live = isLiveApp(app.publish_status);
  return (
    <article
      data-testid={`studio-home-app-${app.slug}`}
      style={appCardStyle}
    >
      <div style={appCardHeaderStyle}>
        <div style={appCardIdentityStyle}>
          <span style={appCardIconWrapStyle}>
            <AppIcon slug={app.slug} size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={appCardNameStyle}>{app.name}</div>
            <div style={appCardMetaStyle}>
              {app.last_run_at ? `Last run ${formatTime(app.last_run_at)}` : 'No runs yet'}
            </div>
          </div>
        </div>
        <StatusPill live={live} />
      </div>

      <div style={appCardRunsStyle}>{app.runs_7d.toLocaleString()} runs · 7d</div>

      <div style={appActionsStyle}>
        <Link to={`/studio/${app.slug}`} style={appActionLinkStyle}>
          Open
        </Link>
        <Link to={`/studio/${app.slug}/access`} style={appActionLinkStyle}>
          Settings
        </Link>
        <Link to={`/p/${app.slug}`} style={appActionLinkStyle}>
          View public
        </Link>
      </div>
    </article>
  );
}

function NewAppTile({
  value,
  onChange,
  onCreate,
}: {
  value: string;
  onChange: (value: string) => void;
  onCreate: () => void;
}) {
  return (
    <article data-testid="studio-home-new-app-tile" style={newAppTileStyle}>
      <div style={newAppEyebrowStyle}>New app</div>
      <div style={newAppTitleStyle}>Paste GitHub URL, Docker image, or OpenAPI spec</div>
      <div style={newAppInputShellStyle}>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCreate();
            }
          }}
          placeholder="github.com/owner/repo or https://api.example.com/openapi.json"
          data-testid="studio-home-create-input"
          style={newAppInputStyle}
        />
      </div>
      <button
        type="button"
        onClick={onCreate}
        data-testid="studio-home-create-button"
        style={newAppButtonStyle}
      >
        Create
      </button>
    </article>
  );
}

function ActivityRow({ run }: { run: StudioActivityRun }) {
  return (
    <div
      data-testid={`studio-activity-row-${run.id}`}
      style={activityRowStyle}
    >
      <span style={activityIconWrapStyle}>
        <AppIcon slug={run.app_slug} size={16} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={activityTextStyle}>
          <span style={activityStrongStyle}>{run.user_label}</span> ran{' '}
          <span style={activityStrongStyle}>{run.app_name}</span> from{' '}
          <span style={{ color: 'var(--muted)' }}>{run.source_label}</span>
        </div>
        <div style={activityMetaLineStyle}>
          <span>{formatTime(run.started_at)}</span>
          <span>·</span>
          <span>{formatDuration(run.duration_ms)}</span>
          {run.status !== 'success' ? (
            <>
              <span>·</span>
              <span style={{ color: '#b42318' }}>{run.status}</span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ live }: { live: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: live ? 5 : 0,
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: live ? 'var(--accent)' : '#92400e',
        background: live ? 'var(--accent-soft)' : '#fef3c7',
        border: live ? '1px solid #b7ead7' : '1px solid #fde68a',
        flexShrink: 0,
      }}
    >
      {live ? (
        <span
          aria-hidden="true"
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: 'var(--accent)',
            display: 'inline-block',
          }}
        />
      ) : null}
      {live ? 'Live' : 'Draft'}
    </span>
  );
}

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
  return `${value >= 0 ? '+' : ''}${value}%`;
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

const frameStyle: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 24,
  overflow: 'hidden',
  boxShadow: '0 1px 3px rgba(22,21,18,.04), 0 12px 40px rgba(22,21,18,.06)',
};

const chromeStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 14px',
  borderBottom: '1px solid var(--line)',
  background: 'var(--bg)',
};

const chromeDotStyle: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: '#d1d5db',
};

const chromeUrlStyle: CSSProperties = {
  flex: 1,
  margin: '0 12px',
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--line)',
  background: 'var(--card)',
  color: 'var(--muted)',
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 11,
};

const frameBodyStyle: CSSProperties = {
  padding: '24px 24px 26px',
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

const topBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 18,
  flexWrap: 'wrap',
};

const breadcrumbStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--ink)',
};

const topBarActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

const paletteTriggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 12,
  border: '1px solid var(--line)',
  background: 'var(--card)',
  color: 'var(--ink)',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const paletteKbdStyle: CSSProperties = {
  padding: '4px 6px',
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  color: 'var(--muted)',
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 10.5,
};

const primaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '10px 14px',
  borderRadius: 12,
  background: 'var(--ink)',
  color: '#fff',
  textDecoration: 'none',
  fontSize: 12.5,
  fontWeight: 700,
  border: 'none',
  cursor: 'pointer',
};

const statsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

const statCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '16px 18px',
  borderRadius: 18,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
};

const statLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
};

const statValueStyle: CSSProperties = {
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 32,
  fontWeight: 700,
  letterSpacing: '-0.04em',
  color: 'var(--ink)',
};

const statSubStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
};

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  flexWrap: 'wrap',
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 28,
  fontWeight: 400,
  letterSpacing: '-0.03em',
  lineHeight: 1.05,
  color: 'var(--ink)',
};

const sectionControlsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
};

const tabsWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

function tabStyle(active: boolean): CSSProperties {
  return {
    padding: '9px 12px',
    borderRadius: 999,
    border: active ? '1px solid #b7ead7' : '1px solid var(--line)',
    background: active ? 'var(--accent-soft)' : 'var(--card)',
    color: active ? 'var(--accent)' : 'var(--muted)',
    fontSize: 12.5,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

const sortWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
};

const sortLabelStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
};

const sortSelectStyle: CSSProperties = {
  padding: '9px 12px',
  borderRadius: 12,
  border: '1px solid var(--line)',
  background: 'var(--card)',
  color: 'var(--ink)',
  fontSize: 12.5,
  fontFamily: 'inherit',
};

const appsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 14,
};

const appCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '16px',
  borderRadius: 18,
  border: '1px solid var(--line)',
  background: 'var(--card)',
};

const appCardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
};

const appCardIdentityStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
};

const appCardIconWrapStyle: CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 14,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const appCardNameStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const appCardMetaStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 12,
  color: 'var(--muted)',
};

const appCardRunsStyle: CSSProperties = {
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: 12,
  color: 'var(--muted)',
};

const appActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexWrap: 'wrap',
  marginTop: 'auto',
};

const appActionLinkStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: 'var(--accent)',
  textDecoration: 'none',
};

const newAppTileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '16px',
  borderRadius: 18,
  border: '1px dashed var(--line)',
  background: 'var(--bg)',
};

const newAppEyebrowStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
};

const newAppTitleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  lineHeight: 1.4,
  color: 'var(--ink)',
};

const newAppInputShellStyle: CSSProperties = {
  borderRadius: 14,
  border: '1px solid var(--line)',
  background: 'var(--card)',
  padding: '10px 12px',
};

const newAppInputStyle: CSSProperties = {
  width: '100%',
  border: 'none',
  background: 'transparent',
  color: 'var(--ink)',
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
};

const newAppButtonStyle: CSSProperties = {
  alignSelf: 'flex-start',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '10px 14px',
  borderRadius: 12,
  border: 'none',
  background: 'var(--ink)',
  color: '#fff',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const activitySectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const activityHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  flexWrap: 'wrap',
};

const activitySubheadStyle: CSSProperties = {
  margin: '6px 0 0',
  fontSize: 13,
  color: 'var(--muted)',
};

const activityLinkStyle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 700,
  color: 'var(--accent)',
  textDecoration: 'none',
};

const activityListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 18,
  border: '1px solid var(--line)',
  overflow: 'hidden',
  background: 'var(--card)',
};

const activityRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '36px minmax(0, 1fr)',
  gap: 12,
  alignItems: 'center',
  padding: '14px 16px',
  borderBottom: '1px solid var(--line)',
};

const activityIconWrapStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 12,
  border: '1px solid var(--line)',
  background: 'var(--bg)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const activityTextStyle: CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.5,
  color: 'var(--ink)',
};

const activityStrongStyle: CSSProperties = {
  fontWeight: 700,
};

const activityMetaLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 4,
  fontSize: 12,
  color: 'var(--muted)',
};

const emptyActivityStyle: CSSProperties = {
  padding: '24px 18px',
  borderRadius: 18,
  border: '1px dashed var(--line)',
  background: 'var(--bg)',
  fontSize: 13,
  color: 'var(--muted)',
};

const loadingTileStyle: CSSProperties = {
  padding: '18px',
  borderRadius: 18,
  border: '1px dashed var(--line)',
  background: 'var(--bg)',
  fontSize: 13,
  color: 'var(--muted)',
};

const errorStyle: CSSProperties = {
  padding: '14px 16px',
  borderRadius: 16,
  border: '1px solid #f4b7b1',
  background: '#fdecea',
  color: '#5c2d26',
  fontSize: 13.5,
  lineHeight: 1.6,
};
