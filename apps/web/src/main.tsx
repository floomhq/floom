import React, { Suspense, lazy, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
// Landing is eager (LCP path). Everything else is lazy so the initial
// bundle only carries the homepage React tree. Trimmed initial JS from
// 427 KB (118 KB gzip) to the landing slice; other pages stream in on
// route change. Mobile Lighthouse Perf: 71 -> 90+.
// v17 landing rebuild (2026-04-22): `/` now renders LandingV17Page per the
// wireframes at /var/www/wireframes-floom/v17/landing.html. The legacy
// CreatorHeroPage.tsx stays on disk as reference (and is still the source
// of the hero detect + publish flow, which will be ported into the v17
// tree in a follow-up). Both are eager so the LCP path doesn't wait on
// a dynamic import round-trip.
import { LandingV17Page } from './pages/LandingV17Page';
import { NotFoundPage } from './pages/NotFoundPage';
const AppsDirectoryPage = lazy(() => import('./pages/AppsDirectoryPage').then(m => ({ default: m.AppsDirectoryPage })));
const AppPermalinkPage = lazy(() => import('./pages/AppPermalinkPage').then(m => ({ default: m.AppPermalinkPage })));
const PublicRunPermalinkPage = lazy(() => import('./pages/PublicRunPermalinkPage').then(m => ({ default: m.PublicRunPermalinkPage })));
const ProtocolPage = lazy(() => import('./pages/ProtocolPage').then(m => ({ default: m.ProtocolPage })));
const DocsPage = lazy(() => import('./pages/DocsPage').then(m => ({ default: m.DocsPage })));
// v17 Docs hub rebuild (2026-04-22). Replaces the /docs → /protocol
// redirect with a dedicated landing page that shares a sidebar with every
// /docs/:slug detail page. MCP install, self-host, and runtime-specs
// content moved from wireframe to live markdown.
const DocsLandingPage = lazy(() => import('./pages/DocsLandingPage').then(m => ({ default: m.DocsLandingPage })));
const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import('./pages/SignupPage').then(m => ({ default: m.SignupPage })));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })));
const MePage = lazy(() => import('./pages/MePage').then(m => ({ default: m.MePage })));
// /me/apps + /me/runs + /me/secrets are new tab sub-pages for the
// Studio-tabbed /me dashboard (issue #547). Prior /me/apps and /me/runs
// were just redirects back to /me; they now render dedicated pages.
const MeAppsPage = lazy(() => import('./pages/MeAppsPage').then(m => ({ default: m.MeAppsPage })));
const MeRunsPage = lazy(() => import('./pages/MeRunsPage').then(m => ({ default: m.MeRunsPage })));
const MeSecretsPage = lazy(() => import('./pages/MeSecretsPage').then(m => ({ default: m.MeSecretsPage })));
const MeRunDetailPage = lazy(() => import('./pages/MeRunDetailPage').then(m => ({ default: m.MeRunDetailPage })));
const MeSettingsPage = lazy(() => import('./pages/MeSettingsPage').then(m => ({ default: m.MeSettingsPage })));
const MeSettingsTokensPage = lazy(() => import('./pages/MeSettingsTokensPage').then(m => ({ default: m.MeSettingsTokensPage })));
// MeAppPage + MeAppSecretsPage still live on disk for shared component
// exports (AppHeader, TabBar) used by the Studio pages; the routes that
// mounted them directly now redirect into /studio/*.
const MeAppRunPage = lazy(() => import('./pages/MeAppRunPage').then(m => ({ default: m.MeAppRunPage })));
const MeAppTriggersPage = lazy(() => import('./pages/MeAppTriggersPage').then(m => ({ default: m.MeAppTriggersPage })));
const MeAppTriggerSchedulePage = lazy(() => import('./pages/MeAppTriggerSchedulePage').then(m => ({ default: m.MeAppTriggerSchedulePage })));
const MeAppTriggerWebhookPage = lazy(() => import('./pages/MeAppTriggerWebhookPage').then(m => ({ default: m.MeAppTriggerWebhookPage })));
const MeInstallPage = lazy(() => import('./pages/MeInstallPage').then(m => ({ default: m.MeInstallPage })));
// 2026-04-20 (PRR tail cleanup): public /install stub — separate from
// /me/install which is the authenticated "Install to Claude" flow.
const InstallPage = lazy(() => import('./pages/InstallPage').then(m => ({ default: m.InstallPage })));
// v17 install surface: /install-in-claude (generic 4-tab landing) and
// /install/:slug (per-app wrapper that pre-fills snippets with the slug).
const InstallInClaudePage = lazy(() => import('./pages/InstallInClaudePage').then(m => ({ default: m.InstallInClaudePage })));
const InstallAppPage = lazy(() => import('./pages/InstallAppPage').then(m => ({ default: m.InstallAppPage })));
// 2026-04-20: /about graduated from redirect to a real story page. Tells
// who Floom is for, why headless, what it isn't, who's behind it. H1
// "Get that thing off localhost fast." lives alongside the landing H1.
const AboutPage = lazy(() => import('./pages/AboutPage').then(m => ({ default: m.AboutPage })));
// 2026-04-20: /pricing graduated from redirect to an honest placeholder.
// Free during beta, self-host free forever, paid plans TBD. Fixes the
// commercial-visitor dead-end called out in the product audit (pd-12).
const PricingPage = lazy(() => import('./pages/PricingPage').then(m => ({ default: m.PricingPage })));
const IaPage = lazy(() => import('./pages/IaPage').then(m => ({ default: m.IaPage })));
const ArchitecturePage = lazy(() => import('./pages/ArchitecturePage').then(m => ({ default: m.ArchitecturePage })));
const BuildPage = lazy(() => import('./pages/BuildPage').then(m => ({ default: m.BuildPage })));
const CreatorPage = lazy(() => import('./pages/CreatorPage').then(m => ({ default: m.CreatorPage })));
const CreatorAppPage = lazy(() => import('./pages/CreatorAppPage').then(m => ({ default: m.CreatorAppPage })));
// Studio context — creator workspace (v16 restructure 2026-04-18). Two
// contexts share the same user: Store (light surface, consumer) and
// Studio (darker surface, sidebar, tool chrome). All /studio/* routes
// auth-gate through StudioLayout (cloud-only).
const StudioHomePage = lazy(() => import('./pages/StudioHomePage').then(m => ({ default: m.StudioHomePage })));
const StudioAppsPage = lazy(() => import('./pages/StudioHomePage').then(m => ({ default: m.StudioAppsPage })));
const StudioBuildPage = lazy(() => import('./pages/StudioBuildPage').then(m => ({ default: m.StudioBuildPage })));
const StudioAppPage = lazy(() => import('./pages/StudioAppPage').then(m => ({ default: m.StudioAppPage })));
const StudioRunsPage = lazy(() => import('./pages/StudioRunsPage').then(m => ({ default: m.StudioRunsPage })));
const StudioAppRunsPage = lazy(() => import('./pages/StudioAppRunsPage').then(m => ({ default: m.StudioAppRunsPage })));
const StudioAppSecretsPage = lazy(() => import('./pages/StudioAppSecretsPage').then(m => ({ default: m.StudioAppSecretsPage })));
const StudioAppAccessPage = lazy(() => import('./pages/StudioAppAccessPage').then(m => ({ default: m.StudioAppAccessPage })));
const StudioAppRendererPage = lazy(() => import('./pages/StudioAppRendererPage').then(m => ({ default: m.StudioAppRendererPage })));
const StudioAppAnalyticsPage = lazy(() => import('./pages/StudioAppAnalyticsPage').then(m => ({ default: m.StudioAppAnalyticsPage })));
const StudioAppFeedbackPage = lazy(() => import('./pages/StudioAppFeedbackPage').then(m => ({ default: m.StudioAppFeedbackPage })));
const StudioTriggersTab = lazy(() => import('./pages/StudioTriggersTab').then(m => ({ default: m.StudioTriggersTab })));
const StudioSettingsPage = lazy(() => import('./pages/StudioSettingsPage').then(m => ({ default: m.StudioSettingsPage })));
const ImprintPage = lazy(() => import('./pages/ImprintPage').then(m => ({ default: m.ImprintPage })));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage').then(m => ({ default: m.PrivacyPage })));
const TermsPage = lazy(() => import('./pages/TermsPage').then(m => ({ default: m.TermsPage })));
const CookiesPage = lazy(() => import('./pages/CookiesPage').then(m => ({ default: m.CookiesPage })));
const StatusPage = lazy(() => import('./pages/StatusPage').then(m => ({ default: m.StatusPage })));
// /changelog (PR #405 ripple, 2026-04-22): TopBar advertises a Changelog
// link in the centre nav; previously it was a dead `#` anchor. This
// page is a minimal landing that points at GitHub Releases + Discord.
const ChangelogPage = lazy(() => import('./pages/ChangelogPage').then(m => ({ default: m.ChangelogPage })));
// Deploy waitlist fallback page (launch 2026-04-27). The primary
// surface is WaitlistModal, popped from every gated Deploy CTA when
// DEPLOY_ENABLED=false. /waitlist is the URL we link to from the
// confirmation email for users who lost the modal, and the destination
// for the /deploy shortcut when the flow is gated.
const WaitlistPage = lazy(() => import('./pages/WaitlistPage').then(m => ({ default: m.WaitlistPage })));
import { IconSprite } from './components/IconSprite';
import { CookieBanner } from './components/CookieBanner';
import { RouteLoading } from './components/RouteLoading';
import { WaitlistGuard } from './components/WaitlistGuard';
import { primeSession, refreshSession } from './hooks/useSession';
import { initPostHog, identifyFromSession, track } from './lib/posthog';
import { BrowserSentryErrorBoundary, initBrowserSentry } from './lib/sentry';
import type { SessionMePayload } from './lib/types';
import './styles/globals.css';
import './styles/csp-inline-style-migrations.css';

