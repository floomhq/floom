// v15.2 /me/apps/:slug/run — single-run surface for an owned app.
//
// Flow: fetch app + cached secrets → compute missing required keys →
// if any are missing, show SecretsRequiredCard; else mount RunSurface
// inline. Whatever the underlying runner does (sync run stream vs
// async job poll) happens based on app.is_async, so the MVP doesn't
// need to know the runtime details here.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { AppHeader } from './MeAppPage';
import { SecretsRequiredCard } from '../components/me/SecretsRequiredCard';
import { RunSurface } from '../components/runner/RunSurface';
import { useSecrets } from '../hooks/useSecrets';
import * as api from '../api/client';
import type { AppDetail } from '../lib/types';
import { collectRequiredSecretKeys } from '../lib/manifest-secrets';

// Apps whose manifest.secrets_needed lists optional cookies alongside
// required ones get a manual required-set override. For ig-nano-scout
// only the cookies that the scraper actually uses for auth are
// treated as required; the rest ("mid", "ig_did", "rur", "datr")
// improve bot-detection but aren't hard blockers.
const REQUIRED_SECRETS_OVERRIDE: Record<string, string[]> = {
  'ig-nano-scout': [
    'IG_SESSIONID',
    'IG_CSRFTOKEN',
    'IG_DS_USER_ID',
    'EVOMI_PROXY_URL',
  ],
};

export function MeAppRunPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const secrets = useSecrets();

  // v15.1 deep-link: /me composer navigates here with ?prompt=<text> so
  // the composer text shows up in the app's default form. Only prefill
  // a "prompt" input — other inputs are scoped to RunSurface's defaults.
  const prefillPrompt = searchParams.get('prompt');
  const initialInputs = useMemo<Record<string, unknown> | undefined>(
    () => (prefillPrompt ? { prompt: prefillPrompt } : undefined),
    [prefillPrompt],
  );

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    api
      .getApp(slug)
      .then((res) => {
        if (!cancelled) setApp(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 404) {
          nav('/me', { replace: true });
          return;
        }
        setError((err as Error).message || 'Failed to load app');
      });
    return () => {
      cancelled = true;
    };
  }, [slug, nav]);

  const missingKeys = useMemo(() => {
    if (!app || !secrets.entries) return null;
    // Union of manifest-level and per-action `secrets_needed`. Pre-fix
    // the runner's `auth_error` copy told owners to "add a secret in
    // app creator secrets" but the preflight only looked at the manifest-level
    // list, so an OpenAPI app with per-operation security slipped past
    // this gate and hit 401 inside RunSurface instead. See
    // `lib/manifest-secrets.ts` and audit R12-2 / C1.
    const declared = collectRequiredSecretKeys(app.manifest);
    const required = REQUIRED_SECRETS_OVERRIDE[app.slug] ?? declared;
    const keysSet = new Set(secrets.entries.map((s) => s.key));
    return required.filter((k) => !keysSet.has(k));
  }, [app, secrets.entries]);

  return (
    <WorkspacePageShell
      mode="run"
      title={app ? `${app.name} · Run · Floom` : 'Run · Floom'}
    >
          <nav
            aria-label="Breadcrumb"
            style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}
          >
            <Link to="/run" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              Run
            </Link>
            <span style={{ margin: '0 6px' }}>›</span>
            {app ? (
              <Link
                to={`/run/apps`}
                style={{ color: 'var(--muted)', textDecoration: 'none' }}
              >
                Apps
              </Link>
            ) : (
              <span>{slug}</span>
            )}
            <span style={{ margin: '0 6px' }}>›</span>
            <span style={{ color: 'var(--ink)' }}>{app?.name || slug}</span>
          </nav>

          {error && (
            <div
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

          {app && (
            <>
              <AppHeader app={app} />
              <RunAppTabs slug={app.slug} active="run" />
              <div style={crossLinkStyle}>
                Runs use workspace BYOK keys. <Link to="/settings/byok-keys" style={inlineLinkStyle}>Manage BYOK keys</Link>
              </div>

              {missingKeys === null && secrets.error && !secrets.entries && (
                <SecretsFetchError
                  error={secrets.error}
                  onRetry={() => {
                    void secrets.refresh();
                  }}
                />
              )}

              {missingKeys === null && !(secrets.error && !secrets.entries) && (
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
              )}

              {missingKeys && missingKeys.length > 0 && (
                <SecretsRequiredCard
                  app={app}
                  missingKeys={missingKeys}
                  onSaved={() => {
                    void secrets.refresh();
                  }}
                />
              )}

              {missingKeys && missingKeys.length === 0 && (
                <RunSurface app={app} initialInputs={initialInputs} />
              )}
            </>
          )}
    </WorkspacePageShell>
  );
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

// Inline error surface for the secrets fetch. Kept local to this page
// (R12-3) instead of introducing a new shared component — if a second
// page needs this treatment we can promote it later.
function SecretsFetchError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  const raw = (error.message || String(error)).trim();
  const detail = raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
  return (
    <div
      data-testid="secrets-fetch-error"
      role="alert"
      style={{
        background: '#fdecea',
        border: '1px solid #f4b7b1',
        color: '#c2321f',
        padding: '12px 14px',
        borderRadius: 8,
        fontSize: 13,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>Couldn’t load your saved secrets.</span>
        <button
          type="button"
          data-testid="secrets-fetch-retry"
          onClick={onRetry}
          style={{
            marginLeft: 'auto',
            padding: '6px 14px',
            background: '#c2321f',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Retry
        </button>
      </div>
      {detail && (
        <div style={{ fontSize: 12, color: 'var(--muted)', wordBreak: 'break-word' }}>
          {detail}
        </div>
      )}
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

const crossLinkStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 10,
  background: 'var(--card)',
  padding: '12px 14px',
  marginBottom: 18,
  fontSize: 13,
  color: 'var(--muted)',
};

const inlineLinkStyle: React.CSSProperties = {
  color: 'var(--accent)',
  fontWeight: 700,
  textDecoration: 'none',
};
