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
const MeAppPage = lazy(() => import('./pages/MeAppPage').then(m => ({ default: m.MeAppPage })));
const MeAppSecretsPage = lazy(() => import('./pages/MeAppSecretsPage').then(m => ({ default: m.MeAppSecretsPage })));
const MeAppRunPage = lazy(() => import('./pages/MeAppRunPage').then(m => ({ default: m.MeAppRunPage })));
const BuildPage = lazy(() => import('./pages/BuildPage').then(m => ({ default: m.BuildPage })));
const CreatorPage = lazy(() => import('./pages/CreatorPage').then(m => ({ default: m.CreatorPage })));
const CreatorAppPage = lazy(() => import('./pages/CreatorAppPage').then(m => ({ default: m.CreatorAppPage })));
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
        <Route path="/me/runs/:runId" element={<MeRunDetailPage />} />
        <Route path="/me/settings" element={<MeSettingsPage />} />
        {/* v15.2: per-app overview / secrets / run surfaces for owned apps. */}
        <Route path="/me/a/:slug" element={<MeAppPage />} />
        <Route path="/me/a/:slug/secrets" element={<MeAppSecretsPage />} />
        <Route path="/me/a/:slug/run" element={<MeAppRunPage />} />
        {/* W4-minimal: creator flow */}
        <Route path="/build" element={<BuildPage />} />
        <Route path="/creator" element={<CreatorPage />} />
        <Route path="/creator/:slug" element={<CreatorAppPage />} />
        {/* Legacy redirects + nav-label aliases (vanity URLs the TopBar
            labels ("Deploy", "Docs", "Self-host", "Pricing") used to hit
            NotFoundPage. Wire them to the closest existing route so deep
            links from external docs, blogs, and wireframes land safely). */}
        <Route path="/browse" element={<Navigate to="/apps" replace />} />
        <Route path="/about" element={<Navigate to="/" replace />} />
        <Route path="/deploy" element={<Navigate to="/build" replace />} />
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
