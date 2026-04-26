// Shared 5-tab strip for the /me dashboard sub-pages: Apps, Runs, BYOK
// keys (= /me/secrets), Agent tokens (= /me/agent-keys), with Overview
// at the head. Used on every /me/* page that lives under MeLayout.
//
// v23 wireframe spec:
//   - 5 tabs in fixed order: Overview · Apps · Runs · BYOK keys · Agent tokens
//   - Active tab gets `.on` styling (ink color + underline)
//   - Counts render as a JetBrains-Mono pill next to each tab label;
//     hidden when the count is undefined or 0 (don't show "0")
//   - Mobile uses the SAME labels, NEVER abbreviated to "BYOK" / "Tokens"
//     — only typography shrinks. Bullet-dot separator instead of pill.
//
// Vocabulary lock: this strip MUST say "BYOK keys" and "Agent tokens"
// (NOT "Secrets", NOT "API keys"). See keys-decision.md.
//
// NOTE: Settings is NOT in this strip. Settings lives under the avatar
// dropdown on /me overview's `.me-primary-nav` (different component,
// owned by /me PR-B).

import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';

export type MeTabStripActive =
  | 'overview'
  | 'apps'
  | 'runs'
  | 'secrets'
  | 'agent-keys';

interface MeTabStripCounts {
  apps?: number;
  runs?: number;
  secrets?: number;
  agentKeys?: number;
}

interface MeTabStripProps {
  active: MeTabStripActive;
  counts?: MeTabStripCounts;
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  gap: 1,
  borderBottom: '1px solid var(--line)',
  marginBottom: 24,
  overflowX: 'auto',
};

const tabBase: CSSProperties = {
  padding: '11px 16px',
  fontSize: 13.5,
  color: 'var(--muted)',
  textDecoration: 'none',
  borderBottom: '2px solid transparent',
  fontWeight: 500,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
  whiteSpace: 'nowrap',
};

const tabActive: CSSProperties = {
  color: 'var(--ink)',
  borderBottomColor: 'var(--ink)',
  fontWeight: 600,
};

const ctStyle: CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  color: 'var(--muted)',
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: '1px 7px',
};

function CountBadge({ value }: { value?: number }) {
  if (value === undefined || value === null || value === 0) return null;
  return <span style={ctStyle}>{value}</span>;
}

export function MeTabStrip({ active, counts }: MeTabStripProps) {
  const tabs: Array<{
    id: MeTabStripActive;
    label: string;
    href: string;
    count?: number;
    testId: string;
  }> = [
    {
      id: 'overview',
      label: 'Overview',
      href: '/me',
      testId: 'me-tab-overview',
    },
    {
      id: 'apps',
      label: 'Apps',
      href: '/me/apps',
      count: counts?.apps,
      testId: 'me-tab-apps',
    },
    {
      id: 'runs',
      label: 'Runs',
      href: '/me/runs',
      count: counts?.runs,
      testId: 'me-tab-runs',
    },
    {
      id: 'secrets',
      label: 'BYOK keys',
      href: '/me/secrets',
      count: counts?.secrets,
      testId: 'me-tab-secrets',
    },
    {
      id: 'agent-keys',
      label: 'Agent tokens',
      href: '/me/agent-keys',
      count: counts?.agentKeys,
      testId: 'me-tab-agent-keys',
    },
  ];

  return (
    <nav
      data-testid="me-tab-strip"
      aria-label="Account sections"
      style={wrapStyle}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.id}
            to={tab.href}
            data-testid={tab.testId}
            aria-current={isActive ? 'page' : undefined}
            style={{ ...tabBase, ...(isActive ? tabActive : {}) }}
          >
            {tab.label}
            <CountBadge value={tab.count} />
          </Link>
        );
      })}
    </nav>
  );
}
