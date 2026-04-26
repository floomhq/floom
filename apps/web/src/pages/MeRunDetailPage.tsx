// v23 PR-K: /me/runs/:id — Single-run detail.
//
// Design spec: https://wireframes.floom.dev/v23/me-runs-detail.html
// Decision doc: /tmp/wireframe-react/me-runs-decision.md
//
// Key v23 changes vs v17:
//   - Layout swap: PageShell → MeLayout (activeTab="runs"), so the
//     /me/* tabs/breadcrumb chrome is consistent across list + detail.
//   - Pill-chrome back link `.rd-back` → "Back to all runs".
//   - Status header `.rd-status`: icon + slug · action + meta line
//     (run_id · time-ago · duration · model · tokens) + saturated DONE
//     /FAILED pill + Re-run + Share buttons.
//   - Collapsible sections (`.rd-sect`): Input (default open) /
//     Output (default open) / Raw JSON (default closed) / Logs (default closed).
//   - Output rendering: per-app renderers for the 3 launch apps
//     (competitor-lens, ai-readiness-audit, pitch-coach). Generic JSON
//     tree fallback for everything else. Try/catch falls back to JSON
//     on schema mismatch.
//   - Code blocks use --code (warm dark, never #000) with light
//     key/string/comment color coding.
//
// Federico locks observed:
//   - No category tints on the run icon (`.ic` uses --bg only).
//   - --code background, never #000 / bg-black.
//   - Fail gracefully when meta fields are missing (don't fabricate via,
//     model, or tokens).

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppIcon } from '../components/AppIcon';
import { MeLayout } from '../components/me/MeLayout';
import { buildRerunHref, formatDuration } from '../components/me/runPreview';
import * as api from '../api/client';
import type { MeRunDetail, RunStatus } from '../lib/types';
import { formatTime } from '../lib/time';
import { StatusPill } from './MeRunsPage';

export function MeRunDetailPage() {
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
        () => {
          /* fall through; clipboard rejected silently */
        },
      );
    }
  }

  return (
    <MeLayout
      activeTab="runs"
      title="Run detail · Me · Floom"
      headerVariant="none"
    >
      <div data-testid="run-detail" style={{ maxWidth: 1080, margin: '0 auto' }}>
        <Link
          to="/me/runs"
          className="rd-back"
          data-testid="me-run-detail-back"
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

        {error ? (
          <div data-testid="run-error" className="rd-error">
            <div className="rd-error-title">
              {error.includes('404') || error.toLowerCase().includes('not found')
                ? 'Run not found'
                : 'Couldn’t load run'}
            </div>
            <pre>
              {error.includes('404') || error.toLowerCase().includes('not found')
                ? 'It may belong to another device or user, or the link is invalid.'
                : error}
            </pre>
          </div>
        ) : null}

        {!run && !error ? (
          <div
            data-testid="run-loading"
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

        {run ? (
          <>
            <StatusHeader
              run={run}
              onShare={handleShare}
              shareCopied={shareCopied}
            />

            {run.error ? (
              <div data-testid="run-detail-error" className="rd-error">
                <div className="rd-error-title">{run.error_type || 'Error'}</div>
                <pre>{run.error}</pre>
              </div>
            ) : null}

            <CollapsibleSection
              testId="run-detail-input"
              title="Input"
              defaultOpen
              codeBody
            >
              <CodeBlock value={run.inputs ?? {}} />
            </CollapsibleSection>

            <CollapsibleSection
              testId="run-detail-output"
              title="Output"
              defaultOpen
            >
              <OutputRenderer run={run} />
            </CollapsibleSection>

            <CollapsibleSection
              testId="run-detail-raw"
              title="Raw JSON"
              codeBody
            >
              <CodeBlock value={run.outputs ?? {}} />
            </CollapsibleSection>

            <CollapsibleSection
              testId="run-detail-logs"
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
    </MeLayout>
  );
}

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
  const titleText = slug ? (action ? `${slug} · ${action}` : slug) : run.app_name || 'Run';

  // Meta line: run_id_short · time-ago · duration. via/model/tokens are
  // not on MeRunDetail today (Flag #2 in decision doc — defaults to
  // showing only the fields the API returns; never fabricate).
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
    <div className="rd-status" data-testid="run-detail-status">
      <div className="l">
        <span className="ic" aria-hidden>
          {slug ? (
            <AppIcon slug={slug} size={22} />
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 16, fontWeight: 700 }}>
              ·
            </span>
          )}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="nm" data-testid="run-detail-title">
            {titleText}
          </div>
          <div className="meta">{metaParts.join(' · ')}</div>
        </div>
      </div>
      {/* Mobile-only 2x2 meta grid (the desktop meta line collapses on
          narrow viewports; this grid surfaces the same info as
          digestible cells per the wireframe). */}
      <div
        className="rd-meta-grid"
        data-testid="run-detail-meta-mobile"
        style={{ display: 'none' }}
      >
        <div>
          <strong>{formatDuration(run.duration_ms)}</strong> duration
        </div>
        <div>
          <strong>{run.app_name || run.app_slug || '—'}</strong>
        </div>
        <div>
          <strong>{formatTime(run.started_at)}</strong>
        </div>
        <div>
          <strong>
            {run.upstream_status != null ? `HTTP ${run.upstream_status}` : run.status.toUpperCase()}
          </strong>
        </div>
      </div>
      <style>{`
        @media (max-width: 640px) {
          [data-testid="run-detail-status"] .l > div > .meta { display: none; }
          [data-testid="run-detail-status"] .rd-meta-grid { display: grid !important; }
        }
      `}</style>

      <div className="actions">
        <StatusPill status={run.status as RunStatus} />
        {slug ? (
          <Link
            to={buildRerunHref(slug, run.id, run.action)}
            className="btn"
            data-testid="run-detail-rerun"
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
          className="btn"
          onClick={onShare}
          data-testid="run-detail-share"
          aria-live="polite"
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
    >
      <button
        type="button"
        className="rd-sect-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <h3>
          {title}
          {typeof lineCount === 'number' && lineCount > 0 ? (
            <span className="lc">{lineCount} lines</span>
          ) : null}
        </h3>
        <svg
          className="chev"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className={`rd-sect-body${codeBody ? ' code-body' : ''}`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/* ── Per-app output renderers ───────────────────────────────────────────── */

function OutputRenderer({ run }: { run: MeRunDetail }) {
  const slug = run.app_slug;
  const output = run.outputs;

  // No output yet (running / pending / explicit null)
  if (output == null) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 13.5 }}>
        {run.status === 'running' || run.status === 'pending'
          ? 'Run is still in progress.'
          : 'No output for this run.'}
      </div>
    );
  }

  // Per-app renderers: try the bespoke layout first, fall back to JSON
  // on schema mismatch so a shape change can't crash the page.
  try {
    if (slug === 'competitor-lens') {
      const rendered = renderCompetitorLens(output);
      if (rendered) return rendered;
    }
    if (slug === 'ai-readiness-audit') {
      const rendered = renderAiReadinessAudit(output);
      if (rendered) return rendered;
    }
    if (slug === 'pitch-coach') {
      const rendered = renderPitchCoach(output);
      if (rendered) return rendered;
    }
  } catch {
    /* fall through to JSON */
  }

  return <CodeBlock value={output} />;
}

