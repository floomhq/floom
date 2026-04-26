import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AppIcon } from '../AppIcon';
import { Logo } from '../Logo';
import * as api from '../../api/client';
import { useDeployEnabled } from '../../lib/flags';
import { waitlistHref } from '../../lib/waitlistCta';
import { useSession, clearSession } from '../../hooks/useSession';
import { colors } from '../../lib/design-tokens';
import type { StudioAppSummary } from '../../lib/types';
import { StudioWorkspaceSwitcher } from './StudioWorkspaceSwitcher';

const RAIL_WIDTH = 280;

interface Props {
  activeAppSlug?: string;
  activeSubsection?: 'overview' | 'runs' | 'secrets' | 'access' | 'renderer' | 'analytics' | 'triggers';
  signedOutPreview?: boolean;
}

export function StudioSidebar({
  activeAppSlug,
  activeSubsection = 'overview',
  signedOutPreview = false,
}: Props) {
  const { data: session, refresh } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const deployEnabled = useDeployEnabled();
  const [apps, setApps] = useState<StudioAppSummary[] | null>(null);
  const [teamCount, setTeamCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const user = session?.user;
  const activeWorkspace = session?.active_workspace;
  const workspaces = session?.workspaces ?? [];
  const newAppHref =
    deployEnabled === false ? waitlistHref('studio-sidebar') : '/studio/build';

  useEffect(() => {
    if (signedOutPreview) {
      setApps([]);
      setTeamCount(null);
      setLoadError(null);
      return;
    }
    if (!session?.active_workspace?.id) return;

    let cancelled = false;
    setLoadError(null);
    setApps(null);
    setTeamCount(null);
    api
      .getStudioStats()
      .then((stats) => {
        if (cancelled) return;
        setApps(stats.apps.items);
        setTeamCount(stats.workspace.member_count);
      })
      .catch((err) => {
        if (cancelled) return;
        setApps([]);
        setTeamCount(null);
        setLoadError(err instanceof Error ? err.message : 'Could not load Studio');
      });

    return () => {
      cancelled = true;
    };
  }, [session?.active_workspace?.id, signedOutPreview]);

  const visibleApps = useMemo(() => {
    const source = apps ?? [];
    if (!activeAppSlug) return source.slice(0, 5);
    const topFive = source.slice(0, 5);
    if (topFive.some((app) => app.slug === activeAppSlug)) return topFive;
    const active = source.find((app) => app.slug === activeAppSlug);
    return active ? [...topFive, active] : topFive;
  }, [activeAppSlug, apps]);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await api.signOut();
    } catch {
      // ignore network errors, still clear client state
    }
    clearSession();
    await refresh();
    navigate('/');
  }

  return (
    <aside
      data-studio-sidebar="true"
      aria-label="Studio navigation"
      className="studio-sidebar"
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        borderRight: '1px solid var(--line)',
        background: colors.sidebarBg,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        position: 'sticky',
        top: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '18px 16px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Link
            to="/studio"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              textDecoration: 'none',
              color: 'var(--ink)',
              minWidth: 0,
            }}
          >
            <Logo size={24} />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  letterSpacing: '-0.02em',
                  color: 'var(--ink)',
                }}
              >
                floom Studio
              </div>
            </div>
          </Link>
          <Link
            to="/apps"
            data-testid="studio-sidebar-back-to-store"
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: 'var(--muted)',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            ← Back to Store
          </Link>
        </div>

        {!signedOutPreview && activeWorkspace ? (
          <StudioWorkspaceSwitcher
            active={activeWorkspace}
            workspaces={workspaces}
            viewerName={user?.name}
          />
        ) : null}

        {signedOutPreview ? (
          <Link
            to="/login?next=%2Fstudio"
            style={primaryCtaStyle}
          >
            Sign in to open Studio
          </Link>
        ) : (
          <Link
            to={newAppHref}
            data-testid="studio-sidebar-new-app"
            style={primaryCtaStyle}
          >
            New app
          </Link>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 10px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <NavLink to="/studio" active={location.pathname === '/studio'}>
            Home
          </NavLink>
          <NavLink to="/studio/runs" active={location.pathname === '/studio/runs'}>
            All runs
          </NavLink>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <SectionLabel>Apps · {apps?.length ?? 0}</SectionLabel>
          {signedOutPreview ? (
            <RailHint>Sign in to see your Studio apps.</RailHint>
          ) : apps === null && !loadError ? (
            <RailHint>Loading your workspace…</RailHint>
          ) : loadError ? (
            <RailHint>{loadError}</RailHint>
          ) : visibleApps.length === 0 ? (
            <RailHint>
              No apps yet.{' '}
              <Link to={newAppHref} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                Create your first
              </Link>
              .
            </RailHint>
          ) : (
            visibleApps.map((app) => {
              const isActive = app.slug === activeAppSlug;
              return (
                <div key={app.slug}>
                  <Link
                    to={`/studio/${app.slug}`}
                    data-testid={`studio-sidebar-app-${app.slug}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '9px 10px',
                      borderRadius: 12,
                      background: isActive ? 'var(--card)' : 'transparent',
                      color: 'var(--ink)',
                      textDecoration: 'none',
                      border: isActive ? '1px solid var(--line)' : '1px solid transparent',
                    }}
                  >
                    <span style={appIconWrapStyle}>
                      <AppIcon slug={app.slug} size={14} />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 13,
                        fontWeight: isActive ? 700 : 600,
                      }}
                    >
                      {app.name}
                    </span>
                    <StatusPill live={isLiveApp(app.publish_status)} compact />
                  </Link>
                  {isActive ? <SubNav slug={app.slug} active={activeSubsection} /> : null}
                </div>
              );
            })
          )}
          {/* v23 Browse-the-store accent row, foot of Apps section. */}
          <Link
            to="/apps"
            data-testid="studio-sidebar-browse-store"
            className="rail-browse-store"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>Browse the store →</span>
          </Link>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <SectionLabel>Workspace</SectionLabel>
          <Link to="/me/settings" style={workspaceLinkStyle}>
            <span>Team</span>
            <span style={workspaceMetaStyle}>{teamCount ?? '—'}</span>
          </Link>
          <Link to="/me/settings?tab=studio#settings-card-studio-billing" style={workspaceLinkStyle}>
            <span>Billing</span>
          </Link>
          <Link to="/me/settings?tab=studio" style={workspaceLinkStyle}>
            <span>Settings</span>
          </Link>
        </section>
      </div>

      <div
        style={{
          padding: '14px 14px 16px',
          borderTop: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          background: colors.sidebarBg,
        }}
      >
        {user && !signedOutPreview ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={avatarStyle}>
                {user.image ? (
                  <img
                    src={user.image}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  initials(user.name || user.email || '?')
                )}
              </div>
              <div
                style={{
                  minWidth: 0,
                  fontSize: 12,
                  color: 'var(--ink)',
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.email || user.name || 'Local user'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                void handleSignOut();
              }}
              disabled={signingOut}
              style={signOutStyle(signingOut)}
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        ) : (
          <Link to="/login?next=%2Fstudio" style={workspaceLinkStyle}>
            Sign in
          </Link>
        )}
      </div>
    </aside>
  );
}

function isLiveApp(publish_status: StudioAppSummary['publish_status']): boolean {
  return !publish_status || publish_status === 'published';
}

function NavLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '9px 10px',
        borderRadius: 12,
        textDecoration: 'none',
        color: active ? 'var(--ink)' : 'var(--muted)',
        background: active ? 'var(--card)' : 'transparent',
        border: active ? '1px solid var(--line)' : '1px solid transparent',
        fontSize: 13,
        fontWeight: active ? 700 : 600,
      }}
    >
      {children}
    </Link>
  );
}

function StatusPill({ live, compact = false }: { live: boolean; compact?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compact ? '2px 7px' : '3px 9px',
        borderRadius: 999,
        fontSize: compact ? 9.5 : 10,
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

function SubNav({
  slug,
  active,
}: {
  slug: string;
  active: 'overview' | 'runs' | 'secrets' | 'access' | 'renderer' | 'analytics' | 'triggers';
}) {
  const items: Array<{
    id: 'overview' | 'runs' | 'secrets' | 'access' | 'renderer' | 'analytics' | 'triggers';
    label: string;
    to: string;
  }> = [
    { id: 'overview', label: 'Overview', to: `/studio/${slug}` },
    { id: 'runs', label: 'Runs', to: `/studio/${slug}/runs` },
    { id: 'triggers', label: 'Triggers', to: `/studio/${slug}/triggers` },
    { id: 'secrets', label: 'Secrets', to: `/studio/${slug}/secrets` },
    { id: 'access', label: 'Access', to: `/studio/${slug}/access` },
    { id: 'renderer', label: 'Renderer', to: `/studio/${slug}/renderer` },
    { id: 'analytics', label: 'Analytics', to: `/studio/${slug}/analytics` },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        margin: '6px 0 8px 42px',
        paddingLeft: 10,
        borderLeft: '1px solid var(--line)',
      }}
    >
      {items.map((item) => {
        const isOn = item.id === active;
        return (
          <Link
            key={item.id}
            to={item.to}
            data-testid={`studio-subnav-${item.id}`}
            style={{
              padding: '5px 8px',
              fontSize: 12,
              fontWeight: isOn ? 700 : 500,
              color: isOn ? 'var(--accent)' : 'var(--muted)',
              textDecoration: 'none',
              borderRadius: 8,
              background: isOn ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '0 10px 2px',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--muted)',
      }}
    >
      {children}
    </div>
  );
}

function RailHint({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: '4px 10px 6px',
        fontSize: 12,
        lineHeight: 1.55,
        color: 'var(--muted)',
      }}
    >
      {children}
    </div>
  );
}

const primaryCtaStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  padding: '11px 14px',
  borderRadius: 14,
  background: 'var(--ink)',
  color: '#fff',
  textDecoration: 'none',
  fontSize: 13,
  fontWeight: 700,
  boxSizing: 'border-box',
};

const appIconWrapStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 9,
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const workspaceLinkStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '9px 10px',
  borderRadius: 12,
  color: 'var(--ink)',
  textDecoration: 'none',
  fontSize: 13,
  fontWeight: 600,
};

const workspaceMetaStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--muted)',
};

const avatarStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 999,
  background: 'var(--accent)',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10,
  fontWeight: 700,
  flexShrink: 0,
  overflow: 'hidden',
};

function signOutStyle(disabled: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '9px 12px',
    borderRadius: 12,
    border: '1px solid var(--line)',
    background: 'var(--card)',
    color: 'var(--muted)',
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    fontFamily: 'inherit',
    opacity: disabled ? 0.7 : 1,
  };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}
