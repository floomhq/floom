import { useState, useEffect, useRef, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from './Logo';
import { useSession, clearSession } from '../hooks/useSession';
import * as api from '../api/client';
import { readDeployEnabled } from '../lib/flags';
import { waitlistHref } from '../lib/waitlistCta';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Props {
  onSignIn?: () => void;
  /**
   * Compact mode: shrink the TopBar when a run is active on /p/:slug so the
   * output card has more vertical real estate. Reduces height (56->40),
   * tightens padding, hides the wordmark on desktop.
   * Wired by the parent page via route state — see AppPermalinkPage.
   */
  compact?: boolean;
  /**
   * Studio-only mobile hamburger. When set, renders a second hamburger
   * button (visible <768px only, hidden on desktop) that opens the Studio
   * sidebar drawer. Fires when the user taps it. StudioLayout wires this up;
   * store pages leave it undefined.
   */
  onStudioMenuOpen?: () => void;
}

// v17 palette
const INK = '#0e0e0c';
const MUTED = '#585550';
const ACCENT = '#047857';
const BG = '#fafaf8';

const navLinkBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '7px 10px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1,
  textDecoration: 'none',
  color: MUTED,
  transition: 'color 0.12s',
};

function navLinkStyle(active: boolean): CSSProperties {
  return { ...navLinkBase, color: active ? INK : MUTED, fontWeight: active ? 600 : 500 };
}

const signInStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '7px 14px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1,
  textDecoration: 'none',
  color: INK,
  border: '1px solid rgba(14,14,12,0.18)',
  background: BG,
  transition: 'border-color 0.12s',
};

const signUpStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '7px 14px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1,
  textDecoration: 'none',
  color: '#fff',
  background: INK,
  border: '1px solid ' + INK,
  transition: 'opacity 0.12s',
};

const menuItemStyle: CSSProperties = {
  display: 'block',
  padding: '8px 12px',
  fontSize: 13,
  color: INK,
  textDecoration: 'none',
  borderRadius: 6,
};

