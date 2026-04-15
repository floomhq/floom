import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
import { IconSprite } from './components/IconSprite';
import { primeSession } from './hooks/useSession';
import './styles/globals.css';

// Kick off the /api/session/me fetch as soon as the bundle loads so every
// page's first render already has a value.
primeSession();

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
        {/* Legacy redirects */}
        <Route path="/browse" element={<Navigate to="/apps" replace />} />
        <Route path="/about" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
