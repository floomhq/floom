// BaseLayout — the shared page shell every Floom surface uses.
//
// One header, one auth-gate, one route-loading block. Both `PageShell`
// (store side) and `StudioLayout` (studio side) are now thin wrappers
// over this component; they just decide whether to pass a sidebar and
// whether to render the footer.
//
// Created 2026-04-20 as part of the nav unification pass. Before this,
// PageShell and StudioLayout each ran their own copy of the auth-gate
// + route-loading + TopBar setup, which drifted over time and was one
// of the reasons /studio/build ended up with two competing back
// affordances.

import { useEffect, type ReactNode, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TopBar } from './TopBar';
import { FeedbackButton } from './FeedbackButton';
import { RouteLoading } from './RouteLoading';
import { useSession } from '../hooks/useSession';

interface Props {
  children: ReactNode;
  /** Optional sidebar rendered to the left of the main area. Studio
   *  passes <StudioSidebar />; store pages pass nothing. */
  sidebar?: ReactNode;
  /** Optional footer rendered after the main area. Store pages pass
   *  <Footer />; studio pages pass nothing. */
  footer?: ReactNode;
  /** Auth gate. 'cloud' = redirect unauthenticated cloud users to /login.
   *  null = no gate. */
  requireAuth?: 'cloud' | 'any' | null;
  /** Document title. Also mirrored into og:title / twitter:title. */
  title?: string;
  /** Meta description (~140–160 chars). Mirrored into og:description /
   *  twitter:description. When undefined, whatever index.html shipped is
   *  left in place. Added 2026-04-24 for SEO pass (issue #172, #316,
   *  #317, #324). */
  description?: string;
  /** Extra styles merged onto <main>. */
  mainStyle?: CSSProperties;
  /** When true, cloud-mode signed-out users see a preview of the shell
   *  (no redirect). Used for onboarding flows. */
  allowSignedOutShell?: boolean;
  /** Background color for the outer wrapper. Studio uses the darker
   *  sidebar tone so the sidebar + main don't have a visible seam. */
  rootBackground?: string;
  /** When true, skip the default <main> wrapper and render children
   *  inline. Used by pages that need the full chrome but own their
   *  own main layout (e.g. AppPermalinkPage). */
  bareMain?: boolean;
  /** Studio-only: callback fired when the user taps the Studio
   *  hamburger in the TopBar (<768px). When undefined, the button
   *  doesn't render. StudioLayout passes this to open its sidebar
   *  drawer. */
  onStudioMenuOpen?: () => void;
  /** Emit `<meta name="robots" content="noindex,nofollow">` while this
   *  layout is mounted. Used for auth-gated surfaces (Studio, /me/*,
   *  password reset) that shouldn't appear in search results even if a
   *  crawler ignores robots.txt. Tag is removed on unmount so navigating
   *  from a noindex route back to a public page doesn't bleed the
   *  directive across. Added 2026-04-22 for launch SEO pass. */
  noIndex?: boolean;
}

