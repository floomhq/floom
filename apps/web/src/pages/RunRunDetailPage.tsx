// /run/runs/:runId — v26 Run-mode run detail page.
//
// Wireframe: /var/www/wireframes-floom/v26/run-runs-detail.html
//
// Shell: WorkspacePageShell mode="run" (same as RunRunsPage, RunAppsPage).
// Content: mirrors MeRunDetailPage functionality (status header, input/output
// collapsible panels, raw JSON, logs). Uses same API (api.getMyRun) and same
// StatusPill / CollapsibleSection / CodeBlock sub-components from MeRunDetailPage.
//
// COEXIST: MeRunDetailPage at /me/runs/:runId is preserved untouched.
// This page is the v26 WorkspaceShell surface for the same data.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorkspacePageShell } from '../components/WorkspacePageShell';
import { AppIcon } from '../components/AppIcon';
import { buildRerunHref, formatDuration } from '../components/me/runPreview';
import { StatusPill } from './MeRunsPage';
import * as api from '../api/client';
import type { MeRunDetail, RunStatus } from '../lib/types';
import { formatTime } from '../lib/time';

export function RunRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<MeRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  useEffect(() => {
    if (!runId) return;
    api
      .getMyRun(runId)
      .then(setRun)
      .catch((err) => setError((err as Error).message));
  }, [runId]);

  function handleShare() {
    const url = window.location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => {
          setShareCopied(true);
          window.setTimeout(() => setShareCopied(false), 1600);
        },
        () => { /* clipboard rejected silently */ },
      );
    }
  }

  return (
    <WorkspacePageShell mode="run" title="Run detail · Run · Floom">
      <div data-testid="run-run-detail" style={{ maxWidth: 1080, margin: '0 auto' }}>
        {/* Back breadcrumb */}
        <Link
          to="/run/runs"
          data-testid="run-run-detail-back"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            color: 'var(--muted)',
            marginBottom: 20,
            textDecoration: 'none',
            padding: '6px 12px',
            border: '1px solid var(--line)',
            borderRadius: 999,
            background: 'var(--card)',
            fontWeight: 500,
            transition: 'all .12s',
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to all runs
        </Link>

        {/* Error state */}
        {error ? (
          <div
            data-testid="run-run-error"
            className="rd-error"
            style={{
              padding: '14px 18px',
              border: '1px solid #f4b7b1',
              borderRadius: 14,
              background: '#fdecea',
              color: '#5c2d26',
              marginBottom: 16,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {error.includes('404') || error.toLowerCase().includes('not found')
                ? 'Run not found'
                : "Couldn't load run"}
            </div>
            <pre style={{ margin: 0, fontSize: 12.5, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>
              {error.includes('404') || error.toLowerCase().includes('not found')
                ? 'It may belong to another device or user, or the link is invalid.'
                : error}
            </pre>
          </div>
        ) : null}

        {/* Loading state */}
        {!run && !error ? (
          <div
            data-testid="run-run-loading"
            style={{
              color: 'var(--muted)',
              fontSize: 14,
              padding: 40,
              textAlign: 'center',
              border: '1px solid var(--line)',
              borderRadius: 14,
              background: 'var(--card)',
            }}
          >
            Loading…
          </div>
        ) : null}

        {/* Run detail */}
        {run ? (
          <>
            <StatusHeader
              run={run}
              onShare={handleShare}
              shareCopied={shareCopied}
            />

            {run.error ? (
              <div
                data-testid="run-run-detail-error"
                className="rd-error"
                style={{
                  padding: '14px 18px',
                  border: '1px solid #f4b7b1',
                  borderRadius: 14,
                  background: '#fdecea',
                  color: '#5c2d26',
                  marginBottom: 16,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  {run.error_type || 'Error'}
                </div>
                <pre style={{ margin: 0, fontSize: 12.5, fontFamily: 'JetBrains Mono, ui-monospace, monospace', whiteSpace: 'pre-wrap' }}>
                  {run.error}
                </pre>
              </div>
            ) : null}

            <CollapsibleSection
              testId="run-run-detail-input"
              title="Input"
              defaultOpen
              codeBody
            >
              <CodeBlock value={run.inputs ?? {}} />
            </CollapsibleSection>

            <CollapsibleSection
              testId="run-run-detail-output"
              title="Output"
              defaultOpen
            >
              {run.outputs == null ? (
                <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>
                  {run.status === 'running' || run.status === 'pending'
                    ? 'Run is still in progress.'
                    : 'No output for this run.'}
                </div>
              ) : (
                <CodeBlock value={run.outputs} />
              )}
            </CollapsibleSection>

            <CollapsibleSection
              testId="run-run-detail-raw"
              title="Raw JSON"
              codeBody
            >
              <CodeBlock value={run.outputs ?? {}} />
            </CollapsibleSection>

            <CollapsibleSection
              testId="run-run-detail-logs"
              title="Logs"
              lineCount={(run.logs ?? '').split('\n').filter(Boolean).length}
              codeBody
            >
              <pre
                style={{
                  margin: 0,
                  padding: '18px 22px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 400,
                  background: 'var(--code)',
                  color: 'var(--code-text)',
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                  fontSize: 12.5,
                  lineHeight: 1.7,
                }}
              >
                {run.logs || '(no logs)'}
              </pre>
            </CollapsibleSection>
          </>
        ) : null}
      </div>
    </WorkspacePageShell>
  );
}

// ------------------------------------------------------------------
// StatusHeader
// ------------------------------------------------------------------

function StatusHeader({
  run,
  onShare,
  shareCopied,
}: {
  run: MeRunDetail;
  onShare: () => void;
  shareCopied: boolean;
}) {
  const slug = run.app_slug;
  const action = run.action && run.action !== 'run' ? run.action : null;
  const titleText = slug
    ? action ? `${slug} · ${action}` : slug
    : run.app_name || 'Run';

  const runIdShort = run.id.replace(/^run_/, '').slice(0, 8);
  const metaParts = [
    `run_${runIdShort}`,
    formatTime(run.started_at),
    formatDuration(run.duration_ms),
  ];
  if (run.upstream_status != null) {
    metaParts.push(`HTTP ${run.upstream_status}`);
  }

  return (
    <div
      className="rd-status"
      data-testid="run-run-detail-status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        padding: '18px 22px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        marginBottom: 18,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <span
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          aria-hidden
        >
          {slug ? (
            <AppIcon slug={slug} size={22} />
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 16, fontWeight: 700 }}>·</span>
          )}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            data-testid="run-run-detail-title"
            style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.2, color: 'var(--ink)' }}
          >
            {titleText}
          </div>
          <div
            style={{
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 11.5,
              color: 'var(--muted)',
              marginTop: 3,
            }}
          >
            {metaParts.join(' · ')}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusPill status={run.status as RunStatus} />
        {slug ? (
          <Link
            to={buildRerunHref(slug, run.id, run.action)}
            data-testid="run-run-detail-rerun"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '6px 12px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--ink)',
              textDecoration: 'none',
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15 a9 9 0 1 0 2.13 -9.36 L1 10" />
            </svg>
            Re-run
          </Link>
        ) : null}
        <button
          type="button"
          data-testid="run-run-detail-share"
          onClick={onShare}
          aria-live="polite"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 12px',
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--ink)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          {shareCopied ? 'Copied!' : 'Share'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// CollapsibleSection
// ------------------------------------------------------------------

function CollapsibleSection({
  testId,
  title,
  defaultOpen = false,
  codeBody = false,
  lineCount,
  children,
}: {
  testId: string;
  title: string;
  defaultOpen?: boolean;
  codeBody?: boolean;
  lineCount?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={`rd-sect${open ? ' open' : ''}`}
      data-testid={testId}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 14,
        marginBottom: 14,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 20px',
          cursor: 'pointer',
          width: '100%',
          background: 'transparent',
          border: 0,
          borderBottom: open ? '1px solid var(--line)' : 'none',
          fontFamily: 'inherit',
        }}
      >
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--ink)' }}>
          {title}
          {typeof lineCount === 'number' && lineCount > 0 ? (
            <span
              style={{
                marginLeft: 8,
                fontSize: 10.5,
                fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                color: 'var(--muted)',
                fontWeight: 500,
              }}
            >
              {lineCount} lines
            </span>
          ) : null}
        </h3>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            color: 'var(--muted)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div
          style={
            codeBody
              ? {
                  padding: 0,
                  background: 'var(--code)',
                  color: 'var(--code-text)',
                  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                  fontSize: 12.5,
                  lineHeight: 1.7,
                }
              : { padding: '18px 22px' }
          }
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------
// CodeBlock with light JSON syntax highlighting
// ------------------------------------------------------------------

function CodeBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const segments = useMemo(() => highlightJson(text), [text]);

  return (
    <pre
      style={{
        margin: 0,
        padding: '18px 22px',
        overflow: 'auto',
        whiteSpace: 'pre',
        maxHeight: 420,
      }}
    >
      {segments.map((seg, i) =>
        seg.cls ? (
          <span key={i} className={seg.cls}>
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </pre>
  );
}

function highlightJson(text: string): Array<{ text: string; cls?: string }> {
  const out: Array<{ text: string; cls?: string }> = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|(\/\/[^\n]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      out.push({ text: text.slice(last, m.index) });
    }
    if (m[1]) {
      out.push({ text: m[1], cls: 'k' });
      out.push({ text: m[2] || ':' });
    } else if (m[3]) {
      out.push({ text: m[3], cls: 's' });
    } else if (m[4]) {
      out.push({ text: m[4], cls: 'c' });
    }
    last = re.lastIndex;
  }
  if (last < text.length) {
    out.push({ text: text.slice(last) });
  }
  return out;
}
