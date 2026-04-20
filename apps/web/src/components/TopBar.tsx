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
  /**
   * Upgrade 4 (2026-04-19): shrink the TopBar when a run is active on
   * /p/:slug so the output card has more vertical real estate. Reduces
   * height (56 -> 40), tightens padding, hides the wordmark on desktop.
   * Wired by the parent page via route state — see AppPermalinkPage.
   */
  compact?: boolean;
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

// Goosebumps pass 2026-04-20: primary nav CTA is brand green so the eye
// tracks "Publish an app" as the single primary action. Black-on-white was
// generic; green ties the CTA to the brand system (accent-700 #047857) and
// matches the hero "Publish your app" submit button exactly.
const primaryCtaStyle: CSSProperties = {
  ...navBaseStyle,
  padding: '9px 16px',
  background: 'var(--accent)',
  color: '#fff',
  border: '1px solid var(--accent)',
  boxShadow: '0 4px 14px rgba(5,150,105,0.28), inset 0 1px 0 rgba(255,255,255,0.18)',
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
export function TopBar({ compact = false }: Props = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const { data, isAuthenticated, refresh } = useSession();
  const { apps: myApps } = useMyApps();
  const navigate = useNavigate();
  const location = useLocation();
  const dropRef = useRef<HTMLDivElement>(null);
  // a11y 2026-04-20: ref on the hamburger so we can return focus to it
  // when the mobile menu closes via Escape. Without this, SR/keyboard
  // users lose focus context after dismissing the menu.
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const isDocs = location.pathname.startsWith('/protocol') || location.pathname === '/docs';
  const isStore = location.pathname.startsWith('/apps') || location.pathname.startsWith('/p/');
  const isStudio = location.pathname.startsWith('/studio');
  const isMe = location.pathname === '/me' || location.pathname.startsWith('/me/');
  // Legacy deploy/creator paths route to /studio/build now.
  const isDeploy = location.pathname.startsWith('/studio/build') || location.pathname.startsWith('/build');
  const isLoginPage =
    location.pathname === '/login' || location.pathname === '/signup';
  const ownedAppCount = myApps?.length ?? 0;
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

  // a11y 2026-04-20: Escape closes the mobile menu and returns focus to
  // the hamburger button. Without this, keyboard users had no way to
  // dismiss the overlay once open.
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        hamburgerRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

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
    <header
      className="topbar"
      data-context={isStudio ? 'studio' : 'store'}
      data-compact={compact ? 'true' : 'false'}
      style={compact ? { height: 40, top: 0 } : undefined}
    >
      <div
        className="topbar-inner"
        style={{
          maxWidth: 1180,
          gap: compact ? 10 : 16,
          padding: compact ? '0 20px' : undefined,
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
          {/* v6-align 2026-04-20: use the `glow` variant so the pennant
              carries the subtle SVG halo (per PR #35) even in chrome.
              Shrunk pennant 26 -> 20 (compact 20 -> 18) and wordmark to
              14px (see Logo.tsx) so the mark stops dominating the TopBar.
              Federico's audit: "logo top left is very big and not halo
              glow". */}
          <Logo size={compact ? 18 : 20} withWordmark={!compact} variant="glow" />
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
            Apps
          </Link>
          <Link
            to="/protocol"
            data-testid="topbar-protocol"
            aria-current={isDocs ? 'page' : undefined}
            style={navStyle(isDocs)}
          >
            Docs
          </Link>
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
          {isAuthenticated && ownedAppCount > 0 && (
            <Link
              to="/studio"
              data-testid="topbar-studio"
              aria-current={isStudio ? 'page' : undefined}
              style={navStyle(isStudio)}
            >
              Studio ({ownedAppCount})
            </Link>
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

          {!isStudio && !isAuthenticated && (
            <Link
              to={deployHref}
              aria-current={isDeploy ? 'page' : undefined}
              style={primaryCtaStyle}
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
          ref={hamburgerRef}
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
        <>
          {/* Scrim: tap-outside-to-close + lock body scroll when open.
              Rendered before the drawer so the drawer sits on top. The
              scrim itself is what catches the backdrop click. */}
          <div
            className="topbar-mobile-scrim"
            role="presentation"
            aria-hidden="true"
            onClick={() => setMenuOpen(false)}
          />
          <div
            className="topbar-mobile-menu"
            role="menu"
            aria-label="Mobile navigation"
            data-testid="topbar-mobile-menu"
          >
            <div className="topbar-mobile-menu-head">
              <button
                type="button"
                className="topbar-mobile-close"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
                data-testid="topbar-mobile-close"
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Rescue 2026-04-21 (Fix 2): Apps is the primary destination on
                mobile. Make it the first item, biggest font, with a leading
                icon so the eye locks onto it immediately. Federico's audit:
                "mobile menu is broken, don't find app store on mobile fast". */}
            <Link
              to="/apps"
              className="topbar-mobile-link topbar-mobile-link-primary"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              data-testid="topbar-mobile-apps"
            >
              <MobileAppsIcon />
              <span>Apps</span>
            </Link>

            <Link
              to="/protocol"
              className="topbar-mobile-link"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              Docs
            </Link>
            {isAuthenticated && (
              <Link
                to="/me"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                Me
              </Link>
            )}
            {isAuthenticated && ownedAppCount > 0 && (
              <Link
                to="/studio"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                Studio ({ownedAppCount})
              </Link>
            )}
            {isAuthenticated && (
              <Link
                to="/me/settings"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                Settings
              </Link>
            )}

            {!isAuthenticated && !isLoginPage && (
              <Link
                to="/login"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                Sign in
              </Link>
            )}

            {/* Publish an app — green primary CTA, NOT a text link. Shown
                to both authed + anon (deployHref routes unauthed users
                through /signup first). Authed users get the full Studio
                link above instead of the CTA if they already own apps. */}
            {(!isAuthenticated || ownedAppCount === 0) && (
              <Link
                to={deployHref}
                className="topbar-mobile-cta"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                data-testid="topbar-mobile-publish"
              >
                Publish an app
              </Link>
            )}

            {isAuthenticated && (
              <button
                type="button"
                className="topbar-mobile-link topbar-mobile-link-signout"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  void handleLogout();
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </>
      )}
    </header>
  );
}

// Grid-of-squares glyph leading the primary Apps row in the mobile menu.
// Kept inline so we don't have to thread a new icon id through IconSprite.
function MobileAppsIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
