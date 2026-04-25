import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from './Logo';
import { useSession, clearSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';
import * as api from '../api/client';
import { useDeployEnabled } from '../lib/flags';
import { waitlistHref } from '../lib/waitlistCta';
import { GitHubStarsBadge } from './GitHubStarsBadge';

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

// Brand lockup sizing (#632 → 2026-04-24 rebalance): the earlier 22/700
// wordmark towered over the 14/500 nav items (Apps · Docs · Pricing) and
// felt off-balance. Step it down to 17/600 so the wordmark reads as a
// peer to the nav, not a headline. Nav items get a matching lift to
// 15/500 in wireframe.css so mark + wordmark + nav form a single
// horizontal strip where no element dominates. Compact mode (/p/:slug
// run view) still hides the wordmark entirely and shrinks the mark.
const WORDMARK_SIZE = 17;
const WORDMARK_WEIGHT = 600;
const MARK_SIZE_DEFAULT = 22;
const MARK_SIZE_COMPACT = 18;

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

// Primary Publish CTA — brand green pill, eye-draw. Always visible to
// signed-out + signed-in alike. Routes to /studio/build on preview, opens
// the waitlist on prod (waitlistMode). #572 — single primary action on the
// right side; everything else is text or chrome.
const publishCtaStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '7px 14px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1,
  textDecoration: 'none',
  color: '#fff',
  background: ACCENT,
  border: '1px solid ' + ACCENT,
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'filter 0.12s',
};

const menuItemStyle: CSSProperties = {
  display: 'block',
  padding: '8px 12px',
  fontSize: 13,
  color: INK,
  textDecoration: 'none',
  borderRadius: 6,
};

