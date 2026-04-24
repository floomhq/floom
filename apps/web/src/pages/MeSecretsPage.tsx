// /me/secrets — Secrets tab of the Studio-tabbed dashboard.
//
// Global secrets (issue #548) are not yet shipped: secrets today live
// per-app at /studio/:slug/secrets. This page is the tab nav hook: it
// renders the tab highlight + an explainer + links into the per-app
// secrets surface for every app the user owns. Once #548 lands, this
// page becomes the real global-secrets UI and the per-app links stay
// as drill-downs.
//
// Federico 2026-04-24: "add the tab nav hook" — so this exists now to
// keep the tab strip complete (Overview · Apps · Runs · Secrets · Settings)
// without blocking on the #548 backend.

import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { MeLayout } from '../components/me/MeLayout';
import { AppIcon } from '../components/AppIcon';
import { useSession } from '../hooks/useSession';
import { useMyApps } from '../hooks/useMyApps';

const s: Record<string, CSSProperties> = {
  h2: {
    fontFamily: 'var(--font-display)',
    fontSize: 20,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 1.2,
    margin: '0 0 6px',
    color: 'var(--ink)',
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--muted)',
    margin: '0 0 24px',
    lineHeight: 1.55,
    maxWidth: 620,
  },
  callout: {
    border: '1px solid var(--line)',
    borderRadius: 12,
    background: 'var(--card)',
    padding: '18px 20px',
    marginBottom: 28,
  },
  calloutTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--ink)',
    margin: '0 0 6px',
  },
  calloutBody: {
    fontSize: 13,
    color: 'var(--muted)',
    lineHeight: 1.55,
    margin: 0,
  },
  list: {
    border: '1px solid var(--line)',
    borderRadius: 12,
    background: 'var(--card)',
    overflow: 'hidden',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 16px',
    textDecoration: 'none',
    color: 'var(--ink)',
  },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: 8,
    background: 'var(--bg)',
    border: '1px solid var(--line)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
};

export function MeSecretsPage() {
  const { data: session } = useSession();
  const { apps, loading } = useMyApps();
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;

  return (
    <MeLayout
      activeTab="secrets"
      title="Secrets · Me · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      <div data-testid="me-secrets-page">
        <h2 style={s.h2}>Secrets</h2>
        <p style={s.subtitle}>
          Secrets let Floom call APIs on your behalf (database URL, API
          keys, webhooks). For now, each app has its own secret store. A
          global one is on the way.
        </p>

        <div style={s.callout}>
          <div style={s.calloutTitle}>Global secrets are coming</div>
          <p style={s.calloutBody}>
            We&rsquo;re about to ship a single place to manage secrets shared
            across all your apps. Until then, open any app below to set its
            secrets.
          </p>
        </div>

        {signedOutPreview ? (
          <div
            style={{
              border: '1px dashed var(--line)',
              borderRadius: 12,
              background: 'var(--card)',
              padding: '28px 22px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 14,
            }}
          >
            Sign in to see your apps.
          </div>
        ) : loading ? (
          <div style={{ ...s.list, padding: 16, color: 'var(--muted)', fontSize: 13 }}>
            Loading your apps…
          </div>
        ) : !apps || apps.length === 0 ? (
          <div
            data-testid="me-secrets-no-apps"
            style={{
              border: '1px dashed var(--line)',
              borderRadius: 12,
              background: 'var(--card)',
              padding: '28px 22px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
              You don&rsquo;t have any apps yet. Publish one to start managing secrets.
            </div>
            <Link
              to="/studio/build"
              style={{
                display: 'inline-block',
                padding: '10px 18px',
                background: 'var(--accent, #10b981)',
                color: '#fff',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Publish your first app →
            </Link>
          </div>
        ) : (
          <div data-testid="me-secrets-app-list" style={s.list}>
            {apps.map((app, i) => (
              <Link
                key={app.slug}
                to={`/studio/${app.slug}/secrets`}
                data-testid={`me-secrets-app-${app.slug}`}
                style={{
                  ...s.row,
                  borderBottom: i === apps.length - 1 ? 'none' : '1px solid var(--line)',
                }}
              >
                <span aria-hidden style={s.iconWrap}>
                  <AppIcon slug={app.slug} size={16} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: 'var(--ink)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {app.name || app.slug}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    /studio/{app.slug}/secrets
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--muted)',
                    flexShrink: 0,
                  }}
                >
                  Manage →
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </MeLayout>
  );
}