// Browser Sentry. No-op when VITE_SENTRY_WEB_DSN is unset.
initBrowserSentry();

// Kick off the /api/session/me fetch as soon as the bundle loads so every
// page's first render already has a value.
primeSession();

// PostHog analytics (launch #311). Also strict-opt-in — see
// apps/web/src/lib/posthog.ts. When consent is "essential" OR the key is
// unset, init() is a hard no-op: track() and identifyFromSession()
// short-circuit, so calling them unconditionally below is safe.
initPostHog();

// Rebind PostHog identity whenever the session hook resolves. Covers
// first-load + every login/logout transition. refreshSession returns the
// same payload that useSession caches.
void refreshSession().then((session: SessionMePayload | null) => {
  identifyFromSession(session);
});

// Fire landing_viewed exactly once, on the first page that mounts. We
// bind it to pathname===/ because that's the creator-hero route; other
// deep-links (e.g. /apps, /p/:slug) are NOT landing views.
if (typeof window !== 'undefined' && window.location.pathname === '/') {
  track('landing_viewed');
}

// Wireframe v11 puts each app's creator view at /p/:slug/dashboard. Preview
// wired it to /creator/:slug. Redirect the wireframe URL to the live one so
// external links don't 404.
function PSlugDashboardRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/creator/${slug ?? ''}`} replace />;
}

// Legacy /me/a/:slug → /me/apps/:slug (lock-in 2026-04-18). The shorter form
// was v15.2 preview-only; wireframes and docs use /me/apps/:slug. These
// redirects keep old bookmarks + shared links alive.
function MeAppRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/run/apps/${slug ?? ''}`} replace />;
}
function MeAppSecretsRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/run/apps/${slug ?? ''}/secrets`} replace />;
}
function MeAppRunRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/run/apps/${slug ?? ''}/run`} replace />;
}

