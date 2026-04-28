/**
 * SettingsTabBar — v26 tabbed navigation for /settings/* pages.
 *
 * V26-IA-SPEC §/settings: Single page with tabs:
 *   General · BYOK keys · Agent tokens · Studio settings ·
 *   [Members v1.1] · [Billing v1.1]
 *
 * Renders as a horizontal tab strip at the top of the settings content area.
 * URL-based active detection: each tab corresponds to a /settings/* route.
 */

import type { CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';

interface Tab {
  label: string;
  to: string;
  /** Partial path suffix to match (e.g. "/general") */
  match: string;
  /** If true, tab is shown greyed out (v1.1 deferred) */
  soon?: boolean;
}

const TABS: Tab[] = [
  { label: 'General', to: '/settings/general', match: '/settings/general' },
  { label: 'BYOK keys', to: '/settings/byok-keys', match: '/settings/byok-keys' },
  { label: 'Agent tokens', to: '/settings/agent-tokens', match: '/settings/agent-tokens' },
  { label: 'Studio settings', to: '/settings/studio', match: '/settings/studio' },
  { label: 'Members', to: '/settings/members', match: '/settings/members', soon: true },
  { label: 'Billing', to: '/settings/billing', match: '/settings/billing', soon: true },
];

const wrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 0,
  borderBottom: '1px solid var(--line)',
  marginBottom: 24,
  overflowX: 'auto',
};

function tabStyle(active: boolean, soon?: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '10px 14px',
    fontSize: 13,
    fontWeight: active ? 700 : 500,
    color: soon ? 'var(--muted)' : active ? 'var(--ink)' : 'var(--muted)',
    textDecoration: 'none',
    borderBottom: active ? '2px solid var(--ink)' : '2px solid transparent',
    marginBottom: -1,
    whiteSpace: 'nowrap' as const,
    opacity: soon ? 0.45 : 1,
    cursor: soon ? 'default' : undefined,
    pointerEvents: soon ? 'none' : undefined,
    transition: 'color 0.1s',
  };
}

export function SettingsTabBar() {
  const location = useLocation();

  return (
    <nav style={wrapStyle} aria-label="Settings tabs" data-testid="settings-tab-bar">
      {TABS.map((tab) => {
        const active = location.pathname === tab.match;
        if (tab.soon) {
          return (
            <span
              key={tab.to}
              style={tabStyle(active, true)}
              title="Coming in v1.1"
            >
              {tab.label}
            </span>
          );
        }
        return (
          <Link
            key={tab.to}
            to={tab.to}
            style={tabStyle(active)}
            aria-current={active ? 'page' : undefined}
            data-testid={`settings-tab-${tab.match.replace('/settings/', '')}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
