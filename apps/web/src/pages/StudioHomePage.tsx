// /studio — Studio home. Single-focus surface: my apps + one CTA to build new.
//
// 2026-04-21 zero-bloat pass (#248): stripped hero stats row, per-app
// sparklines, ACTIVE/IDLE status pills, and the app-count eyebrow. The
// earlier version was analytics-heavy (4-stat hero + 7-day sparkline
// per card) which competed with the golden path "see my apps -> open
// one OR build new". Per-app analytics live on /studio/:slug; this
// page is the index, nothing more.
//
// Preserved: app cards (name, slug, description, total runs, last run),
// the "+ New app" CTA, the empty state, and the delete-confirm dialog.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { StudioLayout } from '../components/studio/StudioLayout';
import { StudioSignedOutState } from '../components/studio/StudioSignedOutState';
import * as api from '../api/client';
import { refreshMyApps, useMyApps } from '../hooks/useMyApps';
import { useSession } from '../hooks/useSession';
import { formatTime } from '../lib/time';
import type { AppVisibility, CreatorApp } from '../lib/types';
import { DescriptionMarkdown } from '../components/DescriptionMarkdown';

export function StudioHomePage() {
  const { apps, error: loadError } = useMyApps();
  const { data: session } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const signedOutPreview = !!session && session.cloud_mode && session.user.is_local;

  useEffect(() => {
    if (signedOutPreview) {
      setError(null);
      return;
    }
    if (loadError) setError(loadError.message);
  }, [loadError, signedOutPreview]);

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
    <StudioLayout
      title="Studio · Floom"
      allowSignedOutShell={signedOutPreview}
    >
      <div data-testid="studio-home">
        {signedOutPreview ? (
          <StudioSignedOutState />
        ) : (
          <>
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
          <h1
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontSize: 28,
              fontWeight: 400,
              letterSpacing: '-0.02em',
              lineHeight: 1.1,
              margin: 0,
              color: 'var(--ink)',
            }}
          >
            Your apps
          </h1>
          <Link
            to="/studio/build"
            data-testid="studio-new-app-cta"
            className="btn-ink"
            style={{ textDecoration: 'none' }}
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
              Paste your app's link. Floom gives you a Claude tool, a page to share, a CLI, and a URL your teammates can hit.
            </p>
            <Link to="/studio/build" className="btn-ink">
              Start publishing
            </Link>
          </div>
        )}

        {apps && apps.length > 0 && (
          <div
            data-testid="studio-apps-list"
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            }}
          >
            {apps.map((a) => (
              <AppCard
                key={a.slug}
                app={a}
                onDelete={() => setConfirmSlug(a.slug)}
              />
            ))}
          </div>
        )}
          </>
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

function AppCard({
  app,
  onDelete,
}: {
  app: CreatorApp;
  onDelete: () => void;
}) {
  return (
    <div
      data-testid={`studio-app-card-${app.slug}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--muted)';
        e.currentTarget.style.boxShadow = '0 4px 16px rgba(15, 23, 42, 0.04)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--line)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 3,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>
            {app.name}
          </div>
          {app.visibility && <VisibilityBadge value={app.visibility} />}
          {app.publish_status && app.publish_status !== 'published' && (
            <PublishStatusBadge value={app.publish_status} />
          )}
        </div>
        <div style={{ fontSize: 11.5, fontFamily: 'JetBrains Mono, monospace', color: 'var(--muted)' }}>
          /p/{app.slug}
        </div>
        {app.publish_status === 'pending_review' && (
          <div
            data-testid={`studio-app-card-pending-review-${app.slug}`}
            style={{
              marginTop: 6,
              fontSize: 12,
              color: '#92400e',
              lineHeight: 1.4,
            }}
          >
            Pending review — Federico will take a look before this appears on the public Store.
          </div>
        )}
      </div>
      {/* 2026-04-23: Fix #413 — app descriptions are markdown-enabled
          (per DescriptionMarkdown component). Previously rendered as
          plain text, so `## Heading\n` strings showed up literally in
          Studio cards. Clamp to 2 lines with line-clamp wrapper so the
          markdown render still respects card height. */}
      <div
        data-testid={`studio-app-card-desc-${app.slug}`}
        style={{
          fontSize: 13,
          color: 'var(--muted)',
          lineHeight: 1.5,
          margin: 0,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: 39,
        }}
      >
        {app.description ? (
          <DescriptionMarkdown
            description={app.description}
            testId={`studio-app-card-desc-md-${app.slug}`}
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              lineHeight: 1.5,
              margin: 0,
              maxWidth: 'none',
            }}
          />
        ) : (
          '(no description)'
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 10,
          fontSize: 12,
          color: 'var(--muted)',
          paddingTop: 8,
          borderTop: '1px solid var(--line)',
        }}
      >
        <span>
          <strong style={{ color: 'var(--ink)' }}>{app.run_count}</strong> total
        </span>
        <span aria-hidden="true">·</span>
        <span>{app.last_run_at ? `last ${formatTime(app.last_run_at)}` : 'never run'}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Link
          to={`/studio/${app.slug}`}
          style={primaryBtnStyle}
          data-testid={`studio-open-${app.slug}`}
        >
          Open
        </Link>
        <Link to={`/p/${app.slug}`} style={secondaryBtnStyle}>
          View
        </Link>
        <button
          type="button"
          onClick={onDelete}
          data-testid={`studio-delete-${app.slug}`}
          style={dangerBtnStyle}
          aria-label={`Delete ${app.name}`}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '7px 12px',
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
  boxShadow: '0 1px 2px rgba(22, 21, 18, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '7px 12px',
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
  padding: '7px 12px',
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

/**
 * Small text pill showing the app's visibility state. Colours mirror the
 * existing StudioAppPage VisibilityPill so the two surfaces read the
 * same. Only the three launch-scope states get a coloured treatment;
 * any other AppVisibility value (unlisted, invite-only) falls back to
 * a neutral pill.
 */
function VisibilityBadge({ value }: { value: AppVisibility }) {
  const tones: Record<string, { bg: string; fg: string; label: string }> = {
    public: { bg: '#e6f4ea', fg: '#1a7f37', label: 'Public' },
    'auth-required': { bg: '#e0e7ff', fg: '#3730a3', label: 'Signed-in only' },
    private: { bg: '#fef3c7', fg: '#b45309', label: 'Private' },
  };
  const tone = tones[value] || { bg: 'var(--bg)', fg: 'var(--muted)', label: value };
  return (
    <span
      data-testid={`studio-app-card-visibility-${value}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {tone.label}
    </span>
  );
}

/**
 * Small text pill showing the app's publish-review state (#362). Only
 * non-'published' states get a pill so the Studio card stays clean once
 * an admin has approved the app. 'pending_review' is the launch case;
 * 'rejected' / 'draft' are reserved for future flows.
 */
function PublishStatusBadge({
  value,
}: {
  value: NonNullable<CreatorApp['publish_status']>;
}) {
  const tones: Record<string, { bg: string; fg: string; label: string }> = {
    pending_review: { bg: '#fef3c7', fg: '#92400e', label: 'Pending review' },
    rejected: { bg: '#fee2e2', fg: '#991b1b', label: 'Rejected' },
    draft: { bg: 'var(--bg)', fg: 'var(--muted)', label: 'Draft' },
  };
  const tone = tones[value] || { bg: 'var(--bg)', fg: 'var(--muted)', label: value };
  return (
    <span
      data-testid={`studio-app-card-publish-status-${value}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        background: tone.bg,
        color: tone.fg,
      }}
    >
      {tone.label}
    </span>
  );
}
