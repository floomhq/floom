import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { CreatorHeroPage } from './pages/CreatorHeroPage';
import { AppsDirectoryPage } from './pages/AppsDirectoryPage';
import { AppPermalinkPage } from './pages/AppPermalinkPage';
import { ProtocolPage } from './pages/ProtocolPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { LoginPage } from './pages/LoginPage';
import { MePage } from './pages/MePage';
import { MeRunDetailPage } from './pages/MeRunDetailPage';
import { MeSettingsPage } from './pages/MeSettingsPage';
import { BuildPage } from './pages/BuildPage';
import { CreatorPage } from './pages/CreatorPage';
import { CreatorAppPage } from './pages/CreatorAppPage';
import { ImprintPage } from './pages/ImprintPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { TermsPage } from './pages/TermsPage';
import { CookiesPage } from './pages/CookiesPage';
import { IconSprite } from './components/IconSprite';
import { CookieBanner } from './components/CookieBanner';
import { primeSession } from './hooks/useSession';
import './styles/globals.css';

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
      <CookieBanner />
    </BrowserRouter>
  </React.StrictMode>,
);
