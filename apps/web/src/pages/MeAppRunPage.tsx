// v15.2 /me/apps/:slug/run — single-run surface for an owned app.
//
// Flow: fetch app + cached secrets → compute missing required keys →
// if any are missing, show SecretsRequiredCard; else mount FloomApp
// inline. Whatever FloomApp does (sync run stream vs async job poll)
// happens based on app.is_async, so the MVP doesn't need to know the
// runtime details here.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { MeRail } from '../components/me/MeRail';
import { AppHeader, TabBar } from './MeAppPage';
import { SecretsRequiredCard } from '../components/me/SecretsRequiredCard';
import { FloomApp } from '../components/FloomApp';
import { useSecrets } from '../hooks/useSecrets';
import * as api from '../api/client';
import type { AppDetail } from '../lib/types';

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
  // a "prompt" input — other inputs are scoped to FloomApp's defaults.
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
    const declared = app.manifest?.secrets_needed ?? [];
    const required = REQUIRED_SECRETS_OVERRIDE[app.slug] ?? declared;
    const keysSet = new Set(secrets.entries.map((s) => s.key));
    return required.filter((k) => !keysSet.has(k));
  }, [app, secrets.entries]);

  return (
    <PageShell
      requireAuth="cloud"
      title={app ? `${app.name} · Run · Floom` : 'Run · Floom'}
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
          <nav
            aria-label="Breadcrumb"
            style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}
          >
            <Link to="/me" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              /me
            </Link>
            <span style={{ margin: '0 6px' }}>›</span>
            {app ? (
              <Link
                to={`/me/apps/${app.slug}`}
                style={{ color: 'var(--muted)', textDecoration: 'none' }}
              >
                {app.name}
              </Link>
            ) : (
              <span>{slug}</span>
            )}
            <span style={{ margin: '0 6px' }}>›</span>
            <span style={{ color: 'var(--ink)' }}>Run</span>
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
              <TabBar slug={app.slug} active="overview" />

              {missingKeys === null && (
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
                <FloomApp
                  app={app}
                  standalone
                  showSidebar={false}
                  initialInputs={initialInputs}
                />
              )}
            </>
          )}
        </main>
      </div>
    </PageShell>
  );
}
