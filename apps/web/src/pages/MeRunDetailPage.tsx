// W4-minimal: /me/runs/:id — single-run detail view.
//
// Shows app + action + input JSON + output JSON + duration + logs.
// Scoped to the caller by the server (/api/me/runs/:id), so a 404 means
// either the run doesn't exist or it belongs to another user/device.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageShell } from '../components/PageShell';
import * as api from '../api/client';
import type { MeRunDetail } from '../lib/types';
import { formatTime } from './MePage';

export function MeRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<MeRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    api
      .getMyRun(runId)
      .then(setRun)
      .catch((err) => setError((err as Error).message));
  }, [runId]);

  return (
    <PageShell requireAuth="cloud" title="Run detail | Floom">
      <div data-testid="run-detail" style={{ maxWidth: 900 }}>
        <Link
          to="/me"
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
          Back to dashboard
        </Link>

        {error && (
          <div
            data-testid="run-error"
            style={{
              background: '#fdecea',
              border: '1px solid #f4b7b1',
              color: '#c2321f',
              borderRadius: 10,
              padding: '14px 18px',
            }}
          >
            {error.includes('404') || error.toLowerCase().includes('not found')
              ? 'Run not found. It may belong to another device or user.'
              : error}
          </div>
        )}

        {!run && !error && (
          <div
            data-testid="run-loading"
            style={{ color: 'var(--muted)', fontSize: 14, padding: 40, textAlign: 'center' }}
          >
            Loading...
          </div>
        )}

        {run && (
          <>
            <div style={{ marginBottom: 24 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginBottom: 6,
                }}
              >
                <h1
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    margin: 0,
                    color: 'var(--ink)',
                  }}
                >
                  {run.app_name || run.app_slug || 'Unknown app'}
                </h1>
                <StatusPill status={run.status} />
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Action{' '}
                <code
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    color: 'var(--ink)',
                  }}
                >
                  {run.action}
                </code>{' '}
                · Started {formatTime(run.started_at)}{' '}
                {run.duration_ms != null && <> · {run.duration_ms}ms</>}
              </div>
            </div>

            {run.error && (
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
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {run.error_type || 'Error'}
                </div>
                <code
                  style={{
                    fontSize: 12,
                    fontFamily: 'JetBrains Mono, monospace',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {run.error}
                </code>
              </div>
            )}

            <Section title="Inputs">
              <JsonBlock value={run.inputs ?? {}} />
            </Section>

            <Section title="Output">
              <JsonBlock value={run.outputs ?? {}} />
            </Section>

            {run.logs && (
              <Section title="Logs">
                <pre
                  style={{
                    background: '#0e0e0c',
                    color: '#d4d4c8',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    padding: 16,
                    borderRadius: 8,
                    overflowX: 'auto',
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    maxHeight: 400,
                    overflowY: 'auto',
                  }}
                >
                  {run.logs}
                </pre>
              </Section>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--muted)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <pre
      style={{
        background: 'var(--card)',
        color: 'var(--ink)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        padding: 16,
        borderRadius: 8,
        border: '1px solid var(--line)',
        overflowX: 'auto',
        margin: 0,
        whiteSpace: 'pre-wrap',
        maxHeight: 320,
        overflowY: 'auto',
      }}
    >
      {text}
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
        padding: '3px 10px',
        background: c.bg,
        color: c.fg,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {status}
    </span>
  );
}
