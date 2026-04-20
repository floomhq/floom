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
import { useLocation } from 'react-router-dom';
import { BaseLayout } from '../BaseLayout';
import { StudioSidebar } from './StudioSidebar';
import { useSession } from '../../hooks/useSession';
import { colors } from '../../lib/design-tokens';

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
  const { data } = useSession();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const signedOutCloud = !!data && data.cloud_mode && data.user.is_local;
  const showSignedOutPreview = signedOutCloud && allowSignedOutShell;

  // Close mobile drawer on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

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
      {/* Mobile drawer (<768px). Backdrop catches tap-outside-to-close;
          inner sidebar stops propagation so taps on it don't dismiss.
          Opens via the TopBar's studio hamburger (onStudioMenuOpen).
          Closes on route change (useEffect above) or backdrop tap. */}
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
          </div>
        </div>
      )}

      {children}
    </BaseLayout>
  );
}
