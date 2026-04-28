/**
 * StudioAppTabs — 8-tab navigation for /studio/:slug/* pages.
 *
 * V26-IA-SPEC: per-app tab bar rendered at the top of the content area
 * inside WorkspacePageShell mode="studio". Each tab corresponds to a
 * /studio/:slug/* subroute. Active tab gets aria-current="page" + emerald
 * accent underline.
 *
 * NOT rendered on /studio/build (that page uses WorkspacePageShell
 * mode="studio" but has no per-app context).
 */

import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';

export type StudioAppTab =
  | 'overview'
  | 'runs'
  | 'secrets'
  | 'access'
  | 'analytics'
  | 'source'
  | 'feedback'
  | 'triggers';

interface Props {
  slug: string;
  activeTab: StudioAppTab;
}

interface TabDef {
  id: StudioAppTab;
  label: string;
  to: (slug: string) => string;
}

const TABS: TabDef[] = [
  { id: 'overview',   label: 'Overview',              to: (s) => `/studio/${s}` },
  { id: 'runs',       label: 'Runs',                  to: (s) => `/studio/${s}/runs` },
  { id: 'secrets',    label: 'App creator secrets',   to: (s) => `/studio/${s}/secrets` },
  { id: 'access',     label: 'Access',                to: (s) => `/studio/${s}/access` },
  { id: 'analytics',  label: 'Analytics',             to: (s) => `/studio/${s}/analytics` },
  { id: 'source',     label: 'Source',                to: (s) => `/studio/${s}/renderer` },
  { id: 'feedback',   label: 'Feedback',              to: (s) => `/studio/${s}/feedback` },
  { id: 'triggers',   label: 'Triggers',              to: (s) => `/studio/${s}/triggers` },
];

const wrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 0,
  borderBottom: '1px solid var(--line)',
  marginBottom: 24,
  overflowX: 'auto',
};

function tabStyle(active: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '10px 14px',
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--accent, #047857)' : 'var(--muted)',
    textDecoration: 'none',
    borderBottom: active ? '2px solid var(--accent, #047857)' : '2px solid transparent',
    marginBottom: -1,
    whiteSpace: 'nowrap' as const,
    transition: 'color 0.1s',
  };
}

export function StudioAppTabs({ slug, activeTab }: Props) {
  return (
    <nav
      style={wrapStyle}
      aria-label="Studio app tabs"
      data-testid="studio-app-tabs"
    >
      {TABS.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <Link
            key={tab.id}
            to={tab.to(slug)}
            style={tabStyle(active)}
            aria-current={active ? 'page' : undefined}
            data-testid={`studio-tab-${tab.id}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