function renderCompetitorLens(output: unknown): React.ReactNode {
  if (!isObject(output)) return null;
  const dimensions = output['dimensions'];
  const yourLabel =
    pickString(output, 'your_label') ||
    pickString(output, 'your_url') ||
    'You';
  const competitorLabel =
    pickString(output, 'competitor_label') ||
    pickString(output, 'competitor_url') ||
    'Competitor';
  if (!Array.isArray(dimensions) || dimensions.length === 0) return null;

  const rows = dimensions.filter(isObject);
  if (rows.length === 0) return null;

  return (
    <div style={{ padding: 0 }}>
      <table className="rd-table" data-testid="output-competitor-lens">
        <thead>
          <tr>
            <th>Dimension</th>
            <th>{cleanLabel(yourLabel)}</th>
            <th>{cleanLabel(competitorLabel)}</th>
            <th>Winner</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const dim = pickString(row, 'dimension') || pickString(row, 'name') || `row ${i + 1}`;
            const yourValue = pickString(row, 'yours') || pickString(row, 'your') || pickString(row, 'you') || '—';
            const compValue =
              pickString(row, 'competitor') ||
              pickString(row, 'theirs') ||
              pickString(row, 'them') ||
              '—';
            const winner = pickString(row, 'winner') || 'tie';
            const isTie = winner === 'tie' || !winner;
            return (
              <tr key={i}>
                <td style={{ fontWeight: 500 }}>{dim}</td>
                <td>{yourValue}</td>
                <td>{compValue}</td>
                <td>
                  <span className={`score ${isTie ? 'mid' : 'hi'}`}>
                    {winner}
                  </span>
                </td>
              </tr>
            );
          })}
          {pickString(output, 'verdict') ? (
            <tr>
              <td style={{ fontWeight: 500 }}>verdict</td>
              <td colSpan={2}>{pickString(output, 'verdict')}</td>
              <td>
                <span className="score hi">
                  {pickString(output, 'winner') || 'see verdict'}
                </span>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function renderAiReadinessAudit(output: unknown): React.ReactNode {
  if (!isObject(output)) return null;
  const score = output['score'];
  const risks = Array.isArray(output['risks']) ? (output['risks'] as unknown[]) : [];
  const opportunities = Array.isArray(output['opportunities'])
    ? (output['opportunities'] as unknown[])
    : Array.isArray(output['wins'])
      ? (output['wins'] as unknown[])
      : Array.isArray(output['strengths'])
        ? (output['strengths'] as unknown[])
        : [];
  const nextAction = pickString(output, 'next_action') || pickString(output, 'next');
  if (typeof score !== 'number' && risks.length === 0 && opportunities.length === 0) {
    return null;
  }

  const scoreClass =
    typeof score === 'number' && score >= 7
      ? 'hi'
      : typeof score === 'number' && score >= 4
        ? 'mid'
        : 'lo';

  return (
    <div data-testid="output-ai-readiness-audit">
      {typeof score === 'number' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginBottom: 16,
          }}
        >
          <span
            className={`score ${scoreClass}`}
            style={{
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontWeight: 700,
              padding: '8px 16px',
              borderRadius: 10,
              fontSize: 18,
              background:
                scoreClass === 'hi'
                  ? 'var(--accent-soft)'
                  : scoreClass === 'mid'
                    ? 'var(--warning-soft)'
                    : 'var(--danger-soft)',
              color:
                scoreClass === 'hi'
                  ? 'var(--accent)'
                  : scoreClass === 'mid'
                    ? 'var(--warning)'
                    : 'var(--danger)',
            }}
          >
            {score}/10
          </span>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            Readiness score
          </span>
        </div>
      ) : null}

      {risks.length > 0 ? (
        <div className="rd-card danger" style={{ marginBottom: 10 }}>
          <div className="rd-card-label">
            Risks · {risks.length}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink)', fontSize: 13.5, lineHeight: 1.6 }}>
            {risks.slice(0, 8).map((r, i) => (
              <li key={i}>{stringify(r)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {opportunities.length > 0 ? (
        <div className="rd-card accent" style={{ marginBottom: 10 }}>
          <div className="rd-card-label">
            Opportunities · {opportunities.length}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink)', fontSize: 13.5, lineHeight: 1.6 }}>
            {opportunities.slice(0, 8).map((o, i) => (
              <li key={i}>{stringify(o)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {nextAction ? (
        <div className="rd-card">
          <div className="rd-card-label">Next action</div>
          <p className="rd-card-text">{nextAction}</p>
        </div>
      ) : null}
    </div>
  );
}

function renderPitchCoach(output: unknown): React.ReactNode {
  if (!isObject(output)) return null;
  const critiques = Array.isArray(output['critiques'])
    ? (output['critiques'] as unknown[])
    : [];
  const rewrites = Array.isArray(output['rewrites'])
    ? (output['rewrites'] as unknown[])
    : [];
  const tldr = pickString(output, 'tldr') || pickString(output, 'summary');
  if (critiques.length === 0 && rewrites.length === 0 && !tldr) return null;

  return (
    <div data-testid="output-pitch-coach">
      {tldr ? (
        <div className="rd-card accent" style={{ marginBottom: 10 }}>
          <div className="rd-card-label">TL;DR</div>
          <p className="rd-card-text">{tldr}</p>
        </div>
      ) : null}

      {critiques.length > 0 ? (
        <div className="rd-card" style={{ marginBottom: 10 }}>
          <div className="rd-card-label">Critiques · {critiques.length}</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink)', fontSize: 13.5, lineHeight: 1.6 }}>
            {critiques.slice(0, 8).map((c, i) => (
              <li key={i}>{stringify(c)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {rewrites.length > 0 ? (
        <div className="rd-card">
          <div className="rd-card-label">Rewrites · {rewrites.length}</div>
          <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--ink)', fontSize: 13.5, lineHeight: 1.7 }}>
            {rewrites.slice(0, 6).map((r, i) => (
              <li key={i} style={{ marginBottom: 6 }}>{stringify(r)}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/* ── Code block with light JSON syntax highlighting ────────────────────── */

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

/**
 * Tiny regex-based JSON highlighter. Returns a list of segments tagged
 * with .k (keys) / .s (strings) / .c (comments) — matched to the .rd-sect-body
 * .k / .s / .c CSS classes. Defensive: anything that doesn't match the
 * patterns falls through as plain text.
 */
function highlightJson(text: string): Array<{ text: string; cls?: string }> {
  const out: Array<{ text: string; cls?: string }> = [];
  // Match: keys ("foo": ), string values, line comments, anything else.
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

/* ── helpers ──────────────────────────────────────────────────────────── */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

function cleanLabel(label: string): string {
  return label.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
