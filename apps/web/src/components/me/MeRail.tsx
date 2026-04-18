// v15.2 shared left rail used across /me/a/:slug, /me/a/:slug/secrets,
// /me/a/:slug/run.
//
// Visual direction comes from /tmp/v15-local/me-app.html: brand → two
// primary CTAs ("New app", "New thread") → "Your apps" list with a
// private pill on owned private apps → footer with avatar + email. We
// use the in-repo design tokens (wireframe.css custom props) instead of
// the Tailwind CDN classes from the wireframe so the rail visually
// matches every other page in the app.

import { Link } from 'react-router-dom';
import { Logo } from '../Logo';
import { AppIcon } from '../AppIcon';
import { useMyApps } from '../../hooks/useMyApps';
import { useSession } from '../../hooks/useSession';

interface Props {
  activeAppSlug?: string;
}

export function MeRail({ activeAppSlug }: Props) {
  const { apps, loading } = useMyApps();
  const { data: session } = useSession();
  const user = session?.user;

  return (
    <aside
      data-testid="me-rail"
      // On narrow viewports (<720px) the 260px sidebar starves the main
      // column of horizontal space — on /me/a/:slug this collapses the
      // description into a vertical one-char-per-line column. Hiding the
      // rail below this breakpoint restores mobile readability. Nav still
      // works via the TopBar + hamburger menu.
      className="me-rail-aside"
      style={{
        width: 260,
        flexShrink: 0,
        borderRight: '1px solid var(--line)',
        background: 'var(--card)',
        padding: '20px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        position: 'sticky',
        top: 56,
        alignSelf: 'flex-start',
        maxHeight: 'calc(100vh - 56px)',
        overflowY: 'auto',
      }}
    >
      {/* Brand */}
      <Link
        to="/"
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
        <span>floom</span>
      </Link>

      {/* Primary CTAs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Link
          to="/build"
          data-testid="me-rail-new-app"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '9px 12px',
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink)',
            textDecoration: 'none',
          }}
        >
          + New app
        </Link>
        <Link
          to="/me"
          data-testid="me-rail-new-thread"
          style={{
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
          }}
        >
          + New thread
        </Link>
      </div>

      {/* Your apps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--muted)',
            padding: '0 10px 4px',
          }}
        >
          Your apps
        </div>
        {loading && !apps && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              padding: '8px 10px',
            }}
          >
            Loading…
          </div>
        )}
        {apps && apps.length === 0 && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--muted)',
              padding: '8px 10px',
              lineHeight: 1.5,
            }}
          >
            No apps yet. Click “New app” above to publish one.
          </div>
        )}
        {apps?.map((app) => {
          const isActive = app.slug === activeAppSlug;
          const isPrivate = app.visibility === 'private';
          return (
            <Link
              key={app.slug}
              to={`/me/a/${app.slug}`}
              data-testid={`me-rail-app-${app.slug}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
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
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--ink)',
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
                  title="Private app — visible only to you"
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    color: 'var(--muted)',
                    flexShrink: 0,
                  }}
                >
                  Private
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Footer — user */}
      <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        {user ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '4px 6px',
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 999,
                background: 'var(--accent)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
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
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.name || user.email || 'Local user'}
              </div>
              {user.email && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user.email}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 6px' }}>
            Not signed in
          </div>
        )}
      </div>
    </aside>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}
