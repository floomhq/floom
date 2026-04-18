// /studio — Studio home. Grid of owned apps + "+ New app" CTA.
// Derived from CreatorPage but ported into the Studio shell so the
// creator workspace has a single coherent context (sidebar +
// darker surface + breadcrumb TopBar). Delete + edit affordances
// preserved.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import * as api from '../api/client';
import { refreshMyApps, useMyApps } from '../hooks/useMyApps';
import { formatTime } from '../lib/time';

export function StudioHomePage() {
  const { apps, error: loadError } = useMyApps();
  const [error, setError] = useState<string | null>(null);
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (loadError) setError(loadError.message);
  }, [loadError]);

  async function handleDelete() {
    if (!confirmSlug) return;
    setDeleting(true);
    try {
      await api.deleteApp(confirmSlug);
      setConfirmSlug(null);
      setConfirmInput('');
      await refreshMyApps();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <StudioLayout title="Studio · Floom">
      <div data-testid="studio-home">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 24,
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)' }}>
              Your apps
            </h1>
            <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>
              Publish, manage, and monitor every app you own.
            </p>
          </div>
          <Link
            to="/studio/build"
            data-testid="studio-new-app-cta"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 16px',
              background: 'var(--ink)',
              color: '#fff',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            + New app
          </Link>
        </div>

        {error && (
          <div
            style={{
              background: '#fdecea',
              border: '1px solid #f4b7b1',
              color: '#c2321f',
              borderRadius: 10,
              padding: '14px 18px',
              marginBottom: 20,
            }}
          >
            {error}
          </div>
        )}

        {!apps && !error && (
          <div data-testid="studio-loading" style={{ color: 'var(--muted)', padding: 32 }}>
            Loading...
          </div>
        )}

        {apps && apps.length === 0 && (
          <div
            data-testid="studio-empty"
            style={{
              textAlign: 'center',
              padding: '64px 24px',
              background: 'var(--card)',
              border: '1px dashed var(--line)',
              borderRadius: 12,
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                background: 'var(--accent-soft, #d7f1e0)',
                color: 'var(--accent)',
                margin: '0 auto 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 28,
                fontWeight: 700,
              }}
              aria-hidden="true"
            >
              +
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink)', margin: '0 0 8px' }}>
              Ship your first app in 2 minutes
            </h3>
            <p
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                margin: '0 auto 20px',
                maxWidth: 380,
                lineHeight: 1.55,
              }}
            >
              Paste an OpenAPI URL. Floom generates the MCP server, HTTP API, store page, and docs.
            </p>
            <Link
              to="/studio/build"
              style={{
                display: 'inline-block',
                padding: '11px 20px',
                background: 'var(--ink)',
                color: '#fff',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Start publishing
            </Link>
          </div>
        )}

        {apps && apps.length > 0 && (
          <div
            data-testid="studio-apps-list"
            style={{
              display: 'grid',
              gap: 14,
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            }}
          >
            {apps.map((a) => (
              <div
                key={a.slug}
                data-testid={`studio-app-card-${a.slug}`}
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginBottom: 4 }}>
                    {a.name}
                  </div>
                  <div style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace', color: 'var(--muted)' }}>
                    /p/{a.slug}
                  </div>
                </div>
                <p
                  style={{
                    fontSize: 13,
                    color: 'var(--muted)',
                    lineHeight: 1.5,
                    margin: 0,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {a.description || '(no description)'}
                </p>
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    fontSize: 12,
                    color: 'var(--muted)',
                    marginTop: 'auto',
                    paddingTop: 8,
                    borderTop: '1px solid var(--line)',
                  }}
                >
                  <span>
                    <strong style={{ color: 'var(--ink)' }}>{a.run_count}</strong> runs
                  </span>
                  <span>·</span>
                  <span>{a.last_run_at ? `last ${formatTime(a.last_run_at)}` : 'never run'}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Link
                    to={`/studio/${a.slug}`}
                    style={primaryBtnStyle}
                    data-testid={`studio-open-${a.slug}`}
                  >
                    Open
                  </Link>
                  <Link
                    to={`/p/${a.slug}`}
                    style={secondaryBtnStyle}
                  >
                    View
                  </Link>
                  <button
                    type="button"
                    onClick={() => setConfirmSlug(a.slug)}
                    data-testid={`studio-delete-${a.slug}`}
                    style={dangerBtnStyle}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {confirmSlug && (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 1000,
              background: 'rgba(0,0,0,0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
            }}
            onClick={() => setConfirmSlug(null)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'var(--card)',
                borderRadius: 12,
                padding: 24,
                maxWidth: 440,
                width: '100%',
              }}
            >
              <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--ink)' }}>
                Delete {confirmSlug}?
              </h3>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
                This removes the app from the store. Run history remains.
                Type <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>{confirmSlug}</code> to confirm.
              </p>
              <input
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                autoFocus
                data-testid="studio-delete-confirm"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  background: 'var(--card)',
                  fontSize: 14,
                  fontFamily: 'JetBrains Mono, monospace',
                  color: 'var(--ink)',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmSlug(null);
                    setConfirmInput('');
                  }}
                  style={{
                    padding: '8px 16px',
                    background: 'transparent',
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    fontSize: 13,
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={confirmInput !== confirmSlug || deleting}
                  data-testid="studio-delete-submit"
                  style={{
                    padding: '8px 16px',
                    background: '#c2321f',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: confirmInput === confirmSlug && !deleting ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit',
                    opacity: confirmInput === confirmSlug && !deleting ? 1 : 0.6,
                  }}
                >
                  {deleting ? 'Deleting...' : 'Delete forever'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </StudioLayout>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'var(--ink)',
  color: '#fff',
  border: '1px solid var(--ink)',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
  textDecoration: 'none',
  flex: 1,
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--muted)',
  fontFamily: 'inherit',
  textDecoration: 'none',
  flex: 1,
  textAlign: 'center',
  whiteSpace: 'nowrap',
};

const dangerBtnStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'transparent',
  border: '1px solid #f4b7b1',
  borderRadius: 6,
  fontSize: 12,
  color: '#c2321f',
  fontFamily: 'inherit',
  cursor: 'pointer',
  flex: 1,
  textAlign: 'center',
  whiteSpace: 'nowrap',
};
