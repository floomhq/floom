import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Logo } from './Logo';
import { useSession, refreshSession, clearSession } from '../hooks/useSession';
import * as api from '../api/client';
import type { SessionWorkspace } from '../lib/types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Props {
  onSignIn?: () => void;
}

// W4-minimal TopBar.
//
// Three states:
//   1. Loading / OSS mode (local user) — show "Sign in" CTA that links to /login.
//   2. Logged in — show avatar + name + dropdown (Settings / Workspace / Logout).
//   3. Workspace switcher only renders when the user has > 1 workspace.
//
// Mobile: hamburger menu keeps the same links as before plus a sign-in /
// logout entry.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function TopBar(_props: Props = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const { data, isAuthenticated, refresh } = useSession();
  const navigate = useNavigate();
  const dropRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
      }
      if (wsRef.current && !wsRef.current.contains(e.target as Node)) {
        setWsOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

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

  async function handleSwitchWorkspace(w: SessionWorkspace) {
    try {
      await api.switchWorkspace(w.id);
      await refreshSession();
      setWsOpen(false);
    } catch {
      // no-op
    }
  }

  const user = data?.user;
  const userLabel = user?.name || user?.email?.split('@')[0] || 'user';
  const userInitial = userLabel.charAt(0).toUpperCase();

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link
          to="/"
          className="brand"
          style={{
            display: 'flex',
            alignItems: 'center',
            textDecoration: 'none',
            color: 'var(--ink)',
          }}
        >
          <Logo size={24} />
        </Link>
        {/* Desktop nav */}
        <nav className="topbar-links topbar-links-desktop" aria-label="Desktop navigation">
          <Link to="/apps" className="topbar-nav-btn" data-testid="topbar-apps">
            apps
          </Link>
          <Link to="/protocol" className="topbar-nav-btn" data-testid="topbar-protocol">
            protocol
          </Link>
          <a
            href="https://github.com/floomhq/floom-monorepo"
            target="_blank"
            rel="noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
            data-testid="topbar-github"
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
              <use href="#icon-github" />
            </svg>
            github
          </a>

          {isAuthenticated && data ? (
            <>
              {data.workspaces.length > 1 && (
                <div ref={wsRef} style={{ position: 'relative', marginLeft: 4 }}>
                  <button
                    type="button"
                    onClick={() => setWsOpen((v) => !v)}
                    data-testid="topbar-workspace-trigger"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 10px',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      background: 'var(--bg)',
                      fontSize: 12,
                      color: 'var(--ink)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{data.active_workspace.name}</span>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                  {wsOpen && (
                    <div
                      role="menu"
                      data-testid="topbar-workspace-menu"
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
                      {data.workspaces.map((w) => (
                        <button
                          key={w.id}
                          type="button"
                          role="menuitem"
                          onClick={() => handleSwitchWorkspace(w)}
                          style={{
                            display: 'flex',
                            width: '100%',
                            padding: '8px 12px',
                            background:
                              w.id === data.active_workspace.id ? 'var(--bg)' : 'transparent',
                            border: 'none',
                            borderRadius: 6,
                            textAlign: 'left',
                            fontFamily: 'inherit',
                            fontSize: 13,
                            color: 'var(--ink)',
                            cursor: 'pointer',
                          }}
                        >
                          <span style={{ flex: 1 }}>{w.name}</span>
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{w.role}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div ref={dropRef} style={{ position: 'relative', marginLeft: 4 }}>
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
                  >
                    {userInitial}
                  </span>
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
                      to="/creator"
                      onClick={() => setDropOpen(false)}
                      role="menuitem"
                      style={menuItemStyle}
                    >
                      Creator dashboard
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
            </>
          ) : (
            <Link
              to="/login"
              className="topbar-nav-btn"
              data-testid="topbar-signin"
              style={{
                padding: '7px 14px',
                background: 'var(--ink)',
                color: '#fff',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Sign in
            </Link>
          )}
        </nav>
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
            Apps
          </Link>
          <Link
            to="/protocol"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            Protocol
          </Link>
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
                to="/creator"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                Creator
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
            <Link
              to="/login"
              className="topbar-mobile-link"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              Sign in
            </Link>
          )}
          <a
            href="https://github.com/floomhq/floom-monorepo"
            target="_blank"
            rel="noreferrer"
            className="topbar-mobile-link"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
          >
            GitHub
          </a>
        </div>
      )}
    </header>
  );
}

const menuItemStyle: CSSProperties = {
  display: 'block',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--ink)',
  textDecoration: 'none',
  borderRadius: 6,
};
