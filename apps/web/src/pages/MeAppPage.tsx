// MVP stub: /me/apps/:slug → redirect for launch.
// AppHeader, TabBar exports below are preserved as other pages depend on them.

import { Link, Navigate } from 'react-router-dom';
import { AppIcon } from '../components/AppIcon';
import { DescriptionMarkdown } from '../components/DescriptionMarkdown';
import type { AppDetail } from '../lib/types';

export function MeAppPage() {
  return <Navigate to="/me/agent-keys" replace />;
}

// ---------- Shared header + tabs ----------

export function AppHeader({ app }: { app: AppDetail }) {
  const isPrivate = (app as AppDetail & { visibility?: string }).visibility === 'private';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        marginBottom: 20,
      }}
    >
      {/* #279 launch polish (2026-04-21): gradient tile + ring. */}
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
          background:
            'radial-gradient(circle at 30% 25%, #d1fae5 0%, #ecfdf5 55%, #d1fae5 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow:
            'inset 0 0 0 1px rgba(5,150,105,0.15), 0 1px 2px rgba(5,150,105,0.18), inset 0 1px 0 rgba(255,255,255,0.6)',
        }}
      >
        <AppIcon slug={app.slug} size={22} color="#047857" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)', margin: 0 }}>
            {app.name}
          </h1>
          {isPrivate && (
            <span
              title="Only you can see and run this app"
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                padding: '3px 8px',
                borderRadius: 4,
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                color: 'var(--muted)',
              }}
            >
              Private
            </span>
          )}
        </div>
        {/* 2026-04-23: Fix #413 — render description as markdown so
            `## Heading` and formatted creator copy display properly. */}
        {app.description && (
          <DescriptionMarkdown
            description={app.description}
            testId={`me-app-overview-desc-${app.slug}`}
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              margin: '4px 0 0',
              lineHeight: 1.55,
              maxWidth: 'none',
            }}
          />
        )}
      </div>
    </div>
  );
}

type TabId = 'overview' | 'run' | 'secrets' | 'access' | 'analytics' | 'settings';

export function TabBar({ slug, active }: { slug: string; active: TabId }) {
  // Keeping Run between Overview and app creator secrets so the order matches the
  // user's mental flow: "here's my app → let me use it → manage keys".
  // `/me/apps/:slug/run` is the exception to the v16 Studio redirect
  // rule (see `main.tsx`), so a TabBar link to it stays inside the
  // `/me` consumer shell instead of bouncing into Studio.
  const tabs: Array<{
    id: TabId;
    label: string;
    to?: string;
    disabled?: boolean;
  }> = [
    { id: 'overview', label: 'Overview', to: `/me/apps/${slug}` },
    { id: 'run', label: 'Run', to: `/me/apps/${slug}/run` },
    { id: 'secrets', label: 'App creator secrets', to: `/me/apps/${slug}/secrets` },
    { id: 'access', label: 'Access', disabled: true },
    { id: 'analytics', label: 'Analytics', disabled: true },
    { id: 'settings', label: 'Settings', disabled: true },
  ];
  return (
    <div
      role="tablist"
      aria-label="App tabs"
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: '1px solid var(--line)',
        marginBottom: 24,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        const base = {
          padding: '10px 14px',
          fontSize: 13,
          fontWeight: 600,
          borderBottom: isActive
            ? '2px solid var(--accent)'
            : '2px solid transparent',
          marginBottom: -1,
          color: isActive ? 'var(--accent)' : 'var(--muted)',
        };
        if (tab.disabled) {
          return (
            <span
              key={tab.id}
              role="tab"
              aria-selected={false}
              aria-disabled="true"
              aria-label={`${tab.label} (coming soon)`}
              tabIndex={-1}
              data-testid={`me-app-tab-${tab.id}`}
              title="Coming soon"
              style={{
                ...base,
                color: 'var(--muted)',
                opacity: 0.55,
                cursor: 'not-allowed',
              }}
            >
              {tab.label}
            </span>
          );
        }
        return (
          <Link
            key={tab.id}
            to={tab.to!}
            role="tab"
            aria-selected={isActive}
            data-testid={`me-app-tab-${tab.id}`}
            style={{ ...base, textDecoration: 'none' }}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
