import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from './Logo';
import { useSession, clearSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
import * as api from '../api/client';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Props {
  onSignIn?: () => void;
}

const navBaseStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '8px 10px',
  borderRadius: 999,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1,
  textDecoration: 'none',
  color: 'var(--muted)',
  transition: 'background 0.15s, color 0.15s, border-color 0.15s',
};

const secondaryCtaStyle: CSSProperties = {
  ...navBaseStyle,
  border: '1px solid var(--line)',
  color: 'var(--ink)',
  background: 'rgba(255,255,255,0.72)',
  padding: '8px 14px',
};

const primaryCtaStyle: CSSProperties = {
  ...navBaseStyle,
  padding: '9px 16px',
  background: 'var(--ink)',
  color: '#fff',
  border: '1px solid var(--ink)',
  boxShadow: '0 8px 20px rgba(14,14,12,0.08)',
};

const menuItemStyle: CSSProperties = {
  display: 'block',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--ink)',
  textDecoration: 'none',
  borderRadius: 6,
};

function navStyle(active: boolean): CSSProperties {
  return {
    ...navBaseStyle,
    color: active ? 'var(--ink)' : 'var(--muted)',
    background: active ? 'rgba(5, 150, 105, 0.08)' : 'transparent',
  };
}

// MVP TopBar.
//
// Two states:
//   1. Loading / OSS mode (local user) — show "Sign in" CTA that links to /login.
//   2. Logged in — show avatar + name + dropdown (My dashboard / Creator /
//      Settings / Sign out).
//
// The workspace switcher is deferred — see docs/DEFERRED-UI.md and
// feature/ui-workspace-switcher. Every user auto-lands in their personal
// workspace on signup; the backend still returns workspaces +
// active_workspace in /api/session/me and the routes stay live, so the
// switcher is a UI-only concern.
//
// Mobile: hamburger menu keeps the same links plus a sign-in / sign-out
// entry.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function TopBar(_props: Props = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const { data, isAuthenticated, refresh } = useSession();
  const { apps: myApps } = useMyApps();
  const navigate = useNavigate();
  const location = useLocation();
  const dropRef = useRef<HTMLDivElement>(null);

  const isHome = location.pathname === '/';
  const selfHostHref = isHome ? '#self-host' : '/#self-host';
  const isDocs = location.pathname.startsWith('/protocol') || location.pathname === '/docs';
  const isStore = location.pathname.startsWith('/apps') || location.pathname.startsWith('/p/');
  const isStudio = location.pathname.startsWith('/studio');
  const isMe = location.pathname === '/me' || location.pathname.startsWith('/me/');
  // Legacy deploy/creator paths route to /studio/build now.
  const isDeploy = location.pathname.startsWith('/studio/build') || location.pathname.startsWith('/build');
  const isLoginPage =
    location.pathname === '/login' || location.pathname === '/signup';
  const ownedAppCount = myApps?.length ?? 0;
  const showStudioLink = isAuthenticated && ownedAppCount > 0;
  const deployHref = isAuthenticated ? '/studio/build' : '/signup?next=%2Fstudio%2Fbuild';

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, location.hash]);

  async function handleLogout() {
    try {
      await api.signOut();
    } catch {
      // ignore network errors — still clear client state.
    }
    clearSession();
    await refresh();
    setDropOpen(false);
    navigate('/');
  }

  const user = data?.user;
  const userLabel = user?.name || user?.email?.split('@')[0] || 'user';
  const userInitial = userLabel.charAt(0).toUpperCase();

  return (
    <header className="topbar" data-context={isStudio ? 'studio' : 'store'}>
      <div
        className="topbar-inner"
        style={{
          maxWidth: 1180,
          gap: 16,
        }}
      >
        <Link
          to={isStudio ? '/studio' : '/'}
          className="brand"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            textDecoration: 'none',
            color: 'var(--ink)',
            flexShrink: 0,
          }}
          aria-label={isStudio ? 'Floom Studio' : 'Floom home'}
        >
          <Logo size={26} withWordmark={true} />
          {isStudio && (
            <span
              data-testid="topbar-studio-breadcrumb"
              style={{
                marginLeft: 10,
                paddingLeft: 10,
                borderLeft: '1px solid var(--line)',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--muted)',
              }}
            >
              Studio
            </span>
          )}
        </Link>

        {!isStudio && (
        <nav
          className="topbar-links topbar-links-desktop"
          aria-label="Desktop navigation"
          style={{
            flex: 1,
            justifyContent: 'center',
            gap: 10,
          }}
        >
          <Link
            to="/apps"
            data-testid="topbar-apps"
            aria-current={isStore ? 'page' : undefined}
            style={navStyle(isStore)}
          >
            Store
          </Link>
          {showStudioLink && (
            <Link
              to="/studio"
              data-testid="topbar-studio"
              aria-current={false}
              style={navStyle(false)}
            >
              Studio
              {ownedAppCount > 0 && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--muted)',
                    background: 'var(--bg)',
                    borderRadius: 999,
                    padding: '1px 6px',
                  }}
                >
                  {ownedAppCount}
                </span>
              )}
            </Link>
          )}
          {isAuthenticated && (
            <Link
              to="/me"
              data-testid="topbar-me"
              aria-current={isMe ? 'page' : undefined}
              style={navStyle(isMe)}
            >
              Me
            </Link>
          )}
          <Link
            to="/protocol"
            data-testid="topbar-protocol"
            aria-current={isDocs ? 'page' : undefined}
            style={navStyle(isDocs)}
          >
            Docs
          </Link>
          {!isAuthenticated && (
            <a
              href={selfHostHref}
              aria-current={isHome && location.hash === '#self-host' ? 'page' : undefined}
              style={navStyle(isHome && location.hash === '#self-host')}
            >
              Self-host
            </a>
          )}
        </nav>
        )}

        {isStudio && <div style={{ flex: 1 }} />}

        <div
          className="topbar-links topbar-links-desktop"
          style={{
            gap: 10,
            marginLeft: 'auto',
          }}
        >
          {!isAuthenticated && !isLoginPage && (
            <Link
              to="/login"
              data-testid="topbar-signin"
              style={secondaryCtaStyle}
            >
              Sign in
            </Link>
          )}

          {!isStudio && !showStudioLink && (
            <Link
              to={deployHref}
              aria-current={isDeploy ? 'page' : undefined}
              style={{
                ...primaryCtaStyle,
                background: isDeploy ? 'var(--accent)' : primaryCtaStyle.background,
                borderColor: isDeploy ? 'var(--accent)' : 'var(--ink)',
              }}
            >
              Publish an app
            </Link>
          )}
          {isStudio && (
            <Link
              to="/"
              data-testid="topbar-back-to-store"
              style={secondaryCtaStyle}
            >
              ← Store
            </Link>
          )}

          {isAuthenticated && data && (
            <div ref={dropRef} style={{ position: 'relative', marginLeft: 2 }}>
              <button
                type="button"
                onClick={() => setDropOpen((v) => !v)}
                data-testid="topbar-user-trigger"
                aria-label="Account menu"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 10px 4px 4px',
                  border: '1px solid var(--line)',
                  borderRadius: 999,
                  background: 'var(--card)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {user?.image ? (
                  <img
                    src={user.image}
                    alt=""
                    width={24}
                    height={24}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      objectFit: 'cover',
                    }}
                  />
                ) : (
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: 'var(--accent)',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                    data-testid="topbar-user-avatar-initial"
                  >
                    {userInitial}
                  </span>
                )}
                <span style={{ fontSize: 13, color: 'var(--ink)' }}>{userLabel}</span>
              </button>
              {dropOpen && (
                <div
                  role="menu"
                  data-testid="topbar-user-menu"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    minWidth: 200,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
                    padding: 4,
                    zIndex: 50,
                  }}
                >
                  <Link
                    to="/me"
                    onClick={() => setDropOpen(false)}
                    role="menuitem"
                    style={menuItemStyle}
                  >
                    My dashboard
                  </Link>
                  <Link
                    to="/studio"
                    onClick={() => setDropOpen(false)}
                    role="menuitem"
                    data-testid="topbar-menu-studio"
                    style={menuItemStyle}
                  >
                    {ownedAppCount > 0 ? `Studio (${ownedAppCount})` : 'Open Studio →'}
                  </Link>
                  <Link
                    to="/me/settings"
                    onClick={() => setDropOpen(false)}
                    role="menuitem"
                    style={menuItemStyle}
                  >
                    Settings
                  </Link>
                  <div
                    style={{ height: 1, background: 'var(--line)', margin: '4px 0' }}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    onClick={handleLogout}
                    role="menuitem"
                    data-testid="topbar-logout"
                    style={{
                      ...menuItemStyle,
                      background: 'transparent',
                      border: 'none',
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer',
                      color: 'var(--ink)',
                      fontFamily: 'inherit',
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          className="hamburger topbar-hamburger"
          data-testid="hamburger"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>

      {menuOpen && (
        <div className="topbar-mobile-menu" role="menu" aria-label="Mobile navigation">
          <Link
            to="/apps"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            Store
          </Link>
          <Link
            to="/protocol"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            Docs
          </Link>
          <a
            href={selfHostHref}
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            Self-host
          </a>
          {!isAuthenticated && (
            <Link
              to={deployHref}
              className="topbar-mobile-link"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              Publish an app
            </Link>
          )}
          {isAuthenticated ? (
            <>
              <Link
                to="/me"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                My dashboard
              </Link>
              <Link
                to="/studio"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                {ownedAppCount > 0 ? `Studio (${ownedAppCount})` : 'Open Studio →'}
              </Link>
              <Link
                to="/me/settings"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                Settings
              </Link>
              <button
                type="button"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void handleLogout();
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'var(--ink)',
                  fontFamily: 'inherit',
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            !isLoginPage && (
              <Link
                to="/login"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                Sign in
              </Link>
            )
          )}
        </div>
      )}
    </header>
  );
}
