// v15.2 /me/apps/:slug — app overview for owned apps.
//
// Layout (inspired by /tmp/v15-local/me-app.html): TopBar + shared
// MeRail on the left, tabbed main column on the right. Overview shows
// the app description, a "New run" CTA, and a recent-runs table.
// Secrets lives on its own route /me/apps/:slug/secrets (rendered by
// MeAppSecretsPage) so the overview stays read-only and the tab
// highlight is URL-driven.
//
// The Access / Analytics / Settings tabs from the wireframes are
// intentionally marked "Coming soon" — MVP scope only ships Overview +
// Secrets + New run.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { MeRail } from '../components/me/MeRail';
import { AppIcon } from '../components/AppIcon';
import * as api from '../api/client';
import type { AppDetail, CreatorRun } from '../lib/types';
import { formatTime } from '../lib/time';

export function MeAppPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [runs, setRuns] = useState<CreatorRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setApp(null);
    setRuns(null);
    setError(null);
    api
      .getApp(slug)
      .then((res) => {
        if (!cancelled) setApp(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 404) {
          const q = new URLSearchParams({ notice: 'app_not_found' });
          if (slug) q.set('slug', slug);
          nav(`/me?${q.toString()}`, { replace: true });
          return;
        }
        setError((err as Error).message || 'Failed to load app');
      });
    api
      .getAppRuns(slug, 10)
      .then((res) => {
        if (!cancelled) setRuns(res.runs);
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, nav]);

  return (
    <PageShell
      requireAuth="cloud"
      title={app ? `${app.name} · Floom` : 'App · Floom'}
      contentStyle={{ padding: 0, maxWidth: 'none', minHeight: 'auto' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: 'calc(100vh - 56px)' }}>
        <MeRail activeAppSlug={slug} />
        <main
          style={{
            flex: 1,
            padding: '28px 40px 120px',
            maxWidth: 1000,
            margin: '0 auto',
            width: '100%',
            minWidth: 0,
          }}
        >
          {error && (
            <div
              data-testid="me-app-error"
              style={{
                background: '#fdecea',
                border: '1px solid #f4b7b1',
                color: '#c2321f',
                padding: '10px 14px',
                borderRadius: 8,
                fontSize: 13,
                marginBottom: 20,
              }}
            >
              {error}
            </div>
          )}

          {!app && !error && <LoadingSkeleton />}

          {app && (
            <>
              <AppHeader app={app} />
              <TabBar slug={app.slug} active="overview" />
              <OverviewPanel app={app} runs={runs} />
            </>
          )}
        </main>
      </div>
    </PageShell>
  );
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
        <p
          style={{
            fontSize: 13,
            color: 'var(--muted)',
            margin: '4px 0 0',
            lineHeight: 1.55,
          }}
        >
          {app.description}
        </p>
      </div>
    </div>
  );
}

type TabId = 'overview' | 'run' | 'secrets' | 'access' | 'analytics' | 'settings';

export function TabBar({ slug, active }: { slug: string; active: TabId }) {
  // Keeping Run between Overview and Secrets so the order matches the
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
    { id: 'secrets', label: 'Secrets', to: `/me/apps/${slug}/secrets` },
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

// ---------- Overview panel ----------

function OverviewPanel({
  app,
  runs,
}: {
  app: AppDetail;
  runs: CreatorRun[] | null;
}) {
  return (
    <div data-testid="me-app-overview">
      {app.is_async && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--muted)',
            marginBottom: 16,
          }}
        >
          async app · ~60s per run
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 10,
          marginBottom: 28,
          flexWrap: 'wrap',
        }}
      >
        <Link
          to={`/me/apps/${app.slug}/run`}
          data-testid="me-app-new-run"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 18px',
            background: 'var(--ink)',
            color: '#fff',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          New run →
        </Link>
        <Link
          to={`/me/apps/${app.slug}/secrets`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 18px',
            background: 'var(--card)',
            color: 'var(--ink)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Manage secrets
        </Link>
      </div>

      <h2
        style={{
          fontSize: 12,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--muted)',
          margin: '0 0 10px',
        }}
      >
        Recent runs
      </h2>

      {!runs && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {runs && runs.length === 0 && (
        <div
          data-testid="me-app-runs-empty"
          style={{
            border: '1px dashed var(--line)',
            borderRadius: 10,
            padding: '24px 20px',
            background: 'var(--card)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
            No runs yet
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
            Click <strong>New run</strong> above to kick off the first one.
          </p>
        </div>
      )}
      {runs && runs.length > 0 && (
        <div
          data-testid="me-app-runs"
          style={{
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--card)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr 1fr 1fr 80px',
              gap: 8,
              padding: '10px 16px',
              background: 'var(--bg)',
              borderBottom: '1px solid var(--line)',
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--muted)',
              fontWeight: 700,
            }}
          >
            <span>Started</span>
            <span>Action</span>
            <span>Status</span>
            <span style={{ textAlign: 'right' }}>Time</span>
          </div>
          {runs.map((r) => (
            <Link
              key={r.id}
              to={`/me/runs/${r.id}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 1fr 1fr 80px',
                gap: 8,
                padding: '12px 16px',
                borderBottom: '1px solid var(--line)',
                fontSize: 13,
                color: 'var(--ink)',
                textDecoration: 'none',
                alignItems: 'center',
              }}
            >
              <span>{formatTime(r.started_at)}</span>
              <span
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 12,
                  color: 'var(--muted)',
                }}
              >
                {r.action}
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.status}</span>
              <span style={{ textAlign: 'right', fontSize: 12, color: 'var(--muted)' }}>
                {r.duration_ms ? `${Math.round(r.duration_ms)}ms` : '-'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div data-testid="me-app-loading" style={{ opacity: 0.6 }}>
      <div
        style={{
          height: 44,
          background: 'var(--bg)',
          borderRadius: 8,
          marginBottom: 16,
        }}
      />
      <div
        style={{
          height: 200,
          background: 'var(--bg)',
          borderRadius: 10,
        }}
      />
    </div>
  );
}
