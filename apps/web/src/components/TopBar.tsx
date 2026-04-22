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
  /**
   * Studio-only mobile hamburger. When set, renders a second hamburger
   * button (visible <768px only, hidden on desktop) that opens the
   * Studio sidebar drawer. Fires when the user taps it. StudioLayout
   * wires this up; store pages leave it undefined. Added 2026-04-20
   * nav-polish pass — replaces the bottom-left floating ☰ that never
   * belonged in the chrome.
   */
  onStudioMenuOpen?: () => void;
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
  padding: 'var(--topbar-publish-padding, 9px 16px)',
  background: 'var(--accent)',
  color: '#fff',
  border: '1px solid var(--accent)',
  boxShadow: '0 4px 14px rgba(4,120,87,0.28), inset 0 1px 0 rgba(255,255,255,0.18)',
};

const menuItemStyle: CSSProperties = {
  display: 'block',
  padding: '8px 12px',
  fontSize: 13,
  color: 'var(--ink)',
  textDecoration: 'none',
  borderRadius: 6,
};

// Mode-toggle pill. Replaces the scattered "| Studio" breadcrumb + "← Store"
// CTA pattern that used to live in the studio branch of this TopBar (and
// confused Federico — two competing back affordances on /studio/build).
//
// Rendered for authenticated users on every surface: both sides always
// visible, current side highlighted black-on-white. Clicking the inactive
// side switches modes. No back arrows, no breadcrumbs — the pill IS the
// mode indicator.
const pillWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 3,
  borderRadius: 999,
  border: '1px solid var(--line)',
  background: 'var(--card)',
  gap: 0,
};
function pillSideStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '6px 14px',
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1,
    textDecoration: 'none',
    color: active ? '#fff' : 'var(--muted)',
    background: active ? 'var(--ink)' : 'transparent',
    transition: 'background 0.15s, color 0.15s',
  };
}

