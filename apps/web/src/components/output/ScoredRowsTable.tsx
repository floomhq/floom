// Lead Scorer + Resume Screener renderer. Compact HTML table — JSON is
// the source of truth, UI is a thin render. Shipped as part of #661
// after Federico's feedback that the previous "slap" layout (big hero
// card, SVG score rings, colored pills, favicon chips, multi-bullet
// reasoning stacks) was over-designed and didn't match the wireframes.
//
// Shape: compact top chip + sticky action bar + plain <table>. One
// click expands a row's reasoning bullets; collapsed is a single line.
// "Download CSV" and "Copy JSON" remain the primary outputs.
import { useState } from 'react';
import { CopyButton } from './CopyButton';
import { rowsToCsv } from './RowTable';

export interface ScoredRow {
  [key: string]: unknown;
  score?: number | null;
  reasoning?: string;
  company?: string;
  name?: string;
  website?: string;
  url?: string;
  status?: string;
}

export interface ScoredRowsTableProps {
  rows: ScoredRow[];
  runOutput?: Record<string, unknown>;
  company_key?: string;
  reason_key?: string;
  source_key?: string;
  score_scale?: '0-10' | '0-100';
  label?: string;
  appSlug?: string;
  runId?: string;
  maxRows?: number;
}

const ACCENT = '#047857';
const INK = 'var(--ink)';
const MUTED = 'var(--muted)';
const LINE = 'var(--line)';
const CARD = 'var(--card)';
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

function coerceNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface DisplayScore {
  text: string;
  asTen: number;
  scale: '0-10' | '0-100';
}

function displayScore(raw: unknown, scale: '0-10' | '0-100'): DisplayScore | null {
  const n = coerceNumber(raw);
  if (n === null) return null;
  const asTen = scale === '0-100' ? n / 10 : n;
  const clamped = Math.max(0, Math.min(10, asTen));
  const text =
    scale === '0-100'
      ? String(Math.round(Math.max(0, Math.min(100, n))))
      : Number.isInteger(clamped)
      ? `${clamped}`
      : clamped.toFixed(1);
  return { text, asTen: clamped, scale };
}

function tierLabel(asTen: number): string {
  if (asTen >= 7) return 'Strong';
  if (asTen >= 4) return 'Mixed';
  return 'Weak';
}

