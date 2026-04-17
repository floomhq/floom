// v15.2 /me/a/:slug/secrets — write-only secrets vault for one app.
//
// Rows come from the intersection of `app.manifest.secrets_needed`
// (what this app asks for) and `useSecrets().entries` (what the caller
// has saved). Values are never revealed — the server only returns
// { key, updated_at } pairs. Save/delete mutate through the shared
// useSecrets cache so the /me/a/:slug/run page sees updates instantly.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { MeRail } from '../components/me/MeRail';
import { AppHeader, TabBar } from './MeAppPage';
import { useSecrets } from '../hooks/useSecrets';
import * as api from '../api/client';
import type { AppDetail, UserSecretEntry } from '../lib/types';

export function MeAppSecretsPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const secrets = useSecrets();

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

  const neededKeys = app?.manifest?.secrets_needed ?? [];

  return (
    <PageShell
      requireAuth="cloud"
      title={app ? `${app.name} · Secrets · Floom` : 'Secrets · Floom'}
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
                to={`/me/a/${app.slug}`}
                style={{ color: 'var(--muted)', textDecoration: 'none' }}
              >
                {app.name}
              </Link>
            ) : (
              <span>{slug}</span>
            )}
            <span style={{ margin: '0 6px' }}>›</span>
            <span style={{ color: 'var(--ink)' }}>Secrets</span>
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
              <TabBar slug={app.slug} active="secrets" />

              <h2
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: 'var(--ink)',
                  margin: '0 0 4px',
                }}
              >
                Secrets for {app.name}
              </h2>
              <p
                style={{
                  fontSize: 13,
                  color: 'var(--muted)',
                  margin: '0 0 20px',
                  lineHeight: 1.55,
                }}
              >
                The app receives these values as environment variables at run
                time. Values are write-only — once saved, we can’t show them
                back to you.
              </p>

              {neededKeys.length === 0 ? (
                <div
                  data-testid="me-app-secrets-empty"
                  style={{
                    border: '1px dashed var(--line)',
                    borderRadius: 10,
                    padding: '24px 20px',
                    background: 'var(--card)',
                    fontSize: 13,
                    color: 'var(--muted)',
                  }}
                >
                  This app doesn’t declare any secrets. Nothing to configure
                  here.
                </div>
              ) : (
                <div
                  data-testid="me-app-secrets-list"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  {neededKeys.map((key) => (
                    <SecretRow
                      key={key}
                      secretKey={key}
                      entry={
                        secrets.entries?.find((e) => e.key === key) ?? null
                      }
                      onSave={(v) => secrets.save(key, v)}
                      onRemove={() => secrets.remove(key)}
                    />
                  ))}
                </div>
              )}

              <p
                style={{
                  fontSize: 11,
                  color: 'var(--muted)',
                  marginTop: 24,
                  lineHeight: 1.5,
                  maxWidth: 620,
                }}
              >
                Secrets are AES-256 encrypted at rest and scoped to your
                account. They’re injected at run time and never logged.
              </p>
            </>
          )}
        </main>
      </div>
    </PageShell>
  );
}

interface SecretRowProps {
  secretKey: string;
  entry: UserSecretEntry | null;
  onSave: (value: string) => Promise<void>;
  onRemove: () => Promise<void>;
}

function SecretRow({ secretKey, entry, onSave, onRemove }: SecretRowProps) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'removing'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const isSet = !!entry;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setStatus('saving');
    setErr(null);
    try {
      await onSave(value);
      setValue('');
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed to save');
    } finally {
      setStatus('idle');
    }
  }

  async function handleRemove() {
    if (!window.confirm(`Remove ${secretKey}?`)) return;
    setStatus('removing');
    setErr(null);
    try {
      await onRemove();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Failed to remove');
    } finally {
      setStatus('idle');
    }
  }

  return (
    <div
      data-testid={`secret-row-${secretKey}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '14px 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 10,
          flexWrap: 'wrap',
        }}
      >
        <code
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink)',
          }}
        >
          {secretKey}
        </code>
        {isSet ? (
          <span
            data-testid={`secret-status-set-${secretKey}`}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--accent)',
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent-border)',
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            •••• set
          </span>
        ) : (
          <span
            data-testid={`secret-status-unset-${secretKey}`}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--muted)',
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              padding: '2px 8px',
              borderRadius: 999,
            }}
          >
            — not set
          </span>
        )}
        {entry?.updated_at && (
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            updated {formatTimestamp(entry.updated_at)}
          </span>
        )}
      </div>

      <form onSubmit={handleSave} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          data-testid={`secret-input-${secretKey}`}
          type="password"
          autoComplete="off"
          placeholder={isSet ? 'Paste to replace…' : 'Paste value…'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{
            flex: 1,
            minWidth: 220,
            padding: '8px 12px',
            border: '1px solid var(--line)',
            borderRadius: 8,
            fontSize: 13,
            fontFamily: 'JetBrains Mono, monospace',
            background: 'var(--bg)',
            color: 'var(--ink)',
          }}
        />
        <button
          type="submit"
          data-testid={`secret-save-${secretKey}`}
          disabled={status !== 'idle' || !value.trim()}
          style={{
            padding: '8px 16px',
            background: 'var(--ink)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: status === 'idle' && value.trim() ? 'pointer' : 'default',
            opacity: status !== 'idle' || !value.trim() ? 0.6 : 1,
            fontFamily: 'inherit',
          }}
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {isSet && (
          <button
            type="button"
            data-testid={`secret-remove-${secretKey}`}
            onClick={handleRemove}
            disabled={status !== 'idle'}
            style={{
              padding: '8px 14px',
              background: 'var(--card)',
              color: '#c2321f',
              border: '1px solid #f4b7b1',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: status === 'idle' ? 'pointer' : 'default',
              opacity: status !== 'idle' ? 0.6 : 1,
              fontFamily: 'inherit',
            }}
          >
            {status === 'removing' ? 'Removing…' : 'Delete'}
          </button>
        )}
      </form>

      {err && (
        <div
          data-testid={`secret-error-${secretKey}`}
          style={{ fontSize: 12, color: '#c2321f', marginTop: 6 }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