// V12: /run/apps/:slug (workspace view) → /run/apps/:slug/run
function SlugToRunRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/run/apps/${slug ?? ''}/run`} replace />;
}

// Studio restructure 2026-04-18: Store/Studio split. These redirects
// funnel every legacy creator-context URL into the new /studio/* tree.
// Each uses <Navigate replace> so query strings and bookmarks stay alive.
function StudioSlugRedirect({ subpath }: { subpath?: string }) {
  const { slug } = useParams<{ slug: string }>();
  const tail = subpath ? `/${subpath}` : '';
  return <Navigate to={`/studio/${slug ?? ''}${tail}`} replace />;
}

function LegacyWorkspaceUiRedirect() {
  const location = useLocation();
  const pathname = location.pathname.replace(/\/$/, '') || '/';
  // v26: /run now redirects to /run/apps, so legacy /me → /run/apps directly.
  let target = '/run/apps';
  if (pathname === '/me/install') target = '/run/install';
  else if (pathname === '/me/secrets') target = '/settings/byok-keys';
  else if (pathname === '/me/agent-keys' || pathname === '/me/api-keys') {
    target = '/settings/agent-tokens';
  } else if (pathname === '/me/settings' || pathname === '/me/settings/tokens') {
    target = '/settings/general';
  } else if (pathname === '/studio/settings') {
    target = '/settings/studio';
  } else if (pathname === '/me/apps') {
    target = '/run/apps';
  } else if (pathname.startsWith('/me/apps/')) {
    target = pathname.replace(/^\/me\/apps/, '/run/apps');
  } else if (pathname === '/me/runs') {
    target = '/run/runs';
  } else if (pathname.startsWith('/me/runs/')) {
    target = pathname.replace(/^\/me\/runs/, '/run/runs');
  }
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
}

// Design-audit fix 2026-04-22: /apps/:slug and /store/:slug funnel into the
// canonical app permalink at /p/:slug. The top-nav "Store" label and the
// "Try on Floom" CTAs on app cards point at these URLs, so the redirect
// keeps deep links from external pages (wireframes, shared links) alive.
function AppSlugToPermalinkRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/p/${slug ?? ''}`} replace />;
}

function EmbedSlugToPermalinkRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/p/${slug ?? ''}`} replace />;
}

// Hard redirect to an external URL (e.g. /docs/changelog → GitHub Releases).
// React Router's <Navigate> only handles in-app routes; for off-site targets
// we swap the browser location directly so the URL bar and back button work.
function ExternalRedirect({ to }: { to: string }) {
  if (typeof window !== 'undefined') {
    window.location.replace(to);
  }
  return null;
}

/**
 * PostHog page_view tracker (issue #599). Fires `page_view` on every route
 * change with `{ path }`. PostHog's own `capture_pageview` is disabled in
 * `lib/posthog.ts` so we own the routing semantics — a client-side nav in
 * the SPA is one `page_view`, not zero and not two. When PostHog is not
 * initialized (consent=essential or VITE_POSTHOG_KEY unset) track() is a
 * no-op so this is safe unconditionally. Must be mounted INSIDE BrowserRouter
 * so useLocation resolves.
 */
function RouteChangeTracker() {
  const location = useLocation();
  useEffect(() => {
    track('page_view', { path: location.pathname });
  }, [location.pathname]);
  return null;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserSentryErrorBoundary fallback={<RouteLoading variant="full" />}>
      <IconSprite />
      <BrowserRouter>
        <RouteChangeTracker />
        {/* a11y 2026-04-20: WCAG 2.4.1 skip link. Hidden until keyboard
          focus lands on it (first Tab press from the URL bar). Target
          is the #main landmark set on PageShell's <main>. Styling
          lives in .skip-to-content in globals.css so we can toggle
          the visual offset on :focus without inline pseudo-classes. */}
        <a href="#main" className="skip-to-content">
          Skip to main content
        </a>
        <Suspense fallback={<RouteLoading variant="full" />}>
        <Routes>
        {/* Landing v17 (2026-04-22): rebuild to wireframe parity. */}
        <Route path="/" element={<LandingV17Page />} />
        {/* Apps directory. Mounted at both /apps (legacy canonical) and
            /store (matches the "Store" pill label Federico sees on screen).
            Nav-polish 2026-04-20: URL no longer drifts from the label. */}
        <Route path="/apps" element={<AppsDirectoryPage />} />
        <Route path="/store" element={<AppsDirectoryPage />} />
        {/* Design-audit fix 2026-04-22: /apps/:slug and /store/:slug are
            the "Try on Floom" destinations shown on app cards and in the
            top nav. Both funnel into the canonical /p/:slug permalink
            so there's one real app-detail surface. */}
        <Route path="/apps/:slug" element={<AppSlugToPermalinkRedirect />} />
        <Route path="/store/:slug" element={<AppSlugToPermalinkRedirect />} />
        {/* Standalone app permalink */}
        <Route path="/p/:slug" element={<AppPermalinkPage />} />
        <Route path="/embed/:slug" element={<EmbedSlugToPermalinkRedirect />} />
        <Route path="/r/:runId" element={<PublicRunPermalinkPage />} />
        {/* Protocol spec page */}
        <Route path="/protocol" element={<ProtocolPage />} />
        {/* 2026-04-20 (PRR tail cleanup): /install public stub */}
        <Route path="/install" element={<InstallPage />} />
        {/* v17: 4-tab install surface. /install-in-claude is the generic
            landing (no app pre-selected). /install/:slug is the per-app
            wrapper — fetches app metadata and pre-fills MCP snippets.
            Must be listed BEFORE /install so the slug catch doesn't
            swallow "in-claude" as a slug value. */}
        <Route path="/install-in-claude" element={<InstallInClaudePage />} />
        <Route path="/install/:slug" element={<InstallAppPage />} />
        {/* /spec and /spec/* are server-side 308 redirects to /protocol
            (wired in apps/server/src/index.ts). No client route needed
            because crawlers/users never reach the SPA for those paths. */}
        {/* W4-minimal: auth pages. 2026-04-24: gated by WaitlistGuard
            on floom.dev (DEPLOY_ENABLED=false). On prod the form is
            unreachable — visitors land on /waitlist instead. On preview
            (DEPLOY_ENABLED=true) this renders normally. */}
        <Route path="/login" element={<WaitlistGuard source="login"><LoginPage /></WaitlistGuard>} />
        <Route path="/signup" element={<WaitlistGuard source="signup"><SignupPage /></WaitlistGuard>} />
        {/* Pre-launch P0: real password-reset flow. Replaces the old
            mailto link that dropped into Federico's inbox. Better Auth's
            `sendResetPassword` hook emails the reset link; this page
            handles the form side. */}
        <Route path="/forgot-password" element={<WaitlistGuard source="forgot-password"><ForgotPasswordPage /></WaitlistGuard>} />
        <Route path="/reset-password" element={<WaitlistGuard source="reset-password"><ResetPasswordPage /></WaitlistGuard>} />
        {/* v26 §9: /run → /run/apps (drop overview page, apps IS the default landing).
            v25 MePage moves to /run/overview for back-compat during transition. */}
        <Route path="/run" element={<Navigate to="/run/apps" replace />} />
        <Route path="/run/overview" element={<WaitlistGuard source="me"><MePage /></WaitlistGuard>} />
        <Route path="/run/apps" element={<WaitlistGuard source="me"><MeAppsPage /></WaitlistGuard>} />
        <Route path="/run/runs" element={<WaitlistGuard source="me"><MeRunsPage /></WaitlistGuard>} />
        <Route path="/run/runs/:runId" element={<WaitlistGuard source="me"><MeRunDetailPage /></WaitlistGuard>} />
        <Route path="/run/install" element={<WaitlistGuard source="me"><MeInstallPage /></WaitlistGuard>} />
        {/* V12 */}
        <Route path="/run/apps/:slug" element={<SlugToRunRedirect />} />
        <Route path="/run/apps/:slug/run" element={<WaitlistGuard source="me"><MeAppRunPage /></WaitlistGuard>} />
        <Route path="/run/apps/:slug/triggers" element={<WaitlistGuard source="me"><MeAppTriggersPage /></WaitlistGuard>} />
        <Route path="/run/apps/:slug/triggers/schedule" element={<WaitlistGuard source="me"><MeAppTriggerSchedulePage /></WaitlistGuard>} />
        <Route path="/run/apps/:slug/triggers/webhook" element={<WaitlistGuard source="me"><MeAppTriggerWebhookPage /></WaitlistGuard>} />
        {/* v26: /settings is the tabbed workspace settings page (§4).
            /settings alone redirects to /settings/general (account settings).
            Deep-link tabs all exist as sub-routes. */}
        <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
        <Route path="/settings/general" element={<WaitlistGuard source="me"><MeSettingsPage /></WaitlistGuard>} />
        <Route path="/settings/byok-keys" element={<WaitlistGuard source="me"><MeSecretsPage /></WaitlistGuard>} />
        <Route path="/settings/agent-tokens" element={<WaitlistGuard source="me"><MeSettingsTokensPage /></WaitlistGuard>} />
        <Route path="/settings/studio" element={<WaitlistGuard source="studio"><StudioSettingsPage /></WaitlistGuard>} />
        {/* Legacy: /account/settings → /settings/general */}
        <Route path="/account/settings" element={<Navigate to="/settings/general" replace />} />

        {/* Legacy workspace UI URLs. Server returns 301 on direct loads; these
            redirects cover in-app navigation that never reaches the server. */}
        <Route path="/me" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/install" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/apps" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/runs" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/secrets" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/runs/:runId" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/settings" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/agent-keys" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/api-keys" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/settings/tokens" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/apps/:slug" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/apps/:slug/secrets" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/apps/:slug/run" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/me/a/:slug" element={<MeAppRedirect />} />
        <Route path="/me/a/:slug/secrets" element={<MeAppSecretsRedirect />} />
        <Route path="/me/a/:slug/run" element={<MeAppRunRedirect />} />
        {/* v26 §9: /studio → /studio/apps (drop overview page, apps IS default).
            v25 StudioHomePage moves to /studio/overview for back-compat. */}
        <Route path="/studio" element={<Navigate to="/studio/apps" replace />} />
        <Route path="/studio/overview" element={<WaitlistGuard source="studio"><StudioHomePage /></WaitlistGuard>} />
        <Route path="/studio/apps" element={<WaitlistGuard source="studio"><StudioAppsPage /></WaitlistGuard>} />
        <Route path="/studio/runs" element={<WaitlistGuard source="studio"><StudioRunsPage /></WaitlistGuard>} />
        <Route path="/studio/build" element={<WaitlistGuard source="studio"><StudioBuildPage /></WaitlistGuard>} />
        {/* Design-audit fix 2026-04-22: /studio/new is the create-new-app
            entry point shown in wireframe v17. Funnel it to /studio/build
            (the paste-repo flow). Must be listed before /studio/:slug or
            react-router matches "new" as an app slug and 404s. */}
        <Route path="/studio/new" element={<Navigate to="/studio/build" replace />} />
        {/* NOTE: an earlier revision of this branch added
            /studio/my-apps → /studio as a wireframe alias (v17 renamed
            "Home" to "My apps"). Codex correctly flagged that
            `my-apps` is a valid lowercase-kebab app slug, so an
            exact-match redirect would shadow an app with that slug and
            make its overview unreachable. Dropped: the rename is purely
            sidebar copy, and no external URL references
            /studio/my-apps. Revisit if we ever start emitting that URL
            from docs / marketing. */}
        <Route path="/studio/settings" element={<LegacyWorkspaceUiRedirect />} />
        <Route path="/studio/:slug" element={<WaitlistGuard source="studio"><StudioAppPage /></WaitlistGuard>} />
        <Route path="/studio/:slug/runs" element={<WaitlistGuard source="studio"><StudioAppRunsPage /></WaitlistGuard>} />
        <Route path="/studio/:slug/secrets" element={<WaitlistGuard source="studio"><StudioAppSecretsPage /></WaitlistGuard>} />
        <Route path="/studio/:slug/access" element={<WaitlistGuard source="studio"><StudioAppAccessPage /></WaitlistGuard>} />
        <Route path="/studio/:slug/renderer" element={<WaitlistGuard source="studio"><StudioAppRendererPage /></WaitlistGuard>} />
        <Route path="/studio/:slug/analytics" element={<WaitlistGuard source="studio"><StudioAppAnalyticsPage /></WaitlistGuard>} />
        <Route path="/studio/:slug/feedback" element={<WaitlistGuard source="studio"><StudioAppFeedbackPage /></WaitlistGuard>} />
        <Route path="/studio/:slug/triggers" element={<WaitlistGuard source="studio"><StudioTriggersTab /></WaitlistGuard>} />
        {/* Legacy creator-context redirects into Studio (preserve old links). */}
        <Route path="/build" element={<Navigate to="/studio/build" replace />} />
        <Route path="/creator" element={<Navigate to="/studio" replace />} />
        <Route path="/creator/:slug" element={<StudioSlugRedirect />} />
        {/* Kept reachable for tooling that might import them directly, but
            no nav links to them anymore. */}
        <Route path="/_creator-legacy" element={<CreatorPage />} />
        <Route path="/_creator-legacy/:slug" element={<CreatorAppPage />} />
        <Route path="/_build-legacy" element={<BuildPage />} />
        {/* Legacy redirects + nav-label aliases (vanity URLs the TopBar
            labels ("Deploy", "Docs", "Self-host", "Pricing") used to hit
            NotFoundPage. Wire them to the closest existing route so deep
            links from external docs, blogs, and wireframes land safely). */}
        <Route path="/browse" element={<Navigate to="/apps" replace />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/deploy" element={<Navigate to="/studio/build" replace />} />
        {/* v17 Docs hub (2026-04-22). /docs is now a real landing page with
            sidebar nav + welcome content + MCP install trio + self-host snippet
            + runtime specs table. Previous revision redirected here to /protocol. */}
        <Route path="/docs" element={<DocsLandingPage />} />
        {/* /docs/* deep links from wireframes/blogs/external docs. Some subpaths
            used to redirect into /protocol anchors — now that /docs/self-host and
            /docs/api-reference exist as real pages, those redirects are gone.
            Changelog has no on-page section, so it still points at GitHub Releases
            via a hard redirect. */}
        <Route path="/docs/protocol" element={<Navigate to="/protocol" replace />} />
        <Route path="/docs/secrets" element={<Navigate to="/docs/security" replace />} />
        <Route path="/docs/rate-limits" element={<Navigate to="/docs/limits" replace />} />
        <Route path="/docs/publishing" element={<Navigate to="/docs/workflow#publishing-flow" replace />} />
        <Route path="/docs/changelog" element={<ExternalRedirect to="https://github.com/floomhq/floom/releases" />} />
        <Route path="/docs/:slug" element={<DocsPage />} />
        {/* Catch-all /docs/* (any other subpath wireframes advertise) falls back to the docs landing. */}
        <Route path="/docs/*" element={<Navigate to="/docs" replace />} />
        <Route path="/self-host" element={<Navigate to="/#self-host" replace />} />
        {/* /onboarding advertised by v16/onboarding.html wireframe and
            linked from post-signup flows. No standalone page yet — redirect
            to /me?welcome=1 so the dashboard shows a one-shot welcome
            banner ("Welcome to Floom — try an app ↓"). */}
        <Route path="/onboarding" element={<Navigate to="/run/apps?welcome=1" replace />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/ia" element={<IaPage />} />
        <Route path="/architecture" element={<ArchitecturePage />} />
        {/* /changelog — added alongside v17 TopBar (PR #405 ripple fix). */}
        <Route path="/changelog" element={<ChangelogPage />} />
        <Route path="/waitlist" element={<WaitlistPage />} />
        <Route path="/p/:slug/dashboard" element={<PSlugDashboardRedirect />} />
        {/* Legal pages. Floom, Inc. is a Delaware C-Corp. /legal is the
            canonical company-info route; /imprint is kept as a back-compat
            alias because earlier builds (and external sitemaps) used it. */}
        <Route path="/legal" element={<ImprintPage />} />
        <Route path="/imprint" element={<ImprintPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/cookies" element={<CookiesPage />} />
        {/* /legal/* subpath aliases so both URL conventions work. */}
        <Route path="/legal/imprint" element={<Navigate to="/legal" replace />} />
        <Route path="/legal/privacy" element={<Navigate to="/privacy" replace />} />
        <Route path="/legal/terms" element={<Navigate to="/terms" replace />} />
        <Route path="/legal/cookies" element={<Navigate to="/cookies" replace />} />
        {/* German-language alias for anyone typing /impressum from habit. */}
        <Route path="/impressum" element={<Navigate to="/legal" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
        </Suspense>
        <CookieBanner />
      </BrowserRouter>
    </BrowserSentryErrorBoundary>
  </React.StrictMode>,
);
