// Lead Scorer renderer: promotes the scored rows table to the primary
// output instead of falling back to a single `model` string card.
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

const RAIL_GREEN = '#047857';
const RAIL_AMBER = '#b25e04';
const RAIL_RED = '#c44a2b';
const INK = 'var(--ink)';
const MUTED = 'var(--muted)';
const LINE = 'var(--line)';
const CARD = 'var(--card)';

function coerceNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function displayScore(
  raw: unknown,
  scale: '0-10' | '0-100',
): { text: string; asTen: number } | null {
  const n = coerceNumber(raw);
  if (n === null) return null;
  const asTen = scale === '0-100' ? n / 10 : n;
  const clamped = Math.max(0, Math.min(10, asTen));
  const text = Number.isInteger(clamped) ? `${clamped}` : clamped.toFixed(1);
  return { text, asTen: clamped };
}

function railColor(asTen: number): string {
  if (asTen >= 7) return RAIL_GREEN;
  if (asTen >= 4) return RAIL_AMBER;
  return RAIL_RED;
}

function railLabel(asTen: number): string {
  if (asTen >= 7) return 'Strong';
  if (asTen >= 4) return 'Mixed';
  return 'Weak';
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

function metaChip(label: string, value: unknown): JSX.Element | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
  return (
    <span
      key={label}
      style={{
        fontSize: 11,
        color: MUTED,
        padding: '3px 8px',
        border: `1px solid ${LINE}`,
        borderRadius: 999,
        background: CARD,
        fontFamily: 'inherit',
      }}
    >
      <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>{' '}
      <span style={{ color: INK, fontWeight: 600 }}>{text}</span>
    </span>
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
  // Phase B (#533) ships pre-generated Pro responses for the demo sample inputs
  // so /p/:slug feels instant. The chip must say so — viewers were reading
  // "GEMINI-3.1-PRO-PREVIEW" as live-Pro inference and assuming Floom defaults
  // to Pro (it defaults to Flash). `cache_hit` is the truthful signal from
  // main.py; some older fixtures already stamp " (cached)" into the model
  // string itself, so we strip that before re-appending to avoid double-suffix.
  const cacheHit = runOutput?.cache_hit === true;
  const cleanedModel = rawModel?.replace(/\s*\(cached\)\s*$/i, '');
  const model = cleanedModel;
  const dryRun = runOutput?.dry_run === true;

  return (
    <div
      data-renderer="ScoredRowsTable"
      className="app-expanded-card"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      <div
        style={{
          padding: '14px 16px',
          borderBottom: `1px solid ${LINE}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div
            style={{
              fontSize: 13,
              color: INK,
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            {label ?? `${rows.length} scored`}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {metaChip('Total', total)}
            {metaChip('Scored', scored)}
            {metaChip('Failed', failed)}
            {dryRun ? metaChip('Mode', 'Dry run') : null}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            data-testid="scored-rows-download-csv"
            onClick={downloadCsv}
            disabled={rows.length === 0}
            style={{
              fontSize: 12,
              padding: '5px 10px',
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

      <div style={{ maxHeight: 560, overflow: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 14,
            lineHeight: 1.55,
          }}
        >
          <thead>
            <tr>
              {['Company', 'Score', 'Fit', 'Why', 'Source'].map((h, i) => (
                <th
                  key={h}
                  style={{
                    position: 'sticky',
                    top: 0,
                    background: CARD,
                    borderBottom: `1px solid ${LINE}`,
                    textAlign: 'left',
                    padding: '10px 12px',
                    fontSize: 13,
                    fontWeight: 600,
                    color: MUTED,
                    letterSpacing: '0.02em',
                    whiteSpace: 'nowrap',
                    paddingLeft: i === 1 ? 16 : 12,
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
              return (
                <tr
                  key={i}
                  style={{
                    borderTop: i === 0 ? 'none' : `1px solid ${LINE}`,
                    opacity: isError ? 0.6 : 1,
                  }}
                >
                  <td
                    style={{
                      padding: '10px 12px',
                      color: INK,
                      fontWeight: 600,
                      verticalAlign: 'top',
                      width: '22%',
                      wordBreak: 'break-word',
                    }}
                  >
                    {company}
                  </td>
                  <td
                    style={{
                      padding: '10px 12px',
                      paddingLeft: 16,
                      color: INK,
                      verticalAlign: 'top',
                      fontVariantNumeric: 'tabular-nums',
                      width: 72,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {score ? (
                      <>
                        <span style={{ fontWeight: 600 }}>{score.text}</span>
                        <span style={{ color: MUTED, marginLeft: 2 }}>/10</span>
                      </>
                    ) : (
                      <span style={{ color: MUTED }}>—</span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '10px 12px',
                      verticalAlign: 'top',
                      width: 96,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {score ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 12,
                          fontWeight: 600,
                          color: railColor(score.asTen),
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            display: 'inline-block',
                            width: 6,
                            height: 16,
                            borderRadius: 2,
                            background: railColor(score.asTen),
                          }}
                        />
                        {railLabel(score.asTen)}
                      </span>
                    ) : (
                      <span style={{ color: MUTED, fontSize: 12 }}>
                        {typeof row.status === 'string' ? row.status : '—'}
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '10px 12px',
                      color: INK,
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                    }}
                  >
                    {reason || <span style={{ color: MUTED }}>—</span>}
                  </td>
                  <td
                    style={{
                      padding: '10px 12px',
                      verticalAlign: 'top',
                      width: '18%',
                      wordBreak: 'break-word',
                    }}
                  >
                    {source ? (
                      <a
                        href={source.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: RAIL_GREEN,
                          textDecoration: 'none',
                          fontSize: 13,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.textDecoration = 'underline';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.textDecoration = 'none';
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
            padding: '10px 16px',
            borderTop: `1px solid ${LINE}`,
            fontSize: 12,
            color: MUTED,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          + {extra} more
        </div>
      )}

      {model ? (
        <div
          data-testid="scored-rows-model-chip"
          style={{
            padding: '8px 16px',
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
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {model}
            {cacheHit ? (
              <span
                data-testid="scored-rows-cache-hit-suffix"
                style={{ opacity: 0.65, marginLeft: 6 }}
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