export function BaseLayout({
  children,
  sidebar,
  footer,
  requireAuth = null,
  title,
  description,
  mainStyle,
  allowSignedOutShell = false,
  rootBackground,
  bareMain = false,
  onStudioMenuOpen,
  noIndex = false,
}: Props) {
  const { data, loading, error } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const sessionPendingForCloud =
    requireAuth === 'cloud' && (loading || (data === null && !error));
  const signedOutCloud =
    !!data && data.cloud_mode && data.user.is_local;
  const cloudNeedsLoginRedirect =
    requireAuth === 'cloud' && signedOutCloud && !allowSignedOutShell;
  const showCloudAuthLoading = sessionPendingForCloud || cloudNeedsLoginRedirect;

  useEffect(() => {
    if (!requireAuth) return;
    if (loading) return;
    if (!data) return;
    if (requireAuth === 'cloud' && data.cloud_mode && data.user.is_local && !allowSignedOutShell) {
      navigate('/login?next=' + encodeURIComponent(location.pathname + location.search), {
        replace: true,
      });
    }
  }, [allowSignedOutShell, requireAuth, data, loading, navigate, location.pathname, location.search]);

  // Per-route head tags. An SPA inherits whatever index.html shipped,
  // which means the landing page's title + canonical URL bleed onto
  // every deep route. Here we patch the tags that actually matter for
  // SEO + social preview on every navigation:
  //   <title>, description, canonical, og:*, twitter:*.
  // og:image stays on whatever global default index.html defined
  // (pages can override by stamping their own <meta> tag separately).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (title) document.title = title;

    const site = 'https://floom.dev';
    // Strip trailing slash (except root) so /about/ and /about collapse
    // onto the same canonical — mirrors Google's own canonicalisation.
    const rawPath = location.pathname || '/';
    const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    const url = `${site}${path}`;

    const setAttr = (sel: string, attr: 'content' | 'href', value: string) => {
      const el = document.head.querySelector(sel) as HTMLElement | null;
      if (el) el.setAttribute(attr, value);
    };

    setAttr('link[rel="canonical"]', 'href', url);
    setAttr('meta[property="og:url"]', 'content', url);

    if (title) {
      setAttr('meta[property="og:title"]', 'content', title);
      setAttr('meta[name="twitter:title"]', 'content', title);
    }
    if (description) {
      setAttr('meta[name="description"]', 'content', description);
      setAttr('meta[property="og:description"]', 'content', description);
      setAttr('meta[name="twitter:description"]', 'content', description);
    }
  }, [title, description, location.pathname]);

  // noindex meta for auth-gated pages (Studio, /me/*, password reset).
  // Belt-and-suspenders with robots.txt — crawlers that skip robots.txt
  // still honor the meta tag. Uses a data-* marker so we only remove the
  // tag we added (won't disturb NotFoundPage's own noindex marker).
  useEffect(() => {
    if (!noIndex) return;
    if (typeof document === 'undefined') return;
    const MARKER = 'data-floom-base-noindex';
    let tag = document.head.querySelector(
      `meta[${MARKER}]`,
    ) as HTMLMetaElement | null;
    if (!tag) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'robots');
      tag.setAttribute('content', 'noindex,nofollow');
      tag.setAttribute(MARKER, '1');
      document.head.appendChild(tag);
    }
    return () => {
      const existing = document.head.querySelector(`meta[${MARKER}]`);
      if (existing) existing.remove();
    };
  }, [noIndex]);

  const rootStyle: CSSProperties | undefined = rootBackground
    ? { background: rootBackground }
    : undefined;

  // When sidebar is present we render a flex row under the TopBar so the
  // sidebar is flush-left and <main> fills the rest of the row.
  if (sidebar) {
    return (
      <div className="page-root studio-root" style={rootStyle}>
        <TopBar onStudioMenuOpen={onStudioMenuOpen} />
        {showCloudAuthLoading ? (
          <RouteLoading variant="embed" />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              minHeight: 'calc(100vh - 56px)',
              background: rootBackground,
            }}
          >
            {sidebar}
            {bareMain ? (
              children
            ) : (
              <main id="main" className="studio-main" style={mainStyle}>
                {children}
              </main>
            )}
          </div>
        )}
        {footer}
        <FeedbackButton />
      </div>
    );
  }

  // No sidebar: simpler top-to-bottom layout. This is the store shell.
  return (
    <div className="page-root" style={rootStyle}>
      <TopBar />
      {bareMain ? (
        showCloudAuthLoading ? <RouteLoading variant="embed" /> : children
      ) : (
        <main id="main" className="main" style={mainStyle}>
          {showCloudAuthLoading ? <RouteLoading variant="embed" /> : children}
        </main>
      )}
      {footer}
      <FeedbackButton />
    </div>
  );
}
