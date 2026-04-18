// W4-minimal: shared page shell used by every new page.
//
// Responsibilities:
//   - Renders the TopBar (with auth state) and the floating FeedbackButton.
//   - Sets a consistent main max-width + padding.
//   - Accepts an optional `requireAuth` flag: when true + not yet logged in
//     (cloud mode with is_local=true OR loading), redirects to /login.
//
// OSS mode (is_local=true) is treated as "logged in as local" for pages
// that don't strictly require cloud — the synthetic user can still browse
// /me, /build, /creator and see their device-scoped runs.

import { useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TopBar } from './TopBar';
import { Footer } from './Footer';
import { FeedbackButton } from './FeedbackButton';
import { RouteLoading } from './RouteLoading';
import { useSession } from '../hooks/useSession';

interface Props {
  children: ReactNode;
  requireAuth?: 'cloud' | 'any' | null;
  title?: string;
  contentStyle?: React.CSSProperties;
}

export function PageShell({
  children,
  requireAuth = null,
  title,
  contentStyle,
}: Props) {
  const { data, loading, error } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const sessionPendingForCloud =
    requireAuth === 'cloud' && (loading || (data === null && !error));
  const cloudNeedsLoginRedirect =
    requireAuth === 'cloud' &&
    !!data &&
    data.cloud_mode &&
    data.user.is_local;
  const showCloudAuthLoading = sessionPendingForCloud || cloudNeedsLoginRedirect;

  // Only cloud mode forces a real login; in OSS mode the synthetic local
  // user can access every page so self-hosters can demo without any auth.
  useEffect(() => {
    if (!requireAuth) return;
    if (loading) return;
    if (!data) return;
    if (requireAuth === 'cloud' && data.cloud_mode && data.user.is_local) {
      navigate('/login?next=' + encodeURIComponent(location.pathname + location.search), {
        replace: true,
      });
    }
  }, [requireAuth, data, loading, navigate, location.pathname, location.search]);

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  return (
    <div className="page-root">
      <TopBar />
      <main
        className="main"
        style={{
          padding: '32px 24px 120px',
          maxWidth: 1080,
          margin: '0 auto',
          minHeight: 'calc(100vh - 56px - 80px)',
          ...contentStyle,
        }}
      >
        {showCloudAuthLoading ? <RouteLoading variant="embed" /> : children}
      </main>
      <Footer />
      <FeedbackButton />
    </div>
  );
}
