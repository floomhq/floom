// Studio sidebar nav. Creator-context navigation with per-app drilldown
// when a slug is active. Mirrors the v16 wireframes Studio shape:
// brand + "Your apps (N)" list + "+ New app" CTA. When a slug is active,
// expand a per-app sub-tree (Overview / Runs / Secrets / Access /
// Renderer / Analytics). Footer pinned: Settings · Billing (stub) · Back
// to Store.
//
// Styled to match the darker creator surface (#F5F5F1 background).
//
// No threads list here — that's /me territory. Studio is for managing
// apps you've published, not browsing your own run history.

import { Link, useLocation } from 'react-router-dom';
import type { CSSProperties, ReactNode } from 'react';
import { Logo } from '../Logo';
import { AppIcon } from '../AppIcon';
import { useMyApps } from '../../hooks/useMyApps';
import { useSession } from '../../hooks/useSession';

const RAIL_WIDTH = 240;

interface Props {
  activeAppSlug?: string;
  activeSubsection?: 'overview' | 'runs' | 'secrets' | 'access' | 'renderer' | 'analytics' | 'triggers';
  signedOutPreview?: boolean;
}

export function StudioSidebar({
  activeAppSlug,
  activeSubsection = 'overview',
  signedOutPreview = false,
}: Props) {
  const { apps, loading, error } = useMyApps();
  const { data: session } = useSession();
  const user = session?.user;
  const location = useLocation();
  const ownedCount = apps?.length ?? 0;
  const settingsHref = signedOutPreview
    ? '/login?next=%2Fstudio%2Fsettings'
    : '/studio/settings';
  const newAppHref = signedOutPreview
    ? '/signup?next=%2Fstudio%2Fbuild'
    : '/studio/build';

  return (
    <aside
      data-studio-sidebar="true"
      aria-label="Studio navigation"
      className="studio-sidebar"
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        borderRight: '1px solid var(--line)',
        background: '#F5F5F1',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        position: 'sticky',
        top: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '18px 16px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <Link
          to="/studio"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
            color: 'var(--ink)',
            fontWeight: 700,
            fontSize: 15,
            padding: '0 6px',
          }}
        >
          <Logo size={22} />
          <span>Studio</span>
        </Link>

        <Link
          to={newAppHref}
          data-testid="studio-new-app"
          style={primaryCtaStyle}
        >
          <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
          <span>{signedOutPreview ? 'Publish an app' : 'New app'}</span>
        </Link>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <section style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionLabel>Your apps {signedOutPreview ? '' : `(${ownedCount})`}</SectionLabel>
          {signedOutPreview ? (
            <RailHint>
              Sign in to load the apps you own here, then open their overview,
              runs, access, secrets, renderer, and analytics from one place.
            </RailHint>
          ) : loading && !apps ? (
            <RailHint>Loading…</RailHint>
          ) : error && !apps ? (
            <RailHint>Couldn&rsquo;t load your apps yet.</RailHint>
          ) : apps && apps.length === 0 ? (
            <RailHint>
              No apps yet.{' '}
              <Link to="/studio/build" style={{ color: 'var(--accent)' }}>
                Publish your first
              </Link>
              .
            </RailHint>
          ) : (
            apps?.map((app) => {
              const isActive = app.slug === activeAppSlug;
              const isPrivate = app.visibility === 'private';
              return (
                <div key={app.slug}>
                  <Link
                    to={`/studio/${app.slug}`}
                    data-testid={`studio-sidebar-app-${app.slug}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '7px 10px',
                      borderRadius: 8,
                      background: isActive ? 'var(--accent-soft)' : 'transparent',
                      color: isActive ? 'var(--accent)' : 'var(--ink)',
                      textDecoration: 'none',
                      fontSize: 13,
                      fontWeight: isActive ? 600 : 500,
                    }}
                  >
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: 'var(--card)',
                        border: '1px solid var(--line)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <AppIcon slug={app.slug} size={14} />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {app.name}
                    </span>
                    {isPrivate && (
                      <span
                        title="Private app"
                        style={privatePillStyle}
                      >
                        Private
                      </span>
                    )}
                  </Link>
                  {isActive && <SubNav slug={app.slug} active={activeSubsection} />}
                </div>
              );
            })
          )}
        </section>

        {signedOutPreview && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SectionLabel>Inside each app</SectionLabel>
            <PreviewSection />
          </section>
        )}
      </div>

      <div
        style={{
          padding: '10px 12px 14px',
          borderTop: '1px solid var(--line)',
          background: '#F5F5F1',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <Link
          to={settingsHref}
          data-testid="studio-sidebar-settings"
          style={footerLink(!signedOutPreview && location.pathname === '/studio/settings')}
        >
          Settings
        </Link>
        <span style={{ ...footerLink(false), opacity: 0.45, cursor: 'not-allowed' }}>
          Billing <span style={{ fontSize: 10 }}>(soon)</span>
        </span>
        <Link
          to="/"
          data-testid="studio-sidebar-back-to-store"
          style={{ ...footerLink(false), marginTop: 6 }}
        >
          ← Back to Store
        </Link>
        {user && !signedOutPreview && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px 4px',
              marginTop: 4,
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 999,
                background: 'var(--accent)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                fontWeight: 700,
                flexShrink: 0,
                overflow: 'hidden',
              }}
            >
              {user.image ? (
                <img
                  src={user.image}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                initials(user.name || user.email || '?')
              )}
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.email || user.name || 'Local user'}
            </div>
          </div>
        )}
        {signedOutPreview && (
          <RailHint>
            Sign in before you publish, rotate secrets, or change app access.
          </RailHint>
        )}
      </div>
    </aside>
  );
}

function PreviewSection() {
  const items = [
    'Overview',
    'Runs',
    'Secrets',
    'Access',
    'Renderer',
    'Analytics',
  ];

  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '0 8px 2px',
      }}
    >
      {items.map((label) => (
        <div
          key={label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 10px',
            borderRadius: 8,
            color: 'var(--muted)',
            background: 'rgba(255,255,255,0.45)',
            border: '1px dashed var(--line)',
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--line)',
              flexShrink: 0,
            }}
          />
          <span>{label}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, textTransform: 'uppercase' }}>
            Sign in
          </span>
        </div>
      ))}
    </div>
  );
}

function SubNav({
  slug,
  active,
}: {
  slug: string;
  active: 'overview' | 'runs' | 'secrets' | 'access' | 'renderer' | 'analytics' | 'triggers';
}) {
  const items: Array<{
    id: 'overview' | 'runs' | 'secrets' | 'access' | 'renderer' | 'analytics' | 'triggers';
    label: string;
    to: string;
  }> = [
    { id: 'overview', label: 'Overview', to: `/studio/${slug}` },
    { id: 'runs', label: 'Runs', to: `/studio/${slug}/runs` },
    { id: 'triggers', label: 'Triggers', to: `/studio/${slug}/triggers` },
    { id: 'secrets', label: 'Secrets', to: `/studio/${slug}/secrets` },
    { id: 'access', label: 'Access', to: `/studio/${slug}/access` },
    { id: 'renderer', label: 'Renderer', to: `/studio/${slug}/renderer` },
    { id: 'analytics', label: 'Analytics', to: `/studio/${slug}/analytics` },
  ];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        marginLeft: 34,
        marginTop: 4,
        marginBottom: 6,
        borderLeft: '1px solid var(--line)',
        paddingLeft: 8,
      }}
    >
      {items.map((it) => {
        const isOn = it.id === active;
        return (
          <Link
            key={it.id}
            to={it.to}
            data-testid={`studio-subnav-${it.id}`}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: isOn ? 600 : 500,
              color: isOn ? 'var(--accent)' : 'var(--muted)',
              textDecoration: 'none',
              borderRadius: 6,
              background: isOn ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            {it.label}
          </Link>
        );
      })}
    </div>
  );
}

const primaryCtaStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '9px 12px',
  background: 'var(--ink)',
  border: '1px solid var(--ink)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  textDecoration: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const privatePillStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: '2px 6px',
  borderRadius: 4,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  color: 'var(--muted)',
  flexShrink: 0,
};

function footerLink(active: boolean): CSSProperties {
  return {
    display: 'block',
    padding: '6px 10px',
    fontSize: 12,
    color: active ? 'var(--accent)' : 'var(--muted)',
    textDecoration: 'none',
    borderRadius: 6,
    background: active ? 'var(--accent-soft)' : 'transparent',
  };
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--muted)',
        padding: '6px 10px 4px',
      }}
    >
      {children}
    </div>
  );
}

function RailHint({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: 'var(--muted)',
        padding: '6px 10px 10px',
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}
