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
import { CopyForClaudeButton } from './CopyForClaudeButton';
import { MobileDrawer } from './MobileDrawer';

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

// v26 TopBar — auth-branched chrome (V26-IA-SPEC §10 + §12.5, locked 2026-04-27).
//   Anonymous (waitlist visitor / signed-out):
//     Centre: Apps · Docs · Pricing                                  (3 items)
//     Right (preview):  GH stars · Publish (CTA) · Sign in · Sign up
//     Right (waitlist): GH stars · Publish (CTA) · Join waitlist
//
//   Authenticated (deploy mode):
//     Centre: Studio · My runs
//     Right:  GH stars · Copy for Claude · + New app · avatar dropdown
//     Avatar dropdown: Account settings · Docs · Help · Sign out
//     Logo: route-aware → /run/apps when authenticated
//
// V26-IA-SPEC consumer-mode label: /run and /me surfaces render as "My runs".
// Docs moved to avatar dropdown (§12.5).
//
// Two clean states only — never a 3rd. Preview vs prod differ in the
// CTA wording (Publish vs Join waitlist), not the nav structure.
//
// Changelog stays in the footer (#572 nav declutter, original 04-23 pass).
// Mobile: hamburger → MobileDrawer (v26 workspace identity + mode toggle + items).
export function TopBar({ compact = false, onStudioMenuOpen }: Props = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropOpen, setDropOpen] = useState(false);
  const { data, isAuthenticated, refresh } = useSession();
  useMyApps(); // prefetch apps cache for downstream components (mobile drawer)
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
            14px. Gap 8px keeps mark and wordmark optically balanced.
            v26 spec: route-aware — landing if logged-out, /run/apps if logged-in. */}
        <Link
          to={showAuthedChrome ? '/run/apps' : '/'}
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

        {/* Centre nav — v26-IA-SPEC §10 + §12.5:
            Anonymous: Apps · Docs · Pricing (discovery surfaces).
            Authenticated: no centre nav — Studio/My runs live in the rail,
            not the TopBar. Slim authenticated TopBar = logo + Copy for
            Claude + + New app + avatar only (§12.5). V11 fix 2026-04-27. */}
        {showAuthedChrome ? null : (
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
          {/* GitHub stars badge — social proof for anonymous visitors only.
              Hidden for authenticated users per §12.5: slim authenticated
              TopBar = floom + Copy for Claude + + New app + avatar.
              No badge clutter for signed-in users who know the product.
              V11 fix 2026-04-27. */}
          {!isLoginPage && !showAuthedChrome && <GitHubStarsBadge compact dataTestId="topbar-gh-stars" />}

          {/* Copy-for-Claude — globally present (anon + authed). Sits
              between centre nav and CTA/avatar cluster (Federico-locked
              2026-04-26). Hidden only on auth pages so they stay focused.
              The popover handles its own state, click-outside, and Esc.
              Anon centre nav: Apps · Docs · Pricing → Copy-for-Claude →
              Sign in / Sign up. Authed: Studio · My runs →
              Copy-for-Claude → + New app → avatar. */}
          {!isLoginPage && <CopyForClaudeButton />}

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
                    minWidth: 240,
                    boxShadow: '0 4px 16px rgba(14,14,12,0.08)',
                    padding: 4,
                    zIndex: 50,
                  }}
                >
                  {/* v26 avatar dropdown (ADR-29): Account settings · Docs · Help · Sign out. */}
                  <DropdownItem
                    to="/settings/general"
                    label="Account settings"
                    testId="topbar-user-settings"
                    onSelect={() => setDropOpen(false)}
                    active={location.pathname.startsWith('/settings')}
                  />
                  <DropdownItem
                    to="/docs"
                    label="Docs"
                    testId="topbar-user-docs"
                    onSelect={() => setDropOpen(false)}
                    active={isDocs}
                  />
                  <DropdownItem
                    to="/docs/help"
                    label="Help"
                    testId="topbar-user-help"
                    onSelect={() => setDropOpen(false)}
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

      {/* Mobile fixed-bottom-right Copy-for-Claude pill (Federico-locked
          2026-04-26, v23 wireframe line 484-487). Visible only at the
          mobile breakpoint via CSS (`.topbar-mcp-mobile`). Hidden on
          /login + /signup so auth surfaces stay focused. Reuses the
          shared CopyForClaudeButton in mobile variant — same popover,
          same context-aware row 3 logic. */}
      {!isLoginPage && (
        <div className="topbar-mcp-mobile" data-testid="topbar-mcp-mobile">
          <CopyForClaudeButton variant="mobile" />
        </div>
      )}

      <MobileDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSignOut={() => {
          void handleLogout();
        }}
      />
    </header>
  );
}


// Avatar dropdown row with optional `count` tag rendered as a monospace
// suffix per v23 spec ("Apps · 5", "BYOK keys · 3"). Counts are sourced
// from session-scoped caches (useMyApps, useSecrets) — undefined/null/0
// hide the tag gracefully so empty states don't render "Apps · 0".
function DropdownItem({
  to,
  label,
  count,
  testId,
  onSelect,
  active,
}: {
  to: string;
  label: string;
  count?: number;
  testId: string;
  onSelect: () => void;
  active?: boolean;
}) {
  return (
    <Link
      to={to}
      onClick={onSelect}
      role="menuitem"
      data-testid={testId}
      aria-current={active ? 'page' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        fontSize: 13,
        color: INK,
        textDecoration: 'none',
        borderRadius: 6,
        gap: 12,
      }}
    >
      <span>{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span
          style={{
            fontFamily:
              '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
            color: MUTED,
          }}
          aria-label={`${count} items`}
        >
          {count}
        </span>
      )}
    </Link>
  );
}
