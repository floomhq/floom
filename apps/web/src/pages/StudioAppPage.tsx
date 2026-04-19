// /studio/:slug — Studio per-app Overview. Creator workspace view of
// an owned app. Shows app header, ownership actions (New run link to
// /p/:slug, View in Store, Delete), and recent runs (scoped to owner).
//
// Access-gated: non-owners are redirected to /p/:slug (the public page).

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { AppHeader } from './MeAppPage';
import * as api from '../api/client';
import { refreshMyApps } from '../hooks/useMyApps';
import type { AppDetail, CreatorRun } from '../lib/types';
import { formatTime } from '../lib/time';

export function StudioAppPage() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [runs, setRuns] = useState<CreatorRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Issue #129: visibility toggle. Keep local state for optimistic update so
  // the pill flips before the round-trip lands. Failure reverts it.
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);

  async function handleDelete() {
    if (!app) return;
    if (confirmInput !== app.slug) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteApp(app.slug);
      await refreshMyApps();
      nav('/studio', { replace: true });
    } catch (err) {
      setDeleteError((err as Error).message || 'Delete failed');
      setDeleting(false);
    }
  }

  async function handleVisibilityChange(next: 'public' | 'private') {
    if (!app || visibilityBusy || app.visibility === next) return;
    const previous = app.visibility;
    setVisibilityBusy(true);
    setVisibilityError(null);
    // Optimistic flip — revert on error.
    setApp({ ...app, visibility: next });
    try {
      await api.updateAppVisibility(app.slug, next);
      await refreshMyApps();
    } catch (err) {
      setApp({ ...app, visibility: previous });
      setVisibilityError((err as Error).message || 'Could not update visibility');
    } finally {
      setVisibilityBusy(false);
    }
  }

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setApp(null);
    setRuns(null);
    setError(null);
    api
      .getApp(slug)
      .then((res) => {
        if (cancelled) return;
        setApp(res);
      })
      .catch((err) => {
        if (cancelled) return;
        const status = (err as { status?: number }).status;
        if (status === 404) {
          const q = new URLSearchParams({ notice: 'app_not_found' });
          if (slug) q.set('slug', slug);
          nav(`/studio?${q.toString()}`, { replace: true });
          return;
        }
        if (status === 403) {
          // Not owner → bounce to public permalink.
          nav(`/p/${slug}`, { replace: true });
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
    <StudioLayout
      title={app ? `${app.name} · Studio` : 'App · Studio'}
      activeAppSlug={slug}
      activeSubsection="overview"
    >
      {error && (
        <div
          data-testid="studio-app-error"
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
        <div data-testid="studio-app-overview">
          <AppHeader app={app} />

          <div
            style={{
              display: 'flex',
              gap: 10,
              marginBottom: 28,
              flexWrap: 'wrap',
            }}
          >
            <Link
              to={`/p/${app.slug}`}
              data-testid="studio-app-open-store"
              style={primaryCta}
            >
              Open in Store →
            </Link>
            <Link
              to={`/studio/${app.slug}/secrets`}
              style={secondaryCta}
            >
              Manage secrets
            </Link>
            <Link
              to={`/studio/${app.slug}/runs`}
              style={secondaryCta}
            >
              View runs
            </Link>
          </div>

          {/* Issue #129 (2026-04-19): visibility toggle. Lives above Recent
              runs so creators see the pill alongside their app health, and
              can flip between Public (listed in Store) and Private (owner-
              only) without re-ingesting. `auth-required` is kept available
              through the server API for advanced users but not exposed
              here — the 95% case is the public/private binary. */}
          <h2 style={sectionHeader}>Visibility</h2>
          <section
            data-testid="studio-app-visibility"
            style={{
              marginBottom: 32,
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'var(--card)',
              padding: 20,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 12,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>Who can run this app?</span>
              <VisibilityPill
                value={
                  app.visibility === 'private' ? 'private' : app.visibility === 'auth-required' ? 'auth-required' : 'public'
                }
              />
            </div>
            <StudioVisibilityChooser
              value={app.visibility === 'private' ? 'private' : 'public'}
              onChange={handleVisibilityChange}
              busy={visibilityBusy}
              authRequired={app.visibility === 'auth-required'}
            />
            {visibilityError && (
              <p
                data-testid="studio-app-visibility-error"
                style={{ margin: '12px 0 0', fontSize: 12, color: '#c2321f' }}
              >
                {visibilityError}
              </p>
            )}
          </section>

          <h2 style={sectionHeader}>Recent runs</h2>
          {!runs && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
          {runs && runs.length === 0 && (
            <div
              data-testid="studio-app-runs-empty"
              style={emptyState}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                No runs yet
              </div>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                Share <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>/p/{app.slug}</code> to drive your first run.
              </p>
            </div>
          )}
          {runs && runs.length > 0 && (
            <RunTable runs={runs.slice(0, 5)} />
          )}
          {runs && runs.length > 5 && (
            <div style={{ marginTop: 12 }}>
              <Link to={`/studio/${app.slug}/runs`} style={{ color: 'var(--accent)', fontSize: 13 }}>
                View all runs →
              </Link>
            </div>
          )}

          {/* Danger zone · delete app. Typed-slug confirm prevents fat-finger
              deletes. DELETE /api/hub/:slug cascades runs via FK. */}
          <section
            data-testid="studio-app-danger-zone"
            style={{
              marginTop: 48,
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'var(--card)',
              padding: 20,
            }}
          >
            <h2
              style={{
                fontSize: 12,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--muted)',
                margin: '0 0 12px',
              }}
            >
              Danger zone
            </h2>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                  Delete this app
                </div>
                <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
                  Removes <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>/p/{app.slug}</code> from the store and drops all run history. Cannot be undone.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(true);
                  setConfirmInput('');
                  setDeleteError(null);
                }}
                data-testid="studio-app-delete-trigger"
                style={{
                  padding: '9px 16px',
                  background: 'transparent',
                  color: '#c2321f',
                  border: '1px solid #c2321f',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Delete this app
              </button>
            </div>
          </section>
        </div>
      )}

      {confirmOpen && app && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="studio-app-delete-modal"
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
          onClick={() => !deleting && setConfirmOpen(false)}
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
              Delete {app.slug}?
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
              This removes the app from the store and drops run history. Cannot be undone.
              Type <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>{app.slug}</code> to confirm.
            </p>
            <input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              autoFocus
              data-testid="studio-app-delete-confirm-input"
              aria-label="Type app slug to confirm"
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
            {deleteError && (
              <div
                data-testid="studio-app-delete-error"
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  color: '#c2321f',
                }}
              >
                {deleteError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  setConfirmInput('');
                }}
                disabled={deleting}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 13,
                  color: 'var(--muted)',
                  cursor: deleting ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={confirmInput !== app.slug || deleting}
                data-testid="studio-app-delete-submit"
                style={{
                  padding: '8px 16px',
                  background: '#c2321f',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: confirmInput === app.slug && !deleting ? 'pointer' : 'not-allowed',
                  fontFamily: 'inherit',
                  opacity: confirmInput === app.slug && !deleting ? 1 : 0.6,
                }}
              >
                {deleting ? 'Deleting...' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </StudioLayout>
  );
}

function RunTable({ runs }: { runs: CreatorRun[] }) {
  return (
    <div
      data-testid="studio-app-runs"
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
  );
}

function VisibilityPill({
  value,
}: {
  value: 'public' | 'private' | 'auth-required';
}) {
  const tones = {
    public: { bg: '#e6f4ea', fg: '#1a7f37', label: 'Public' },
    private: { bg: '#fef3c7', fg: '#b45309', label: 'Private' },
    'auth-required': { bg: '#e0e7ff', fg: '#3730a3', label: 'Auth required' },
  }[value];
  return (
    <span
      data-testid={`studio-app-visibility-pill-${value}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        background: tones.bg,
        color: tones.fg,
      }}
    >
      {tones.label}
    </span>
  );
}

function StudioVisibilityChooser({
  value,
  onChange,
  busy,
  authRequired,
}: {
  value: 'public' | 'private';
  onChange: (next: 'public' | 'private') => void;
  busy: boolean;
  authRequired: boolean;
}) {
  const options: Array<{ id: 'public' | 'private'; label: string; explainer: string }> = [
    {
      id: 'public',
      label: 'Public',
      explainer: 'Appears in the Store. Anyone can run this app.',
    },
    {
      id: 'private',
      label: 'Private',
      explainer: 'Hidden from the Store. Only your signed-in sessions can run it.',
    },
  ];
  return (
    <div>
      <div
        role="radiogroup"
        aria-label="App visibility"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 10,
        }}
      >
        {options.map((opt) => {
          const selected = value === opt.id;
          return (
            <label
              key={opt.id}
              data-testid={`studio-app-visibility-${opt.id}`}
              data-selected={selected ? 'true' : 'false'}
              style={{
                border: selected ? '1.5px solid var(--accent)' : '1px solid var(--line)',
                background: selected ? 'var(--accent-soft, #e6f4ea)' : 'var(--card)',
                borderRadius: 10,
                padding: '12px 14px',
                cursor: busy ? 'wait' : 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                opacity: busy ? 0.6 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="radio"
                  name="studio-app-visibility"
                  value={opt.id}
                  checked={selected}
                  disabled={busy}
                  onChange={() => onChange(opt.id)}
                  data-testid={`studio-app-visibility-${opt.id}-input`}
                  style={{ accentColor: 'var(--accent)', margin: 0 }}
                />
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: selected ? 'var(--accent)' : 'var(--ink)',
                  }}
                >
                  {opt.label}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {opt.explainer}
              </p>
            </label>
          );
        })}
      </div>
      {authRequired && (
        <p
          style={{
            margin: '12px 0 0',
            fontSize: 12,
            color: 'var(--muted)',
            lineHeight: 1.5,
          }}
        >
          This app is currently set to <strong>Auth required</strong> (shared bearer token). Picking
          Public or Private above will replace that mode.
        </p>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div data-testid="studio-app-loading" style={{ opacity: 0.6 }}>
      <div style={{ height: 44, background: 'var(--bg)', borderRadius: 8, marginBottom: 16 }} />
      <div style={{ height: 200, background: 'var(--bg)', borderRadius: 10 }} />
    </div>
  );
}

const primaryCta: React.CSSProperties = {
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
};

const secondaryCta: React.CSSProperties = {
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
};

const sectionHeader: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--muted)',
  margin: '0 0 10px',
};

const emptyState: React.CSSProperties = {
  border: '1px dashed var(--line)',
  borderRadius: 10,
  padding: '24px 20px',
  background: 'var(--card)',
};
