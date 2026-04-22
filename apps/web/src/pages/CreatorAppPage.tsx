// W4-minimal: /creator/:slug — activity feed for one published app.
//
// Shows the 20 most recent runs across every caller who has run this app,
// with a click-through that expands each row to show input + output JSON.
// Each row anonymizes the caller (caller_hash) but marks "you" when the
// current session ran it.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import { CustomRendererPanel } from '../components/CustomRendererPanel';
import * as api from '../api/client';
import type { CreatorRun, RendererMeta } from '../lib/types';
import { formatTime } from '../lib/time';

export function CreatorAppPage() {
  const { slug } = useParams<{ slug: string }>();
  const [runs, setRuns] = useState<CreatorRun[] | null>(null);
  const [appInfo, setAppInfo] = useState<{
    name: string;
    description: string;
    icon: string | null;
  } | null>(null);
  const [renderer, setRenderer] = useState<RendererMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notOwner, setNotOwner] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    // Audit 2026-04-18, bug #5: only the app's author may see the editor
    // chrome on /creator/:slug. A non-owner hitting this route used to see
    // "Not the owner" in red AND the CustomRendererPanel + manage buttons
    // directly below, because the panel and the header rendered on
    // different fetch gates. We now use the /api/hub/:slug/runs 403 as the
    // canonical "you are not the owner" signal and suppress every editor
    // affordance in that branch.
    api
      .getAppRuns(slug, 20)
      .then((res) => {
        setRuns(res.runs);
        setAppInfo(res.app);
      })
      .catch((err) => {
        const msg = (err as Error).message || '';
        if (/not_owner|not the owner|403/i.test(msg)) {
          setNotOwner(true);
          // Re-read the public app record so we can render a read-only
          // "this is not yours" view with the app's public metadata.
          api
            .getApp(slug)
            .then((detail) =>
              setAppInfo({
                name: detail.name,
                description: detail.description,
                icon: detail.icon ?? null,
              }),
            )
            .catch(() => {
              /* app might also be private; fall through with generic copy */
            });
        } else {
          setError(msg);
        }
      });
    api
      .getApp(slug)
      .then((detail) => setRenderer(detail.renderer ?? null))
      .catch(() => {
        /* non-fatal: panel falls back to "no renderer" default */
      });
  }, [slug]);

  return (
    <PageShell requireAuth="cloud" title={`${slug} activity | Floom`} noIndex>
      <div data-testid="creator-app-page" style={{ maxWidth: 960 }}>
        <Link
          to="/creator"
          style={{
            fontSize: 13,
            color: 'var(--muted)',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            marginBottom: 16,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M8 2L4 6l4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Creator dashboard
        </Link>

        {error && (
          <div
            style={{
              background: '#fdecea',
              border: '1px solid #f4b7b1',
              color: '#c2321f',
              borderRadius: 10,
              padding: '14px 18px',
            }}
          >
            {error}
          </div>
        )}

        {notOwner && (
          <div
            data-testid="creator-not-owner"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: 24,
              marginBottom: 20,
            }}
          >
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
              {appInfo?.name || slug}
            </h1>
            {appInfo?.description && (
              <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 16px', maxWidth: 560 }}>
                {appInfo.description}
              </p>
            )}
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px' }}>
              You are not the owner of this app, so the editor, secrets, and
              activity feed are hidden. Open the public app page to run it.
            </p>
            <Link
              to={`/p/${slug}`}
              data-testid="creator-not-owner-view"
              style={{
                display: 'inline-block',
                padding: '10px 16px',
                background: 'var(--ink)',
                color: '#fff',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Open app
            </Link>
          </div>
        )}

        {!notOwner && appInfo && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
              marginBottom: 28,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <h1 style={{ fontSize: 26, fontWeight: 700, margin: '0 0 6px', color: 'var(--ink)' }}>
                {appInfo.name}
              </h1>
              <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0, maxWidth: 540 }}>
                {appInfo.description}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link to={`/build?edit=${slug}`} style={secondaryBtn}>
                Edit
              </Link>
              {/* Bridge creator dashboard -> per-app management surface.
                  Before this fix, the v15 /me/apps/:slug shape (Overview /
                  Secrets / Access / Settings tabs) was orphaned: a
                  creator could publish an app and never discover the
                  secrets policy, runs, or renderer controls hiding under
                  /me/apps/:slug. */}
              <Link to={`/me/apps/${slug}`} style={secondaryBtn} data-testid="creator-app-manage">
                Manage
              </Link>
              <Link to={`/me/apps/${slug}/secrets`} style={secondaryBtn} data-testid="creator-app-secrets">
                Secrets
              </Link>
              <Link to={`/p/${slug}`} style={secondaryBtn}>
                View store
              </Link>
            </div>
          </div>
        )}

        {!notOwner && slug && (
          <div
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: 20,
              marginBottom: 28,
            }}
          >
            <CustomRendererPanel slug={slug} initial={renderer} onChange={setRenderer} />
          </div>
        )}

        {!notOwner && runs && runs.length === 0 && (
          <div
            data-testid="creator-activity-empty"
            style={{
              textAlign: 'center',
              padding: '64px 24px',
              background: 'var(--card)',
              border: '1px dashed var(--line)',
              borderRadius: 12,
            }}
          >
            <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', margin: '0 0 6px' }}>
              No runs yet
            </h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
              Share the link /p/{slug} so people can start running this app.
            </p>
          </div>
        )}

        {!notOwner && runs && runs.length > 0 && (
          <div
            data-testid="creator-activity-list"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            {runs.map((r) => (
              <div key={r.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  data-testid={`activity-row-${r.id}`}
                  style={{
                    width: '100%',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr 80px 80px',
                    gap: 12,
                    padding: '14px 18px',
                    background: 'none',
                    border: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    color: 'var(--ink)',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
                    {r.action}
                  </span>
                  <StatusPill status={r.status} />
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {formatTime(r.started_at)}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                  >
                    {r.is_self ? 'you' : r.caller_hash}
                  </span>
                  <span
                    style={{
                      textAlign: 'right',
                      fontSize: 12,
                      color: 'var(--muted)',
                    }}
                  >
                    {r.duration_ms ? `${r.duration_ms}ms` : '-'}
                  </span>
                </button>
                {expanded === r.id && (
                  <div
                    style={{
                      background: 'var(--bg)',
                      padding: '16px 20px',
                      borderTop: '1px solid var(--line)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--muted)',
                        marginBottom: 4,
                      }}
                    >
                      Inputs
                    </div>
                    <JsonBlock value={r.inputs ?? {}} />
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        color: 'var(--muted)',
                        marginBottom: 4,
                        marginTop: 12,
                      }}
                    >
                      Output
                    </div>
                    <JsonBlock value={r.outputs ?? {}} />
                    {r.error && (
                      <>
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            color: '#c2321f',
                            marginBottom: 4,
                            marginTop: 12,
                          }}
                        >
                          Error
                        </div>
                        <code
                          style={{
                            fontSize: 12,
                            color: '#c2321f',
                            fontFamily: 'JetBrains Mono, monospace',
                          }}
                        >
                          {r.error}
                        </code>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre
      style={{
        background: 'var(--card)',
        color: 'var(--ink)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        padding: 12,
        borderRadius: 6,
        border: '1px solid var(--line)',
        overflowX: 'auto',
        margin: 0,
        maxHeight: 240,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function StatusPill({ status }: { status: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    success: { bg: '#e6f4ea', fg: '#1a7f37' },
    error: { bg: '#fdecea', fg: '#c2321f' },
    timeout: { bg: '#fdecea', fg: '#c2321f' },
    running: { bg: '#ecfdf5', fg: '#047857' },
    pending: { bg: '#f4f4f0', fg: '#585550' },
  };
  const c = colors[status] || colors.pending;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        background: c.bg,
        color: c.fg,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        width: 'fit-content',
      }}
    >
      {status}
    </span>
  );
}

const secondaryBtn: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--muted)',
  fontFamily: 'inherit',
  textDecoration: 'none',
};