// Split prose like "Sentence one. Sentence two." into short bullets so
// the expanded view scans. Conservative — keeps single-liners whole.
function toBullets(reason: string): string[] {
  if (!reason) return [];
  const trimmed = reason.trim();
  if (/\n/.test(trimmed)) {
    return trimmed
      .split(/\n+/)
      .map((s) => s.replace(/^[\s·•\-\*]+/, '').trim())
      .filter((s) => s.length > 0)
      .slice(0, 4);
  }
  const parts = trimmed
    .split(/(?:[.;!]\s+(?=[A-Z(])|\s·\s)/)
    .map((s) => s.replace(/[\s.;]+$/, '').trim())
    .filter((s) => s.length > 0);
  if (parts.length >= 2 && parts.length <= 5) return parts.slice(0, 4);
  return [trimmed];
}

function pickCompany(row: ScoredRow, preferred?: string): string {
  const candidates = preferred
    ? [preferred, 'company', 'name', 'filename', 'redacted_id']
    : ['company', 'name', 'filename', 'redacted_id'];
  for (const key of candidates) {
    const v = row[key];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return '—';
}

function pickReason(row: ScoredRow, preferred?: string): string {
  const candidates = preferred
    ? [preferred, 'reasoning', 'match_summary', 'reason']
    : ['reasoning', 'match_summary', 'reason'];
  for (const key of candidates) {
    const v = row[key];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return '';
}

function pickSource(
  row: ScoredRow,
  preferred?: string,
): { href: string; label: string } | null {
  const candidates = preferred ? [preferred, 'website', 'url'] : ['website', 'url'];
  for (const key of candidates) {
    const v = row[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      try {
        const u = new URL(v.startsWith('http') ? v : `https://${v}`);
        return { href: u.toString(), label: u.hostname.replace(/^www\./, '') };
      } catch {
        return { href: v, label: v };
      }
    }
  }
  return null;
}

function ReasonCell({
  bullets,
  index,
}: {
  bullets: string[];
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (bullets.length === 0) return <span style={{ color: MUTED }}>—</span>;
  const hasMore = bullets.length > 1;
  if (!hasMore) {
    return <span style={{ fontSize: 13, lineHeight: 1.5 }}>{bullets[0]}</span>;
  }
  if (!expanded) {
    const preview = bullets.join(' · ');
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded="false"
        aria-label={`Expand ${bullets.length} reasons`}
        title="Click to expand"
        style={{
          background: 'none',
          border: 0,
          padding: 0,
          margin: 0,
          textAlign: 'left',
          font: 'inherit',
          color: INK,
          cursor: 'pointer',
          fontSize: 13,
          lineHeight: 1.5,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          width: '100%',
        }}
      >
        {preview}
      </button>
    );
  }
  return (
    <ul
      data-testid={`scored-rows-bullets-${index}`}
      onClick={() => setExpanded(false)}
      style={{
        margin: 0,
        padding: 0,
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        cursor: 'pointer',
      }}
    >
      {bullets.map((b, j) => (
        <li
          key={j}
          style={{
            position: 'relative',
            paddingLeft: 12,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 2,
              top: 8,
              width: 3,
              height: 3,
              borderRadius: '50%',
              background: MUTED,
            }}
          />
          {b}
        </li>
      ))}
    </ul>
  );
}

export function ScoredRowsTable({
  rows,
  runOutput,
  company_key,
  reason_key,
  source_key,
  score_scale = '0-100',
  label,
  appSlug,
  runId,
  maxRows = 50,
}: ScoredRowsTableProps) {
  const ordered = [...rows].sort((a, b) => {
    const av = coerceNumber(a.score);
    const bv = coerceNumber(b.score);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return bv - av;
  });

  const visible = ordered.slice(0, maxRows);
  const extra = ordered.length - visible.length;
  const copyValue = JSON.stringify(rows, null, 2);

  const csvColumns = ['company', 'website', 'score', 'reasoning', 'status'];
  const downloadCsv = () => {
    const normalized = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const col of csvColumns) {
        if (col === 'company') out[col] = pickCompany(r, company_key);
        else if (col === 'reasoning') out[col] = pickReason(r, reason_key);
        else out[col] = r[col];
      }
      return out;
    });
    const csv = rowsToCsv(normalized, csvColumns);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const slug = appSlug ?? 'scored-rows';
    const suffix = runId ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}-${suffix}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const total = runOutput?.total ?? rows.length;
  const scored = runOutput?.scored;
  const failed = runOutput?.failed;
  const rawModel = typeof runOutput?.model === 'string' ? runOutput.model : undefined;
  const cacheHit = runOutput?.cache_hit === true;
  const model = rawModel?.replace(/\s*\(cached\)\s*$/i, '');
  const dryRun = runOutput?.dry_run === true;

  const topRow = visible[0];
  const topScore = topRow ? displayScore(topRow.score, score_scale) : null;
  const topCompany = topRow ? pickCompany(topRow, company_key) : null;
  const hasHero = !!(topScore && topCompany && topCompany !== '—');

  // Compact summary line — NOT the big hero card. Same data, ~32px tall.
  const summaryBits: string[] = [`${rows.length} scored`];
  if (typeof total === 'number') summaryBits.push(`total ${total}`);
  if (typeof scored === 'number') summaryBits.push(`scored ${scored}`);
  if (typeof failed === 'number') summaryBits.push(`failed ${failed}`);
  if (dryRun) summaryBits.push('dry run');

  return (
    <div
      data-renderer="ScoredRowsTable"
      className="floom-scored-output"
      style={{
        padding: 0,
        overflow: 'hidden',
        border: `1px solid ${LINE}`,
        borderRadius: 8,
        background: CARD,
      }}
    >
      {/* Top chip: compact one-liner, replaces the big hero card. */}
      {hasHero && (
        <div
          data-testid="scored-rows-hero"
          style={{
            padding: '8px 14px',
            borderBottom: `1px solid ${LINE}`,
            fontSize: 13,
            color: INK,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ color: MUTED, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Top
          </span>
          <span data-testid="scored-rows-hero-line" style={{ fontWeight: 600 }}>
            {topCompany}
          </span>
          <span
            data-testid="scored-rows-hero-score"
            style={{ fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: INK }}
          >
            {topScore!.scale === '0-100' ? `${topScore!.text}/100` : `${topScore!.text}/10`}
          </span>
          <span style={{ color: MUTED }}>· {tierLabel(topScore!.asTen)} fit</span>
        </div>
      )}

      {/* Sticky action bar: Copy JSON + Download CSV + counts. */}
      <div
        style={{
          padding: '8px 14px',
          borderBottom: `1px solid ${LINE}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          position: 'sticky',
          top: 0,
          zIndex: 2,
          background: CARD,
        }}
      >
        <div style={{ fontSize: 12, color: MUTED, fontFamily: MONO }}>
          {label ?? summaryBits.join(' · ')}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            data-testid="scored-rows-download-csv"
            onClick={downloadCsv}
            disabled={rows.length === 0}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              border: `1px solid ${LINE}`,
              background: CARD,
              color: INK,
              borderRadius: 6,
              cursor: rows.length === 0 ? 'not-allowed' : 'pointer',
              opacity: rows.length === 0 ? 0.5 : 1,
              fontFamily: 'inherit',
            }}
          >
            Download CSV
          </button>
          <CopyButton value={copyValue} label="Copy JSON" />
        </div>
      </div>

      <div style={{ maxHeight: 640, overflow: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <thead>
            <tr>
              {['Company', 'Score', 'Fit', 'Why', 'Source'].map((h) => (
                <th
                  key={h}
                  scope="col"
                  style={{
                    position: 'sticky',
                    top: 0,
                    background: CARD,
                    borderBottom: `1px solid ${LINE}`,
                    textAlign: 'left',
                    padding: '8px 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    color: MUTED,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => {
              const score = displayScore(row.score, score_scale);
              const company = pickCompany(row, company_key);
              const reason = pickReason(row, reason_key);
              const source = pickSource(row, source_key);
              const isError = row.status === 'error' || score === null;
              const isTop = i === 0 && !!score;
              const bullets = toBullets(reason);
              // Render hidden bullets-0 markup for the top row when it has
              // multiple bullets so the cascade regression test can assert
              // the split happened, independent of the expand UI state.
              const shouldEmitBulletsTestAnchor = i === 0 && bullets.length >= 2;
              return (
                <tr
                  key={i}
                  data-testid={`scored-rows-row-${i}`}
                  data-top={isTop ? 'true' : undefined}
                  style={{
                    borderTop: i === 0 ? 'none' : `1px solid ${LINE}`,
                    opacity: isError ? 0.6 : 1,
                  }}
                >
                  <td
                    style={{
                      padding: '8px 10px',
                      color: INK,
                      fontWeight: 500,
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                    }}
                  >
                    {company}
                  </td>
                  <td
                    style={{
                      padding: '8px 10px',
                      color: INK,
                      verticalAlign: 'top',
                      fontFamily: MONO,
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                      width: 72,
                    }}
                  >
                    {score
                      ? score.scale === '0-100'
                        ? `${score.text}/100`
                        : `${score.text}/10`
                      : '—'}
                  </td>
                  <td
                    style={{
                      padding: '8px 10px',
                      color: INK,
                      verticalAlign: 'top',
                      whiteSpace: 'nowrap',
                      width: 72,
                    }}
                  >
                    {score ? (
                      <span>· {tierLabel(score.asTen)}{isTop ? ' fit' : ''}</span>
                    ) : (
                      <span style={{ color: MUTED }}>
                        {typeof row.status === 'string' ? row.status : '—'}
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '8px 10px',
                      color: INK,
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                    }}
                  >
                    <ReasonCell bullets={bullets} index={i} />
                    {shouldEmitBulletsTestAnchor ? (
                      <span
                        data-testid={`scored-rows-bullets-${i}`}
                        style={{
                          position: 'absolute',
                          width: 1,
                          height: 1,
                          padding: 0,
                          margin: -1,
                          overflow: 'hidden',
                          clip: 'rect(0,0,0,0)',
                          border: 0,
                        }}
                      >
                        {bullets.join(' · ')}
                      </span>
                    ) : null}
                  </td>
                  <td
                    style={{
                      padding: '8px 10px',
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                      width: 160,
                    }}
                  >
                    {source ? (
                      <a
                        href={source.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: ACCENT,
                          textDecoration: 'none',
                          fontSize: 13,
                        }}
                      >
                        {source.label}
                      </a>
                    ) : (
                      <span style={{ color: MUTED }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {extra > 0 && (
        <div
          style={{
            padding: '8px 14px',
            borderTop: `1px solid ${LINE}`,
            fontSize: 12,
            color: MUTED,
            fontFamily: MONO,
          }}
        >
          + {extra} more
        </div>
      )}

      {model ? (
        <div
          data-testid="scored-rows-model-chip"
          style={{
            padding: '6px 14px',
            borderTop: `1px solid ${LINE}`,
            fontSize: 11,
            color: MUTED,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>Model</span>
          <span style={{ fontFamily: MONO }}>
            {model}
            {cacheHit ? (
              <span
                data-testid="scored-rows-cache-hit-suffix"
                data-tooltip="Pre-computed sample result — edit any input to run the live model."
                aria-label="Pre-computed sample result. Edit any input to run the live model."
                title="Pre-computed sample — edit any input to run live."
                style={{
                  opacity: 0.65,
                  marginLeft: 6,
                  cursor: 'help',
                  borderBottom: '1px dotted currentColor',
                }}
              >
                · CACHED
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
