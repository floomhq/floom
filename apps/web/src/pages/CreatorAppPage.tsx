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
import { formatTime } from './MePage';

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
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    api
      .getAppRuns(slug, 20)
      .then((res) => {
        setRuns(res.runs);
        setAppInfo(res.app);
      })
      .catch((err) => setError((err as Error).message));
    api
      .getApp(slug)
      .then((detail) => setRenderer(detail.renderer ?? null))
      .catch(() => {
        /* non-fatal: panel falls back to "no renderer" default */
      });
  }, [slug]);

  return (
    <PageShell requireAuth="cloud" title={`${slug} activity | Floom`}>
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

        {appInfo && (
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
            <div style={{ display: 'flex', gap: 8 }}>
              <Link to={`/build?edit=${slug}`} style={secondaryBtn}>
                Edit
              </Link>
              <Link to={`/p/${slug}`} style={secondaryBtn}>
                View store
              </Link>
            </div>
          </div>
        )}

        {slug && (
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

        {runs && runs.length === 0 && (
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

        {runs && runs.length > 0 && (
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
