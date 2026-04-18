// StudioLayout — creator workspace shell used by every /studio/* page.
//
// Shape: minimal TopBar (reused from the store) + left sidebar (240px
// fixed desktop, hidden on mobile) + darker main surface. Auth-gates
// via PageShell (cloud-only). The sidebar delivers per-app drilldown
// and back-to-Store footer.
//
// NB: we reuse the same <TopBar /> the Store uses. The TopBar's
// context-awareness detects /studio/* via useLocation and collapses
// to breadcrumb-only inside Studio. See TopBar.tsx for that logic.

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TopBar } from '../TopBar';
import { FeedbackButton } from '../FeedbackButton';
import { RouteLoading } from '../RouteLoading';
import { useSession } from '../../hooks/useSession';
import { StudioSidebar } from './StudioSidebar';

interface Props {
  children: ReactNode;
  title?: string;
  activeAppSlug?: string;
  activeSubsection?: 'overview' | 'runs' | 'secrets' | 'access' | 'renderer' | 'analytics';
  contentStyle?: CSSProperties;
}

export function StudioLayout({
  children,
  title,
  activeAppSlug,
  activeSubsection,
  contentStyle,
}: Props) {
  const { data, loading, error } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const sessionPending = loading || (data === null && !error);
  const needsLogin =
    !!data && data.cloud_mode && data.user.is_local;

  useEffect(() => {
    if (loading) return;
    if (!data) return;
    if (data.cloud_mode && data.user.is_local) {
      navigate(
        '/login?next=' + encodeURIComponent(location.pathname + location.search),
        { replace: true },
      );
    }
  }, [data, loading, navigate, location.pathname, location.search]);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  // Close mobile drawer on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  if (sessionPending || needsLogin) {
    return (
      <div className="page-root studio-root">
        <TopBar />
        <RouteLoading variant="embed" />
      </div>
    );
  }

  return (
    <div className="page-root studio-root" style={{ background: '#F5F5F1' }}>
      <TopBar />

      {/* Mobile drawer toggle (sidebar is hidden <900px) */}
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Open Studio menu"
        data-testid="studio-mobile-toggle"
        className="studio-mobile-toggle"
        style={{
          position: 'fixed',
          bottom: 18,
          left: 18,
          width: 44,
          height: 44,
          borderRadius: 22,
          border: '1px solid var(--line)',
          background: 'var(--ink)',
          color: '#fff',
          fontSize: 16,
          fontFamily: 'inherit',
          cursor: 'pointer',
          zIndex: 30,
          display: 'none',
        }}
      >
        ☰
      </button>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          minHeight: 'calc(100vh - 56px)',
          background: '#F5F5F1',
        }}
      >
        <div className="studio-sidebar-wrap" style={{ display: 'contents' }}>
          <StudioSidebar
            activeAppSlug={activeAppSlug}
            activeSubsection={activeSubsection}
          />
        </div>

        {menuOpen && (
          <div
            role="presentation"
            onClick={() => setMenuOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
              background: 'rgba(14,14,12,0.4)',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ position: 'absolute', top: 0, left: 0, height: '100%' }}
            >
              <StudioSidebar
                activeAppSlug={activeAppSlug}
                activeSubsection={activeSubsection}
              />
            </div>
          </div>
        )}

        <main
          className="studio-main"
          style={{
            flex: 1,
            padding: '28px 40px 120px',
            maxWidth: 1100,
            margin: '0 auto',
            width: '100%',
            minWidth: 0,
            ...contentStyle,
          }}
        >
          {children}
        </main>
      </div>

      <FeedbackButton />
    </div>
  );
}