// MVP TopBar — one header, one pattern.
//
// After the 2026-04-20 nav unification: same shape on every surface.
// Logo (home) | Store/Studio pill toggle (authed only) | profile or
// sign-in. No context-specific breadcrumbs, no back arrows in the
// header, no hidden "← Creator dashboard" inside page bodies.
//
// Loading / OSS mode shows "Sign in" + "Publish an app" instead of the
// pill; the logged-in cloud user gets the pill + avatar dropdown.
//
// Mobile: hamburger menu keeps the same links plus a sign-in / sign-out
// entry.
export function TopBar({ compact = false, onStudioMenuOpen }: Props = {}) {
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

  const isStudio = location.pathname.startsWith('/studio');
  // Store pill stays active on /store AND on /apps (same underlying
  // AppsDirectoryPage) AND on /p/:slug (an app run page is still a
  // store surface). Nav cleanup 2026-04-22: the prior triplet Store ·
  // Studio · Run was dropped because Run pointed at the same component
  // as Store — visually and functionally redundant. The runtime
  // surface ("what have I run") lives on /me, linked on the right.
  const isApps =
    location.pathname === '/apps' ||
    location.pathname.startsWith('/apps/') ||
    location.pathname.startsWith('/p/');
  const isLoginPage =
    location.pathname === '/login' || location.pathname === '/signup';
  const ownedAppCount = myApps?.length ?? 0;
  const deployHref = isAuthenticated ? '/studio/build' : '/signup?next=%2Fstudio%2Fbuild';

  // Nav-polish 2026-04-20: pill is now visible to EVERY visitor, authed
  // or not. Federico's call: showing "Store | Studio" to logged-out
  // users advertises Studio as a destination, drives signup. Anon users
  // clicking Studio land on /studio's anon landing (which auth-gates to
  // /login via BaseLayout), so the click still has a safe destination.
  // Hidden only on /login and /signup so the auth flow is visually
  // quiet.
  const showPill = !isLoginPage;

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
          // #82 (2026-04-21): make the inner container a positioning
          // context so the centred pill can sit absolutely in the
          // middle, independent of left/right column widths. Without
          // this, unequal sides (logo on the left vs Me+Docs+avatar on
          // the right) visually shifted the pill off-centre.
          position: 'relative',
        }}
      >
        {/* Logo: always links home. No context-specific destination,
            no breadcrumb alongside. Federico's audit: "floom | Studio"
            next to the logo looked like a breadcrumb competing with the
            back arrow. Killed. */}
        <Link
          to="/"
          className="brand"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            textDecoration: 'none',
            color: 'var(--ink)',
            flexShrink: 0,
          }}
          aria-label="Floom home"
        >
          <Logo size={compact ? 18 : 20} withWordmark={!compact} variant="glow" />
        </Link>

        {/* Studio-only mobile menu trigger. Visible <768px AND only on
            /studio/* (onStudioMenuOpen is undefined everywhere else).
            Replaces the bottom-left floating ☰ that used to live in
            StudioLayout — that affordance was invisible on the TopBar
            and confused Federico. Now it sits right where a sidebar
            toggle belongs: next to the logo, in the header.
            CSS `.topbar-studio-toggle` hides it >=768px. */}
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

        {/* Middle slot: Store/Studio pill (every visitor), nothing on
            /login + /signup.
            #82 (2026-04-21): the pill is absolutely centred within the
            topbar-inner container so it sits exactly on the horizontal
            midline regardless of how wide the logo or the right-side
            nav (Me · Docs · avatar) get. The previous flex-1 + center
            pattern left it optically off-centre whenever the two
            flanks had different widths, which is always.
            Nav cleanup 2026-04-22: dropped the third "Run" pill side.
            It pointed at /apps, which renders the same
            AppsDirectoryPage as /store — the two sides were literally
            the same page under different labels. "Where do I run my
            apps?" is answered by /me (on the right side of the nav,
            shows the user's run history + tiles for apps they've
            run). */}
        {showPill && (
          <nav
            className="topbar-links topbar-links-desktop topbar-pill-nav"
            aria-label="Primary"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'auto',
            }}
          >
            <div style={pillWrapStyle} role="group" aria-label="Switch section">
              <Link
                to="/store"
                data-testid="topbar-mode-store"
                aria-current={!isStudio && !isApps ? 'page' : undefined}
                style={pillSideStyle(!isStudio && !isApps)}
              >
                Store
              </Link>
              <Link
                to="/studio"
                data-testid="topbar-mode-studio"
                aria-current={isStudio ? 'page' : undefined}
                style={pillSideStyle(isStudio)}
              >
                Studio{ownedAppCount > 0 ? ` (${ownedAppCount})` : ''}
              </Link>
            </div>
          </nav>
        )}

        <div
          className="topbar-links topbar-links-desktop"
          style={{
            gap: 'var(--topbar-right-gap, 10px)',
            marginLeft: 'auto',
            alignItems: 'center',
          }}
        >
          {/* #82 + #249 (2026-04-21): Me + Docs as first-class nav peers
              on the right side. Spec: "Store · Studio (N) · Me · Docs"
              across every route. "Me" answers Federico's #249 question
              "where is the runtime where I can actually run my apps?"
              — /me is the signed-in runtime surface (apps you've run +
              run history). Docs sits next to it because it's the other
              always-available destination. Authed users only for Me;
              Docs is visible to everyone so anonymous visitors can
              still reach the protocol spec. Hidden on /login + /signup
              so the auth flow stays quiet. */}
          {!isLoginPage && isAuthenticated && (
            <Link
              to="/me"
              data-testid="topbar-me"
              aria-current={location.pathname.startsWith('/me') ? 'page' : undefined}
              style={{
                ...navBaseStyle,
                color: location.pathname.startsWith('/me') ? 'var(--ink)' : 'var(--muted)',
              }}
            >
              Me
            </Link>
          )}
          {!isLoginPage && (
            <Link
              to="/protocol"
              data-testid="topbar-docs"
              aria-current={location.pathname.startsWith('/protocol') ? 'page' : undefined}
              style={{
                ...navBaseStyle,
                color: location.pathname.startsWith('/protocol') ? 'var(--ink)' : 'var(--muted)',
              }}
            >
              Docs
            </Link>
          )}

          {!isAuthenticated && !isLoginPage && (
            <>
              <Link
                to="/login"
                data-testid="topbar-signin"
                style={secondaryCtaStyle}
              >
                Sign in
              </Link>
              <Link
                to={deployHref}
                style={primaryCtaStyle}
              >
                <span className="topbar-publish-label-full">Publish an app</span>
                <span className="topbar-publish-label-tablet">Publish</span>
              </Link>
            </>
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
                <span style={{ fontSize: 13, color: 'var(--ink)' }} className="topbar-user-label">
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

        {/* Global mobile hamburger. Hidden on /studio/* because the
            studio-toggle on the left becomes the single mobile menu
            entry there — tapping it opens one unified drawer with
            studio nav + global items (see StudioLayout). Without this
            gate we'd render two side-by-side hamburgers on mobile
            /studio, which Federico's audit flagged as cluttered.
            CSS hook: `.topbar` with `data-context="studio"` hides the
            right hamburger on mobile. */}
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

            {/* Authed users see a compact mode switch up top so the
                pill has a mobile equivalent. The rest of the drawer
                mirrors the desktop primary destinations. */}
            {showPill && (
              <div
                role="group"
                aria-label="Switch mode"
                style={{
                  margin: '4px 20px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  padding: 3,
                  borderRadius: 999,
                  border: '1px solid var(--line)',
                  background: 'var(--card)',
                }}
              >
                <Link
                  to="/store"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-mode-store"
                  style={{
                    ...pillSideStyle(!isStudio && !isApps),
                    flex: 1,
                    padding: '8px 10px',
                  }}
                >
                  Store
                </Link>
                <Link
                  to="/studio"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-mode-studio"
                  style={{
                    ...pillSideStyle(isStudio),
                    flex: 1,
                    padding: '8px 10px',
                  }}
                >
                  Studio{ownedAppCount > 0 ? ` (${ownedAppCount})` : ''}
                </Link>
              </div>
            )}

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
