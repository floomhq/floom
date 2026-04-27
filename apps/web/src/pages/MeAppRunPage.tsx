// MVP stub: /me/apps/:slug/run → redirect for launch.
// RunAppTabs export preserved as MeAppTriggersPage etc. depend on it.

import { Link, Navigate } from 'react-router-dom';

export function MeAppRunPage() {
  return <Navigate to="/me/agent-keys" replace />;
}

export function RunAppTabs({ slug, active }: { slug: string; active: 'run' | 'triggers' }) {
  const tabs = [
    { id: 'run' as const, label: 'Run', to: `/run/apps/${slug}/run` },
    { id: 'triggers' as const, label: 'Triggers', to: `/run/apps/${slug}/triggers` },
  ];
  return (
    <div role="tablist" aria-label="Run app tabs" style={tabsStyle}>
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          to={tab.to}
          aria-current={active === tab.id ? 'page' : undefined}
          style={tabStyle(active === tab.id)}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

const tabsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  borderBottom: '1px solid var(--line)',
  marginBottom: 18,
};

function tabStyle(active: boolean): React.CSSProperties {
  return {
    padding: '10px 14px',
    fontSize: 13,
    fontWeight: 700,
    textDecoration: 'none',
    color: active ? 'var(--ink)' : 'var(--muted)',
    borderBottom: active ? '2px solid var(--ink)' : '2px solid transparent',
  };
}
