// W4-minimal: /me/runs/:id — single-run detail view.
//
// Shows app + action + input JSON + output JSON + duration + logs.
// Scoped to the caller by the server (/api/me/runs/:id), so a 404 means
// either the run doesn't exist or it belongs to another user/device.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorkspaceHeader, WorkspacePageShell } from '../components/WorkspacePageShell';
import * as api from '../api/client';
import type { MeRunDetail } from '../lib/types';
import { formatTime } from '../lib/time';

export function MeRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<MeRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (!runId) return;
    api
      .getMyRun(runId)
      .then(setRun)
      .catch((err) => setError((err as Error).message));
  }, [runId]);

  const friendlyOutput = useMemo(() => (run ? friendlyEntries(run.outputs) : []), [run]);

  return (
    <WorkspacePageShell mode="run" title="Run detail | Floom">
      <div data-testid="run-detail">
        <Link
          to="/run/runs"
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
          Back to runs
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
              ? 'Run not found in this workspace.'
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
            <WorkspaceHeader
              eyebrow="Workspace Run"
              title={run.app_name || run.app_slug || 'Run detail'}
              scope={
                <>
                  Action <code style={codeInline}>{run.action}</code> · Started {formatTime(run.started_at)}
                  {run.duration_ms != null && <> · {run.duration_ms}ms</>}
                </>
              }
              actions={<StatusPill status={run.status} />}
            />

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

            <section style={resultCardStyle}>
              <div style={resultCardHeadStyle}>
                <div>
                  <div style={sectionLabelStyle}>Result</div>
                  <h2 style={resultTitleStyle}>Output summary</h2>
                </div>
                <button type="button" onClick={() => setShowRaw((v) => !v)} style={toggleStyle}>
                  {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
                </button>
              </div>
              {friendlyOutput.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13 }}>No structured output was returned.</p>
              ) : (
                <dl style={kvGridStyle}>
                  {friendlyOutput.map(([key, value]) => (
                    <div key={key} style={kvRowStyle}>
                      <dt style={kvKeyStyle}>{labelize(key)}</dt>
                      <dd style={kvValueStyle}>{formatFriendlyValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {showRaw ? <div style={{ marginTop: 16 }}><JsonBlock value={run.outputs ?? {}} /></div> : null}
            </section>

            {run.logs && (
              <Section title="Logs">
                <pre
                  style={{
                    // Warm dark neutral (no pure black) — Federico's
                    // locked rule for terminal surfaces. Matches the
                    // landing hero code panel + /install code blocks.
                    background: '#1b1a17',
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
    </WorkspacePageShell>
  );
}

function friendlyEntries(value: unknown): Array<[string, unknown]> {
  if (value == null) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [['result', value]];
  return Object.entries(value as Record<string, unknown>).slice(0, 12);
}

function labelize(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatFriendlyValue(value: unknown): string {
  if (value == null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => formatFriendlyValue(item)).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

const sectionLabelStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--muted)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const resultCardStyle: React.CSSProperties = {
  background: '#fff8ed',
  border: '1px solid #eadfce',
  borderRadius: 12,
  padding: 20,
  marginBottom: 22,
};

const resultCardHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 16,
  flexWrap: 'wrap',
};

const resultTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 750,
  margin: '4px 0 0',
  color: 'var(--ink)',
};

const toggleStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  background: 'var(--card)',
  color: 'var(--ink)',
  borderRadius: 8,
  padding: '8px 11px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const kvGridStyle: React.CSSProperties = {
  margin: 0,
  display: 'grid',
  gap: 10,
};

const kvRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '160px minmax(0, 1fr)',
  gap: 12,
  alignItems: 'start',
};

const kvKeyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 700,
  color: 'var(--muted)',
};

const kvValueStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13.5,
  lineHeight: 1.55,
  color: 'var(--ink)',
  overflowWrap: 'anywhere',
};

const codeInline: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  color: 'var(--ink)',
};
