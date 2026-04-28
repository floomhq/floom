// v26 V17 — Docs layout shell.
//
// Mirrors the WorkspacePageShell pattern: flex row, sidebar has an explicit
// fixed width + flexShrink:0 so it never shifts regardless of content width
// in the article column. Previously both DocsLandingPage and DocsPage used
// CSS grid with `minmax(0,1fr)` on the content column, which reflows the
// grid on navigation and can cause a visible sidebar x-shift.
//
// Layout spec (no docs wireframe in v26 — mirrors WorkspacePageShell):
//   - Sidebar: 260px fixed, flexShrink: 0, sticky
//   - Content: flex:1, minWidth:0, max-width capped at 1000px for readability
//   - Container: max-width 1280, margin 0 auto, flush padding
//
// DocsSidebar and DocsPublishWaitlistBanner are NOT rendered here — they
// are passed as children so each page controls its own sidebar+banner.

import type { CSSProperties, ReactNode } from 'react';

interface Props {
  sidebar: ReactNode;
  children: ReactNode;
  banner?: ReactNode;
}

const containerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  maxWidth: 1280,
  margin: '0 auto',
  width: '100%',
  boxSizing: 'border-box',
};

export const DOCS_SIDEBAR_WIDTH = 260;

const sidebarWrapStyle: CSSProperties = {
  width: DOCS_SIDEBAR_WIDTH,
  flexShrink: 0,
  // Sticky so the sidebar stays in view while the article scrolls. The
  // sticky offset accounts for the TopBar (56px) + optional waitlist banner
  // (~40px) — using 0 here means it sticks just below the natural flow
  // top; DocsSidebar itself sets position:sticky top:0, so the sidebar
  // column anchors at viewport top.
};

const contentStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

export function DocsPageShell({ sidebar, children, banner }: Props) {
  return (
    <div className="docs-shell-v26">
      {banner}
      <main className="docs-shell-v26__grid" style={containerStyle}>
        <style>{`
          @media (max-width: 900px) {
            .docs-shell-v26__grid {
              flex-direction: column !important;
            }
            .docs-shell-v26__sidebar {
              width: 100% !important;
              flex-shrink: unset !important;
            }
          }
        `}</style>
        <div className="docs-shell-v26__sidebar" style={sidebarWrapStyle}>
          {sidebar}
        </div>
        <div className="docs-shell-v26__content" style={contentStyle}>
          {children}
        </div>
      </main>
    </div>
  );
}
