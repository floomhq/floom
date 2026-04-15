import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { CreatorHeroPage } from './pages/CreatorHeroPage';
import { AppsDirectoryPage } from './pages/AppsDirectoryPage';
import { AppPermalinkPage } from './pages/AppPermalinkPage';
import { ProtocolPage } from './pages/ProtocolPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { IconSprite } from './components/IconSprite';
import './styles/globals.css';

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
        {/* Legacy redirects */}
        <Route path="/browse" element={<Navigate to="/apps" replace />} />
        <Route path="/about" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
