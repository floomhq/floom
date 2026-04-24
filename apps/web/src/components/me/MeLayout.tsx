// MeLayout — Studio-tabbed /me dashboard shell.
//
// Shared layout for the five /me tabs (Overview, Apps, Runs, Secrets,
// Settings). Renders the user greeting once, then a horizontal tab nav
// with ink-text + underline active state (brand green accent), then the
// page body. At 390px the tab row becomes a horizontal scroller so
// every tab stays reachable without wrapping.
//
// Why not reuse StudioLayout? Studio is the *creator* surface (darker
// background, left rail, per-app drilldown). /me is the *user* surface
// — flat horizontal tabs, single-column body, consumer chrome via
// PageShell. The two read as distinct surfaces by design (issue #547).

import type { CSSProperties, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PageShell } from '../PageShell';
import { useSession } from '../../hooks/useSession';

// Accent colour: brand green, matching wireframe.css --accent. Used for
// the active tab underline and the nothing-else-gets-colour rule.
const ACCENT = 'var(--accent, #10b981)';

export type MeTabId = 'overview' | 'apps' | 'runs' | 'secrets' | 'settings';

interface MeTab {
  id: MeTabId;
  label: string;
  href: string;
  testid: string;
}

const TABS: readonly MeTab[] = [
  { id: 'overview', label: 'Overview', href: '/me', testid: 'me-tab-overview' },
  { id: 'apps', label: 'Apps', href: '/me/apps', testid: 'me-tab-apps' },
  { id: 'runs', label: 'Runs', href: '/me/runs', testid: 'me-tab-runs' },
  { id: 'secrets', label: 'Secrets', href: '/me/secrets', testid: 'me-tab-secrets' },
  { id: 'settings', label: 'Settings', href: '/me/settings', testid: 'me-tab-settings' },
] as const;

interface MeLayoutProps {
  /** Active tab id — drives the underline + aria-current. */
  activeTab: MeTabId;
  /** Page <title> injected via PageShell. */
  title?: string;
  /** Forwarded to PageShell — signed-out shell preview for public tabs. */
  allowSignedOutShell?: boolean;
  children: ReactNode;
}

const s: Record<string, CSSProperties> = {
  shell: {
    maxWidth: 1040,
    margin: '0 auto',
    padding: '28px 24px 96px',
    width: '100%',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
    marginBottom: 20,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    border: '1px solid var(--line)',
    flexShrink: 0,
    background: 'var(--bg)',
  },
  avatarInitials: {
    width: 34,
    height: 34,
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
  greetingStack: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
    minWidth: 0,
  },
  greetingHello: {
    fontSize: 12,
    color: 'var(--muted)',
    lineHeight: 1.2,
  },
  greetingName: {
    // Wireframe typography: in-repo wireframe.css sets --font-display to
    // Inter. Display weight + tight tracking per wireframe.css rules.
    fontFamily: 'var(--font-display)',
    fontSize: 22,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 1.15,
    color: 'var(--ink)',
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 540,
  },
  tabStrip: {
    // Horizontal scroller on narrow viewports so every tab stays
    // reachable at 390px without wrapping to two rows.
    display: 'flex',
    gap: 4,
    borderBottom: '1px solid var(--line)',
    marginBottom: 28,
    overflowX: 'auto' as const,
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none' as const,
  },
  tabLink: {
    position: 'relative' as const,
    display: 'inline-flex',
    alignItems: 'center',
    padding: '10px 14px',
    fontSize: 13.5,
    fontWeight: 600,
    color: 'var(--muted)',
    textDecoration: 'none',
    borderBottom: '2px solid transparent',
    marginBottom: -1,
    whiteSpace: 'nowrap' as const,
    transition: 'color 0.15s ease, border-color 0.15s ease',
  },
  tabLinkActive: {
    color: 'var(--ink)',
    borderBottom: `2px solid ${ACCENT}`,
  },
};

export function MeLayout({
  activeTab,
  title,
  allowSignedOutShell = false,
  children,
}: MeLayoutProps) {
  const { data: session } = useSession();
  const greeting = deriveGreeting(session?.user);
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;

  return (
    <PageShell
      requireAuth="cloud"
      title={title || 'Me · Floom'}
      contentStyle={{ padding: 0, maxWidth: 'none', minHeight: 'auto' }}
      allowSignedOutShell={allowSignedOutShell || signedOutPreview}
      noIndex
    >
      <div data-testid="me-layout" style={s.shell}>
        <header style={s.header}>
          <GreetingAvatar image={greeting.image} initials={greeting.initials} />
          <div style={s.greetingStack}>
            <span data-testid="me-greeting-hello" style={s.greetingHello}>
              Hey
            </span>
            <h1 data-testid="me-greeting-name" style={s.greetingName}>
              {greeting.displayName}
            </h1>
          </div>
        </header>

        <nav
          role="tablist"
          aria-label="Dashboard tabs"
          data-testid="me-tabs"
          style={s.tabStrip}
        >
          {TABS.map((tab) => {
            const active = tab.id === activeTab;
            const style = active
              ? { ...s.tabLink, ...s.tabLinkActive }
              : s.tabLink;
            return (
              <Link
                key={tab.id}
                to={tab.href}
                data-testid={tab.testid}
                aria-current={active ? 'page' : undefined}
                role="tab"
                aria-selected={active}
                style={style}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div data-testid="me-tab-panel">{children}</div>
      </div>
    </PageShell>
  );
}

function deriveGreeting(user: {
  email: string | null;
  name: string | null;
  image: string | null;
} | undefined): { displayName: string; initials: string; image: string | null } {
  const nameRaw = (user?.name ?? '').trim();
  const email = (user?.email ?? '').trim();
  const emailLocal = email.includes('@') ? email.split('@')[0] : email;
  const displayName = nameRaw || emailLocal || 'there';
  const initials = initialsFrom(displayName);
  return { displayName, initials, image: user?.image ?? null };
}

function initialsFrom(input: string): string {
  const parts = input
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
  if (image) {
    return (
      <img
        data-testid="me-greeting-avatar"
        src={image}
        alt=""
        style={s.avatar}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
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

// Fallback used by MePage's location-aware tab picker when the router
// can't match an explicit override (e.g. deep sub-paths under /me/apps).
// Exported so pages that don't use MeLayout directly still resolve the
// same id mapping used in testids + analytics.
export function meTabFromPathname(pathname: string): MeTabId {
  if (pathname.startsWith('/me/apps')) return 'apps';
  if (pathname.startsWith('/me/runs')) return 'runs';
  if (pathname.startsWith('/me/secrets')) return 'secrets';
  if (pathname.startsWith('/me/settings') || pathname.startsWith('/me/api-keys')) return 'settings';
  return 'overview';
}

/** Hook wrapper for page components that want to infer the active tab
 *  from the current URL without threading the id manually. */
export function useMeTab(): MeTabId {
  const location = useLocation();
  return meTabFromPathname(location.pathname);
}
