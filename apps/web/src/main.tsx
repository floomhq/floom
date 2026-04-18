import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
// Landing is eager (LCP path). Everything else is lazy so the initial
// bundle only carries the homepage React tree. Trimmed initial JS from
// 427 KB (118 KB gzip) to the landing slice; other pages stream in on
// route change. Mobile Lighthouse Perf: 71 -> 90+.
import { CreatorHeroPage } from './pages/CreatorHeroPage';
import { NotFoundPage } from './pages/NotFoundPage';
const AppsDirectoryPage = lazy(() => import('./pages/AppsDirectoryPage').then(m => ({ default: m.AppsDirectoryPage })));
const AppPermalinkPage = lazy(() => import('./pages/AppPermalinkPage').then(m => ({ default: m.AppPermalinkPage })));
const ProtocolPage = lazy(() => import('./pages/ProtocolPage').then(m => ({ default: m.ProtocolPage })));
const LoginPage = lazy(() => import('./pages/LoginPage').then(m => ({ default: m.LoginPage })));
const MePage = lazy(() => import('./pages/MePage').then(m => ({ default: m.MePage })));
const MeRunDetailPage = lazy(() => import('./pages/MeRunDetailPage').then(m => ({ default: m.MeRunDetailPage })));
const MeSettingsPage = lazy(() => import('./pages/MeSettingsPage').then(m => ({ default: m.MeSettingsPage })));
// MeAppPage + MeAppSecretsPage still live on disk for shared component
// exports (AppHeader, TabBar) used by the Studio pages; the routes that
// mounted them directly now redirect into /studio/*.
const MeAppRunPage = lazy(() => import('./pages/MeAppRunPage').then(m => ({ default: m.MeAppRunPage })));
const MeInstallPage = lazy(() => import('./pages/MeInstallPage').then(m => ({ default: m.MeInstallPage })));
const BuildPage = lazy(() => import('./pages/BuildPage').then(m => ({ default: m.BuildPage })));
const CreatorPage = lazy(() => import('./pages/CreatorPage').then(m => ({ default: m.CreatorPage })));
const CreatorAppPage = lazy(() => import('./pages/CreatorAppPage').then(m => ({ default: m.CreatorAppPage })));
// Studio context — creator workspace (v16 restructure 2026-04-18). Two
// contexts share the same user: Store (light surface, consumer) and
// Studio (darker surface, sidebar, tool chrome). All /studio/* routes
// auth-gate through StudioLayout (cloud-only).
const StudioHomePage = lazy(() => import('./pages/StudioHomePage').then(m => ({ default: m.StudioHomePage })));
const StudioBuildPage = lazy(() => import('./pages/StudioBuildPage').then(m => ({ default: m.StudioBuildPage })));
const StudioAppPage = lazy(() => import('./pages/StudioAppPage').then(m => ({ default: m.StudioAppPage })));
const StudioAppRunsPage = lazy(() => import('./pages/StudioAppRunsPage').then(m => ({ default: m.StudioAppRunsPage })));
const StudioAppSecretsPage = lazy(() => import('./pages/StudioAppSecretsPage').then(m => ({ default: m.StudioAppSecretsPage })));
const StudioAppAccessPage = lazy(() => import('./pages/StudioAppAccessPage').then(m => ({ default: m.StudioAppAccessPage })));
const StudioAppRendererPage = lazy(() => import('./pages/StudioAppRendererPage').then(m => ({ default: m.StudioAppRendererPage })));
const StudioAppAnalyticsPage = lazy(() => import('./pages/StudioAppAnalyticsPage').then(m => ({ default: m.StudioAppAnalyticsPage })));
const StudioSettingsPage = lazy(() => import('./pages/StudioSettingsPage').then(m => ({ default: m.StudioSettingsPage })));
const ImprintPage = lazy(() => import('./pages/ImprintPage').then(m => ({ default: m.ImprintPage })));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage').then(m => ({ default: m.PrivacyPage })));
const TermsPage = lazy(() => import('./pages/TermsPage').then(m => ({ default: m.TermsPage })));
const CookiesPage = lazy(() => import('./pages/CookiesPage').then(m => ({ default: m.CookiesPage })));
import { IconSprite } from './components/IconSprite';
import { CookieBanner } from './components/CookieBanner';
import { RouteLoading } from './components/RouteLoading';
import { primeSession } from './hooks/useSession';
import './styles/globals.css';

// Optional Sentry wiring. No-op when VITE_SENTRY_DSN is unset — the preview
// image ships without a DSN so this stays dark until Federico wires one up.
// Source maps are uploaded via Sentry's build plugin (not configured here
// yet — that's a follow-up when Sentry is actually turned on).
const SENTRY_DSN = (import.meta as { env?: Record<string, string | undefined> }).env
  ?.VITE_SENTRY_DSN;
if (SENTRY_DSN) {
  const SECRET_RE = /(password|token|api[_-]?key|authorization|secret|cookie)/i;
  function scrubDeep(v: unknown, depth = 0): unknown {
    if (depth > 8 || v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map((x) => scrubDeep(x, depth + 1));
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (SECRET_RE.test(k)) obj[k] = '[Scrubbed]';
        else obj[k] = scrubDeep(obj[k], depth + 1);
      }
      return obj;
    }
    return v;
  }
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: (import.meta as { env?: Record<string, string | undefined> }).env?.MODE ||
      'production',
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request) scrubDeep(event.request);
      if (event.extra) scrubDeep(event.extra);
      if (event.contexts) scrubDeep(event.contexts);
      return event;
    },
  });
}

