// MVP stub: /studio/:slug → redirect for launch.
// StudioAppTabs export preserved as other Studio pages depend on it.

import { Link, Navigate } from 'react-router-dom';

type StudioAppTabId = 'overview' | 'runs' | 'secrets' | 'access' | 'analytics' | 'source' | 'feedback' | 'triggers';

export function StudioAppTabs({ slug, active }: { slug: string; active: StudioAppTabId }) {
  const tabs: Array<{ id: StudioAppTabId; label: string; to: string }> = [
    { id: 'overview', label: 'Overview', to: `/studio/${slug}` },
    { id: 'runs', label: 'Runs', to: `/studio/${slug}/runs` },
    { id: 'secrets', label: 'App creator secrets', to: `/studio/${slug}/secrets` },
    { id: 'access', label: 'Access', to: `/studio/${slug}/access` },
    { id: 'analytics', label: 'Analytics', to: `/studio/${slug}/analytics` },
    { id: 'source', label: 'Source', to: `/studio/${slug}/renderer` },
    { id: 'feedback', label: 'Feedback', to: `/studio/${slug}/feedback` },
    { id: 'triggers', label: 'Triggers', to: `/studio/${slug}/triggers` },
  ];
  return (
    <div role="tablist" aria-label="Studio app tabs" style={studioTabsStyle}>
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          to={tab.to}
          aria-current={tab.id === active ? 'page' : undefined}
          style={studioTabStyle(tab.id === active)}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

export function StudioAppPage() {
  return <Navigate to="/me/agent-keys" replace />;
}

const studioTabsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: '1px solid var(--line)',
  margin: '0 0 24px',
  overflowX: 'auto',
};

function studioTabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '10px 12px',
    fontSize: 12.5,
    fontWeight: 700,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    color: active ? 'var(--ink)' : 'var(--muted)',
    borderBottom: active ? '2px solid var(--ink)' : '2px solid transparent',
  };
}