// v17 TopBar — auth-branched chrome 2026-04-25 (project_floom_nav_ia.md).
//   Anonymous (waitlist visitor / signed-out):
//     Centre: Apps · Docs · Pricing                                  (3 items)
//     Right (preview):  GH stars · Publish (CTA) · Sign in · Sign up
//     Right (waitlist): GH stars · Publish (CTA) · Join waitlist
//
//   Authenticated (deploy mode):
//     Centre: Studio · My runs                                       (2 items)
//     Right:  GH stars · + New app (CTA → /studio/build) · avatar dropdown
//     Avatar dropdown: Profile · API keys · Secrets · Pricing · Docs · Sign out
//
// Why the split: Federico 2026-04-25 — "Pricing, Docs etc don't matter
// so much when I am already logged in, so the nav and the priorities of
// what to click next change." Discovery items demote to the dropdown for
// authed users; the centre nav surfaces only their day-to-day work
// surfaces. MECE labelling: /me = "My runs" (consumer), /studio =
// "Studio" (creator). URL slugs stay; only the visible label changes.
//
// Two clean states only — never a 3rd. Preview vs prod differ in the
// CTA wording (Publish vs Join waitlist), not the nav structure.
//
// Changelog stays in the footer (#572 nav declutter, original 04-23 pass).
// Mobile: hamburger collapses everything to a vertical column menu, with
// the same anon-vs-authed split.
export function TopBar({ compact = false, onStudioMenuOpen }: Props = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const { data, isAuthenticated, refresh } = useSession();
  const { apps: myApps } = useMyApps();
  // 2026-04-24 prod/preview split: read the flag from the live session
  // payload so prod (DEPLOY_ENABLED=false) hides Sign in / Sign up even
  // when the Vite build had VITE_DEPLOY_ENABLED=true baked in. Same
  // Docker image serves both environments.
  const deployEnabledFlag = useDeployEnabled();
  // While the session is loading (`deployEnabledFlag === null`), hide
  // auth-y chrome to avoid the flash of "Sign in / Sign up + Publish"
  // that Federico flagged on preview. Treat null as "don't know yet,
  // show nothing auth-related" — Sign in re-appears as soon as we know
  // we're on preview (deploy_enabled=true).
  const deployEnabled = deployEnabledFlag === true;
  const waitlistMode = deployEnabledFlag === false;
  const studioNavLabel =
    isAuthenticated && myApps && myApps.length > 0
      ? `Studio (${myApps.length})`
      : 'Studio';
  // Auth-branched chrome: only flip to the work-focused layout when the
  // session is authenticated AND we know we're on a deploy-enabled
  // environment. Both must be true. While the deploy flag is loading
  // (deployEnabledFlag === null) treat as anon so we don't flash the
  // 2-item centre nav before settling.
  const showAuthedChrome = isAuthenticated && deployEnabled;
  const navigate = useNavigate();
  const location = useLocation();
  const dropRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const isLoginPage =
    location.pathname === '/login' || location.pathname === '/signup';
  const isSignInRoute = location.pathname === '/login';
  const isSignUpRoute = location.pathname === '/signup';

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
        {/* Logo lockup (#632): mark from <Logo /> + wordmark rendered
            directly here so we can bump font-size past Logo.tsx's baked-in
            14px. Gap 8px keeps mark and wordmark optically balanced. */}
        <Link
          to="/"
          className="brand"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
            color: INK,
            flexShrink: 0,
          }}
          aria-label="floom — home"
        >
          <Logo
            size={compact ? MARK_SIZE_COMPACT : MARK_SIZE_DEFAULT}
            withWordmark={false}
            variant="glow"
          />
          {/* Wordmark always shows — previously hidden in compact mode
              on /p/:slug run views, but Federico 2026-04-24 asked for
              consistency: the brand lockup should read the same on every
              page. Compact's height reduction (40px top bar) still
              applies; only the wordmark-hide behaviour is dropped. */}
          <span
            style={{
              fontSize: compact ? 15 : WORDMARK_SIZE,
              fontWeight: WORDMARK_WEIGHT,
              letterSpacing: '-0.02em',
              lineHeight: 1,
              color: INK,
            }}
          >
            floom
          </span>
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

        {/* Centre nav — branches on auth state (project_floom_nav_ia.md).
            Anonymous: Apps · Docs · Pricing (discovery surfaces).
            Authenticated: Studio · My runs (work surfaces). Pricing/Docs
            move to the avatar dropdown — 1 click away when needed. */}
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
          {showAuthedChrome ? (
            <>
              <Link
                to="/studio"
                data-testid="topbar-studio"
                aria-current={isStudio ? 'page' : undefined}
                style={navLinkStyle(isStudio)}
              >
                {studioNavLabel}
              </Link>
              <Link
                to="/me"
                data-testid="topbar-my-runs"
                aria-current={isMe ? 'page' : undefined}
                style={navLinkStyle(isMe)}
              >
                My runs
              </Link>
            </>
          ) : (
            <>
              <Link
                to="/apps"
                data-testid="topbar-apps"
                aria-current={isApps ? 'page' : undefined}
                style={navLinkStyle(isApps)}
              >
                Apps
              </Link>
              <Link
                to="/docs"
                data-testid="topbar-docs"
                aria-current={isDocs ? 'page' : undefined}
                style={navLinkStyle(isDocs)}
              >
                Docs
              </Link>
              <Link
                to="/pricing"
                data-testid="topbar-pricing"
                aria-current={isPricing ? 'page' : undefined}
                style={navLinkStyle(isPricing)}
              >
                Pricing
              </Link>
            </>
          )}
        </nav>

        {/* Right side: Sign in + Sign up (anon) or avatar dropdown (authed) */}
        <div
          className="topbar-links topbar-links-desktop"
          style={{
            gap: 8,
            marginLeft: 'auto',
            alignItems: 'center',
          }}
        >
          {/* GitHub stars badge — always on so social proof is visible
              whether or not the viewer is logged in. Placed before the
              auth pills so the hierarchy stays Sign-up > GH on preview,
              and GH becomes the single rightmost affordance on
              waitlist-prod (where Sign in / Sign up are hidden). */}
          {!isLoginPage && <GitHubStarsBadge compact dataTestId="topbar-gh-stars" />}

          {/* Primary CTA — brand-green pill. Authed users get "+ New app"
              (work-focused: take me to the build flow). Anonymous users
              get "Publish" (discovery-focused: learn what publishing
              means). Both route to /studio/build in deploy mode; on
              waitlist-prod the anon variant opens the waitlist instead.
              Hidden on /login + /signup so auth pages stay focused.
              While the deploy flag is loading we render nothing to avoid
              the flash. */}
          {!isLoginPage && showAuthedChrome && (
            <Link
              to="/studio/build"
              data-testid="topbar-new-app-cta"
              aria-current={isPublishNav ? 'page' : undefined}
              style={publishCtaStyle}
            >
              + New app
            </Link>
          )}
          {!isLoginPage && !showAuthedChrome && deployEnabled && (
            <Link
              to="/studio/build"
              data-testid="topbar-publish-cta"
              aria-current={isPublishNav ? 'page' : undefined}
              style={publishCtaStyle}
            >
              Publish
            </Link>
          )}
          {!isLoginPage && !showAuthedChrome && waitlistMode && (
            <button
              type="button"
              data-testid="topbar-publish-cta-waitlist"
              onClick={() => goWaitlistPublish('topbar-publish')}
              style={publishCtaStyle}
            >
              Publish
            </button>
          )}

          {/* Sign in / Sign up. Hidden in waitlist mode (floom.dev) and
              while session is still loading (prevents the "Sign in +
              Join waitlist" contradiction Federico saw on preview on
              2026-04-24). Shown on preview.floom.dev (deployEnabled). */}
          {!isAuthenticated && deployEnabled && (
            <>
              <Link
                to="/login"
                data-testid="topbar-signin"
                style={isLoginPage ? (isSignInRoute ? signUpStyle : signInStyle) : signInStyle}
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                data-testid="topbar-signup"
                style={
                  isLoginPage
                    ? (isSignUpRoute ? signUpStyle : signInStyle)
                    : signUpStyle
                }
              >
                Sign up
              </Link>
            </>
          )}

          {/* Waitlist CTA in place of Sign in / Sign up on prod. Single
              pill — don't double up with the centre-nav Publish button,
              this one speaks to visitors who don't want to Publish per
              se but do want the beta. */}
          {!isAuthenticated && !isLoginPage && waitlistMode && (
            <Link
              to={waitlistHref('topbar-waitlist')}
              data-testid="topbar-waitlist"
              style={signUpStyle}
            >
              Join waitlist
            </Link>
          )}

          {isAuthenticated && data && (
            <div ref={dropRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setDropOpen((v) => !v)}
                data-testid="topbar-user-trigger"
                aria-label="Account menu"
                aria-haspopup="menu"
                aria-expanded={dropOpen}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px 4px 4px',
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
                {/* Chevron-down affordance (#641) — signals the avatar
                    is a menu trigger, not a profile picture. Rotates
                    180° when open so the state reads at a glance. */}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={MUTED}
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  data-testid="topbar-user-chevron"
                  style={{
                    flexShrink: 0,
                    transition: 'transform 0.12s ease',
                    transform: dropOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
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
                  {/* Dropdown order (project_floom_nav_ia.md, 2026-04-25):
                      Profile · API keys · Secrets · Pricing · Docs · Sign out.
                      Studio + My runs live in the centre nav now (authed
                      users get the work-focused 2-item layout); Pricing +
                      Docs demote here so they stay 1 click away without
                      cluttering the top bar. */}
                  <Link
                    to="/me/settings"
                    onClick={() => setDropOpen(false)}
                    role="menuitem"
                    data-testid="topbar-user-profile"
                    style={menuItemStyle}
                  >
                    Profile
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
                    to="/me/secrets"
                    onClick={() => setDropOpen(false)}
                    role="menuitem"
                    data-testid="topbar-user-secrets"
                    style={menuItemStyle}
                  >
                    Secrets
                  </Link>
                  <div
                    style={{
                      height: 1,
                      background: 'rgba(14,14,12,0.08)',
                      margin: '4px 0',
                    }}
                    aria-hidden="true"
                  />
                  <Link
                    to="/pricing"
                    onClick={() => setDropOpen(false)}
                    role="menuitem"
                    data-testid="topbar-user-pricing"
                    aria-current={isPricing ? 'page' : undefined}
                    style={menuItemStyle}
                  >
                    Pricing
                  </Link>
                  <Link
                    to="/docs"
                    onClick={() => setDropOpen(false)}
                    role="menuitem"
                    data-testid="topbar-user-docs"
                    aria-current={isDocs ? 'page' : undefined}
                    style={menuItemStyle}
                  >
                    Docs
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

            {/* Mobile menu — branches on auth state, same split as desktop
                (project_floom_nav_ia.md). Anonymous: Apps · Docs · Pricing
                + Publish CTA. Authenticated: Studio · My runs · + New app
                · Pricing · Docs · API keys · Settings · Sign out. */}
            {showAuthedChrome ? (
              <>
                <Link
                  to="/studio"
                  className="topbar-mobile-link topbar-mobile-link-primary"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-studio"
                  aria-current={isStudio ? 'page' : undefined}
                >
                  <MobileAppsIcon />
                  <span>{studioNavLabel}</span>
                </Link>
                <Link
                  to="/me"
                  className="topbar-mobile-link"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-my-runs"
                  aria-current={isMe ? 'page' : undefined}
                >
                  My runs
                </Link>
                {!isLoginPage && (
                  <Link
                    to="/studio/build"
                    className="topbar-mobile-cta"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    data-testid="topbar-mobile-new-app"
                    aria-current={isPublishNav ? 'page' : undefined}
                    style={{
                      background: ACCENT,
                      borderColor: ACCENT,
                      color: '#fff',
                    }}
                  >
                    + New app
                  </Link>
                )}
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
                  to="/docs"
                  className="topbar-mobile-link"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-docs"
                  aria-current={isDocs ? 'page' : undefined}
                >
                  Docs
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
                  data-testid="topbar-mobile-settings"
                >
                  Settings
                </Link>
              </>
            ) : (
              <>
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
                  to="/docs"
                  className="topbar-mobile-link"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  data-testid="topbar-mobile-docs"
                  aria-current={isDocs ? 'page' : undefined}
                >
                  Docs
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

                {/* Publish CTA — anon-only primary action on mobile. */}
                {!isLoginPage && deployEnabled && (
                  <Link
                    to="/studio/build"
                    className="topbar-mobile-cta"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                    data-testid="topbar-mobile-publish"
                    aria-current={isPublishNav ? 'page' : undefined}
                    style={{
                      background: ACCENT,
                      borderColor: ACCENT,
                      color: '#fff',
                    }}
                  >
                    Publish
                  </Link>
                )}
                {!isLoginPage && waitlistMode && (
                  <button
                    type="button"
                    className="topbar-mobile-cta"
                    role="menuitem"
                    data-testid="topbar-mobile-publish-waitlist"
                    onClick={() => {
                      setMenuOpen(false);
                      goWaitlistPublish('topbar-publish-mobile');
                    }}
                    style={{
                      background: ACCENT,
                      borderColor: ACCENT,
                      color: '#fff',
                      cursor: 'pointer',
                      font: 'inherit',
                    }}
                  >
                    Publish
                  </button>
                )}
              </>
            )}

            {!isAuthenticated && !isLoginPage && deployEnabled && (
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

            {!isAuthenticated && deployEnabled && (
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

            {!isAuthenticated && waitlistMode && (
              <Link
                to={waitlistHref('topbar-mobile-waitlist')}
                className="topbar-mobile-cta"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                data-testid="topbar-mobile-waitlist"
                style={{
                  // Ink pill so the green Publish CTA stays the single
                  // primary action in the mobile menu — same hierarchy
                  // the desktop right-rail already establishes.
                  background: INK,
                  borderColor: INK,
                  color: '#fff',
                  boxShadow: 'none',
                }}
              >
                Join waitlist
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