// v17 TopBar — declutter 2026-04-23 (Fede: "header nav has too many items rn").
//   logged-out: Apps · Pricing · Docs + Sign in / Sign up
//   logged-in:  Apps · Pricing · Docs · Studio · Me + avatar dropdown
//
// Changelog was demoted to the footer (still linked via PublicFooter + the
// /changelog route stays live). Primary nav now holds 3 items for guests,
// 5 for authed users. Replaces the old Store/Studio pill toggle pattern.
// Mobile: hamburger collapses all links to a vertical column menu.
export function TopBar({ compact = false, onStudioMenuOpen }: Props = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const { data, isAuthenticated, refresh } = useSession();
  const deployEnabled = useMemo(() => readDeployEnabled(), []);
  const navigate = useNavigate();
  const location = useLocation();
  const dropRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const isLoginPage =
    location.pathname === '/login' || location.pathname === '/signup';

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

  // a11y: Escape closes mobile menu and returns focus to hamburger
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
      // ignore network errors — still clear client state
    }
    clearSession();
    await refresh();
    setDropOpen(false);
    navigate('/');
  }

  const user = data?.user;
  const userLabel = user?.name || user?.email?.split('@')[0] || 'user';
  const userInitial = userLabel.charAt(0).toUpperCase();

  // Active-state helpers
  const isApps =
    location.pathname === '/apps' ||
    location.pathname === '/store' ||
    location.pathname.startsWith('/apps/') ||
    location.pathname.startsWith('/store/') ||
    location.pathname.startsWith('/p/');
  const isPricing = location.pathname === '/pricing';
  const isDocs =
    location.pathname.startsWith('/protocol') ||
    location.pathname.startsWith('/docs');
  const isStudio = location.pathname.startsWith('/studio');
  const isMe = location.pathname.startsWith('/me');
  const isPublishNav =
    location.pathname === '/studio/build' || location.pathname === '/deploy';

  function goWaitlistPublish(source: string) {
    // TODO(Agent 9): open WaitlistModal instead of routing.
    navigate(waitlistHref(source));
  }

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
        {/* Logo */}
        <Link
          to="/"
          className="brand"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            textDecoration: 'none',
            color: INK,
            flexShrink: 0,
          }}
          aria-label="Floom home"
        >
          <Logo size={compact ? 18 : 20} withWordmark={!compact} variant="glow" />
        </Link>

        {/* Studio-only mobile sidebar toggle */}
        {onStudioMenuOpen && (
          <button
            type="button"
            className="topbar-studio-toggle"
            data-testid="studio-mobile-toggle"
            aria-label="Open Studio menu"
            onClick={onStudioMenuOpen}
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
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}

        {/* Centre nav: Apps · Pricing · Docs · Changelog. Hidden on /login + /signup. */}
        {!isLoginPage && (
          <nav
            className="topbar-links topbar-links-desktop topbar-centre-nav"
            aria-label="Primary"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <Link
              to="/apps"
              data-testid="topbar-apps"
              aria-current={isApps ? 'page' : undefined}
              style={navLinkStyle(isApps)}
            >
              Apps
            </Link>
            <Link
              to="/pricing"
              data-testid="topbar-pricing"
              aria-current={isPricing ? 'page' : undefined}
              style={navLinkStyle(isPricing)}
            >
              Pricing
            </Link>
            <Link
              to="/protocol"
              data-testid="topbar-docs"
              aria-current={isDocs ? 'page' : undefined}
              style={navLinkStyle(isDocs)}
            >
              Docs
            </Link>
            {deployEnabled ? (
              <Link
                to="/studio/build"
                data-testid="topbar-deploy"
                aria-current={isPublishNav ? 'page' : undefined}
                style={navLinkStyle(isPublishNav)}
              >
                Deploy
              </Link>
            ) : (
              <button
                type="button"
                data-testid="topbar-publish-waitlist"
                onClick={() => goWaitlistPublish('topbar-publish')}
                style={{
                  ...navLinkStyle(false),
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Publish
              </button>
            )}
            {/* Changelog demoted to footer 2026-04-23 (nav declutter). */}
            {/* Logged-in only: Studio + Me */}
            {isAuthenticated && (
              <>
                <Link
                  to="/studio"
                  data-testid="topbar-studio"
                  aria-current={isStudio ? 'page' : undefined}
                  style={navLinkStyle(isStudio)}
                >
                  Studio
                </Link>
                <Link
                  to="/me"
                  data-testid="topbar-me"
                  aria-current={isMe ? 'page' : undefined}
                  style={navLinkStyle(isMe)}
                >
                  Me
                </Link>
              </>
            )}
          </nav>
        )}

        {/* Right side: Sign in + Sign up (anon) or avatar dropdown (authed) */}
        <div
          className="topbar-links topbar-links-desktop"
          style={{
            gap: 8,
            marginLeft: 'auto',
            alignItems: 'center',
          }}
        >
          {!isAuthenticated && !isLoginPage && (
            <>
              <Link
                to="/login"
                data-testid="topbar-signin"
                style={signInStyle}
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                data-testid="topbar-signup"
                style={signUpStyle}
              >
                Sign up
              </Link>
            </>
          )}

          {isAuthenticated && data && (
            <div ref={dropRef} style={{ position: 'relative' }}>
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
                  border: '1px solid rgba(14,14,12,0.14)',
                  borderRadius: 999,
                  background: BG,
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
                      background: ACCENT,
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
                <span
                  style={{ fontSize: 13, color: INK }}
                  className="topbar-user-label"
                >
                  {userLabel}
                </span>
              </button>
              {dropOpen && (
                <div
                  role="menu"
                  data-testid="topbar-user-menu"
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    background: BG,
                    border: '1px solid rgba(14,14,12,0.12)',
                    borderRadius: 8,
                    minWidth: 200,
                    boxShadow: '0 4px 16px rgba(14,14,12,0.08)',
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
                    style={menuItemStyle}
                  >
                    Studio
                  </Link>
                  <Link
                    to="/me/api-keys"
                    onClick={() => setDropOpen(false)}
                    role="menuitem"
                    data-testid="topbar-user-api-keys"
                    style={menuItemStyle}
                  >
                    API keys
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
                    style={{
                      height: 1,
                      background: 'rgba(14,14,12,0.08)',
                      margin: '4px 0',
                    }}
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
                      color: INK,
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

        {/* Global mobile hamburger. Hidden on /studio/* (studio-toggle takes over). */}
        {!onStudioMenuOpen && (
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
        )}
      </div>

      {/* Mobile menu drawer */}
      {menuOpen && (
        <>
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

            {/* Primary nav links — column list matching desktop labels */}
            <Link
              to="/apps"
              className="topbar-mobile-link topbar-mobile-link-primary"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              data-testid="topbar-mobile-apps"
              aria-current={isApps ? 'page' : undefined}
            >
              <MobileAppsIcon />
              <span>Apps</span>
            </Link>

            <Link
              to="/pricing"
              className="topbar-mobile-link"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              data-testid="topbar-mobile-pricing"
              aria-current={isPricing ? 'page' : undefined}
            >
              Pricing
            </Link>

            <Link
              to="/protocol"
              className="topbar-mobile-link"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              data-testid="topbar-mobile-docs"
              aria-current={isDocs ? 'page' : undefined}
            >
              Docs
            </Link>

            {deployEnabled ? (
              <Link
                to="/studio/build"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                data-testid="topbar-mobile-deploy"
                aria-current={isPublishNav ? 'page' : undefined}
              >
                Deploy
              </Link>
            ) : (
              <button
                type="button"
                className="topbar-mobile-link"
                role="menuitem"
                data-testid="topbar-mobile-publish-waitlist"
                onClick={() => {
                  setMenuOpen(false);
                  goWaitlistPublish('topbar-publish-mobile');
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  font: 'inherit',
                  color: 'inherit',
                }}
              >
                Publish
              </button>
            )}

            {/* Changelog demoted to footer 2026-04-23 (nav declutter). */}

            {isAuthenticated && (
              <>
                <Link
                  to="/studio"
                  className="topbar-mobile-link"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-studio"
                  aria-current={isStudio ? 'page' : undefined}
                >
                  Studio
                </Link>
                <Link
                  to="/me"
                  className="topbar-mobile-link"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-me"
                  aria-current={isMe ? 'page' : undefined}
                >
                  Me
                </Link>
                <Link
                  to="/me/api-keys"
                  className="topbar-mobile-link"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-api-keys"
                >
                  API keys
                </Link>
                <Link
                  to="/me/settings"
                  className="topbar-mobile-link"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  Settings
                </Link>
              </>
            )}

            {!isAuthenticated && !isLoginPage && (
              <Link
                to="/login"
                className="topbar-mobile-link"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                data-testid="topbar-mobile-signin"
              >
                Sign in
              </Link>
            )}

            {!isAuthenticated && (
              <Link
                to="/signup"
                className="topbar-mobile-cta"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                data-testid="topbar-mobile-signup"
              >
                Sign up
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