// Kick off the /api/session/me fetch as soon as the bundle loads so every
// page's first render already has a value.
primeSession();

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
  return <Navigate to={`/me/apps/${slug ?? ''}`} replace />;
}
function MeAppSecretsRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/me/apps/${slug ?? ''}/secrets`} replace />;
}
function MeAppRunRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/me/apps/${slug ?? ''}/run`} replace />;
}

// Studio restructure 2026-04-18: Store/Studio split. These redirects
// funnel every legacy creator-context URL into the new /studio/* tree.
// Each uses <Navigate replace> so query strings and bookmarks stay alive.
function StudioSlugRedirect({ subpath }: { subpath?: string }) {
  const { slug } = useParams<{ slug: string }>();
  const tail = subpath ? `/${subpath}` : '';
  return <Navigate to={`/studio/${slug ?? ''}${tail}`} replace />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IconSprite />
    <BrowserRouter>
      <Suspense fallback={<RouteLoading variant="full" />}>
      <Routes>
        {/* Creator hero */}
        <Route path="/" element={<CreatorHeroPage />} />
        {/* Apps directory */}
        <Route path="/apps" element={<AppsDirectoryPage />} />
        {/* Standalone app permalink */}
        <Route path="/p/:slug" element={<AppPermalinkPage />} />
        {/* Protocol spec page */}
        <Route path="/protocol" element={<ProtocolPage />} />
        {/* W4-minimal: auth pages */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<LoginPage />} />
        {/* W4-minimal: user dashboard */}
        <Route path="/me" element={<MePage />} />
        <Route path="/me/install" element={<MeInstallPage />} />
        <Route path="/me/runs/:runId" element={<MeRunDetailPage />} />
        <Route path="/me/settings" element={<MeSettingsPage />} />
        {/* v16 studio restructure 2026-04-18: creator-context pages moved
            to /studio/*. Legacy /me/apps/:slug (owner context) redirects
            to the new Studio tree. MeAppRunPage stays under /me/apps/:slug/run
            because "run an owned app" is a /me (consumer) action, not a
            creator management action — the RunSurface lives there, and
            Studio links into it when needed. */}
        <Route path="/me/apps/:slug" element={<StudioSlugRedirect />} />
        <Route path="/me/apps/:slug/secrets" element={<StudioSlugRedirect subpath="secrets" />} />
        <Route path="/me/apps/:slug/run" element={<MeAppRunPage />} />
        {/* Legacy /me/a/:slug redirects (preserve old bookmarks). The
            /secrets and /run variants keep the existing hop to the
            /me/apps/:slug* chain, which then funnels to /studio/*. */}
        <Route path="/me/a/:slug" element={<MeAppRedirect />} />
        <Route path="/me/a/:slug/secrets" element={<MeAppSecretsRedirect />} />
        <Route path="/me/a/:slug/run" element={<MeAppRunRedirect />} />
        {/* Studio context (v16 restructure 2026-04-18). Creator workspace:
            manage every app you own, publish new ones, upload renderers.
            Auth-gated via StudioLayout. */}
        <Route path="/studio" element={<StudioHomePage />} />
        <Route path="/studio/build" element={<StudioBuildPage />} />
        <Route path="/studio/settings" element={<StudioSettingsPage />} />
        <Route path="/studio/:slug" element={<StudioAppPage />} />
        <Route path="/studio/:slug/runs" element={<StudioAppRunsPage />} />
        <Route path="/studio/:slug/secrets" element={<StudioAppSecretsPage />} />
        <Route path="/studio/:slug/access" element={<StudioAppAccessPage />} />
        <Route path="/studio/:slug/renderer" element={<StudioAppRendererPage />} />
        <Route path="/studio/:slug/analytics" element={<StudioAppAnalyticsPage />} />
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
        <Route path="/about" element={<Navigate to="/" replace />} />
        <Route path="/deploy" element={<Navigate to="/studio/build" replace />} />
        <Route path="/docs" element={<Navigate to="/protocol" replace />} />
        <Route path="/self-host" element={<Navigate to="/#self-host" replace />} />
        <Route path="/pricing" element={<Navigate to="/" replace />} />
        <Route path="/store" element={<Navigate to="/apps" replace />} />
        <Route path="/p/:slug/dashboard" element={<PSlugDashboardRedirect />} />
        {/* Legal pages (DE commercial site: §5 TMG imprint is mandatory). */}
        <Route path="/imprint" element={<ImprintPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/cookies" element={<CookiesPage />} />
        {/* /legal/* aliases so both URL conventions work. */}
        <Route path="/legal/imprint" element={<Navigate to="/imprint" replace />} />
        <Route path="/legal/privacy" element={<Navigate to="/privacy" replace />} />
        <Route path="/legal/terms" element={<Navigate to="/terms" replace />} />
        <Route path="/legal/cookies" element={<Navigate to="/cookies" replace />} />
        {/* German-language alias for imprint (users may type /impressum). */}
        <Route path="/impressum" element={<Navigate to="/imprint" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      </Suspense>
      <CookieBanner />
    </BrowserRouter>
  </React.StrictMode>,
);
