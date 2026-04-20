// StudioLayout — creator workspace shell used by every /studio/* page.
//
// This is now a thin wrapper over <BaseLayout> (2026-04-20 nav
// unification). BaseLayout owns the TopBar + auth gating + route
// loading, so those behaviors stay identical between Store and Studio.
// StudioLayout's job is just to pass in the sidebar, the darker
// background, and the studio-specific <main> padding/max-width.
//
// Mobile (<768px): the sidebar is hidden. The TopBar renders a studio
// hamburger (left of the pill) that opens the sidebar as a slide-in
// drawer from the left. Drawer closes on route change or backdrop tap.
// Before the 2026-04-20 nav-polish pass this was a floating ☰ button
// anchored bottom-left of the viewport, which nobody noticed.
//
// Shape: TopBar + left sidebar (240px fixed desktop, drawer on mobile)
// + darker main surface on `colors.sidebarBg`. Auth-gates cloud-only.

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BaseLayout } from '../BaseLayout';
import { StudioSidebar } from './StudioSidebar';
import { useSession, clearSession } from '../../hooks/useSession';
import { colors } from '../../lib/design-tokens';
import * as api from '../../api/client';

interface Props {
  children: ReactNode;
  title?: string;
  activeAppSlug?: string;
  activeSubsection?: 'overview' | 'runs' | 'secrets' | 'access' | 'renderer' | 'analytics' | 'triggers';
  contentStyle?: CSSProperties;
  allowSignedOutShell?: boolean;
}

export function StudioLayout({
  children,
  title,
  activeAppSlug,
  activeSubsection,
  contentStyle,
  allowSignedOutShell = false,
}: Props) {
  const { data, isAuthenticated, refresh } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const signedOutCloud = !!data && data.cloud_mode && data.user.is_local;
  const showSignedOutPreview = signedOutCloud && allowSignedOutShell;

  // Close mobile drawer on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  async function handleMobileLogout() {
    try {
      await api.signOut();
    } catch {
      // ignore network errors, still clear client state
    }
    clearSession();
    await refresh();
    setMenuOpen(false);
    navigate('/');
  }

  return (
    <BaseLayout
      title={title}
      requireAuth="cloud"
      allowSignedOutShell={allowSignedOutShell}
      rootBackground={colors.sidebarBg}
      onStudioMenuOpen={() => setMenuOpen(true)}
      sidebar={
        <div className="studio-sidebar-wrap" style={{ display: 'contents' }}>
          <StudioSidebar
            activeAppSlug={activeAppSlug}
            activeSubsection={activeSubsection}
            signedOutPreview={showSignedOutPreview}
          />
        </div>
      }
      mainStyle={{
        flex: 1,
        padding: '28px 40px 120px',
        maxWidth: 1100,
        margin: '0 auto',
        width: '100%',
        minWidth: 0,
        ...contentStyle,
      }}
    >
      {/* Unified mobile drawer (<768px). Backdrop catches tap-outside-to-close;
          inner panel stops propagation so taps on it don't dismiss.
          Opens via the TopBar's studio hamburger (onStudioMenuOpen).
          Closes on route change (useEffect above) or backdrop tap.

          Mobile /studio/* has ONE menu entry point (the left studio
          toggle). This drawer therefore needs to carry both the studio
          nav (sidebar) AND the global items a mobile user otherwise
          lost when we hid the TopBar's right hamburger on studio
          routes: Docs, Me, Sign in / Sign out. */}
      {menuOpen && (
        <div
          className="studio-mobile-drawer-backdrop"
          role="presentation"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="studio-mobile-drawer-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <StudioSidebar
              activeAppSlug={activeAppSlug}
              activeSubsection={activeSubsection}
              signedOutPreview={showSignedOutPreview}
            />
            <nav
              aria-label="Global navigation"
              data-testid="studio-mobile-global-nav"
              className="studio-mobile-global-nav"
            >
              <Link
                to="/protocol"
                className="studio-mobile-global-link"
                onClick={() => setMenuOpen(false)}
              >
                Docs
              </Link>
              {isAuthenticated && (
                <Link
                  to="/me"
                  className="studio-mobile-global-link"
                  onClick={() => setMenuOpen(false)}
                >
                  Me
                </Link>
              )}
              {!isAuthenticated && (
                <Link
                  to="/login"
                  className="studio-mobile-global-link"
                  onClick={() => setMenuOpen(false)}
                >
                  Sign in
                </Link>
              )}
              {isAuthenticated && (
                <button
                  type="button"
                  className="studio-mobile-global-link studio-mobile-global-signout"
                  onClick={() => {
                    void handleMobileLogout();
                  }}
                >
                  Sign out
                </button>
              )}
            </nav>
          </div>
        </div>
      )}

      {children}
    </BaseLayout>
  );
}
