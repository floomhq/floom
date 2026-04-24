// Lead Scorer + Resume Screener renderer. Slap-level polish (2026-04-24,
// #643) with a brand-green 2px top rule, summary line + big display score
// for the top result, score-arc SVG ring per row, tight bullet reasons,
// gold-tinted highlight on the #1 row, favicon chips for source links,
// and sticky Copy/Download controls at the top.
//
// Palette is deliberately restrained: brand green for Strong fit, warm
// tan for Mixed, muted slate for Weak. No amber, no red — the brief was
// "one accent only".
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

// Restrained palette — brand green is the only accent. Mixed uses a
// warm tan (NOT amber/orange), Weak uses muted slate. Matches the
// "one accent" directive and stays kind to colorblind users.
const TIER_STRONG = '#047857'; // brand green
const TIER_MIXED = '#8a6d3b'; // warm tan
const TIER_WEAK = '#6b6f76'; // muted slate
const TOP_HIGHLIGHT_BG = 'rgba(203, 167, 98, 0.10)'; // off-warm tan, NOT yellow
const TOP_HIGHLIGHT_RULE = 'rgba(203, 167, 98, 0.35)';
const ACCENT = '#047857';
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

interface DisplayScore {
  text: string;
  asTen: number;
  raw: number;
  scale: '0-10' | '0-100';
}

function displayScore(
  raw: unknown,
  scale: '0-10' | '0-100',
): DisplayScore | null {
  const n = coerceNumber(raw);
  if (n === null) return null;
  const asTen = scale === '0-100' ? n / 10 : n;
  const clamped = Math.max(0, Math.min(10, asTen));
  const rawClamped =
    scale === '0-100' ? Math.max(0, Math.min(100, n)) : clamped;
  const text =
    scale === '0-100'
      ? String(Math.round(rawClamped))
      : Number.isInteger(clamped)
      ? `${clamped}`
      : clamped.toFixed(1);
  return { text, asTen: clamped, raw: rawClamped, scale };
}

function tierColor(asTen: number): string {
  if (asTen >= 7) return TIER_STRONG;
  if (asTen >= 4) return TIER_MIXED;
  return TIER_WEAK;
}

function tierLabel(asTen: number): string {
  if (asTen >= 7) return 'Strong';
  if (asTen >= 4) return 'Mixed';
  return 'Weak';
}

// Split a prose reason into 2-4 tight bullets. The backend sometimes
// returns "sentence. sentence. sentence." — we prefer bullets because
// (a) they scan in a narrow cell and (b) they screenshot better for
// social shares. Falls back to the single paragraph if we can't find
// enough boundaries.
function toBullets(reason: string): string[] {
  if (!reason) return [];
  const trimmed = reason.trim();
  // Already newline-separated? Use those.
  if (/\n/.test(trimmed)) {
    return trimmed
      .split(/\n+/)
      .map((s) => s.replace(/^[\s·•\-\*]+/, '').trim())
      .filter((s) => s.length > 0)
      .slice(0, 4);
  }
  // Split on periods / semicolons that are followed by a space + capital
  // or "· " separator. Keep it conservative so we don't mangle short
  // one-liners.
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
): { href: string; label: string; domain: string } | null {
  const candidates = preferred ? [preferred, 'website', 'url'] : ['website', 'url'];
  for (const key of candidates) {
    const v = row[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      try {
        const u = new URL(v.startsWith('http') ? v : `https://${v}`);
        const domain = u.hostname.replace(/^www\./, '');
        return { href: u.toString(), label: domain, domain };
      } catch {
        return { href: v, label: v, domain: v };
      }
    }
  }
  return null;
}

// Score arc — SVG ring showing the score as a fraction of the scale.
// Stroke color matches the tier. Kept small and monochrome; the big
// number is the hero, the ring is the restrained reinforcement.
function ScoreRing({ score, size = 36 }: { score: DisplayScore; size?: number }) {
  const r = size / 2 - 3;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, score.asTen / 10));
  const offset = circumference * (1 - pct);
  const color = tierColor(score.asTen);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="var(--line)"
        strokeWidth={3}
      />
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${c} ${c})`}
        style={{ transition: 'stroke-dashoffset .5s ease-out' }}
      />
    </svg>
  );
}

function FaviconChip({ domain }: { domain: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        borderRadius: 3,
        background: 'var(--bg)',
        border: `1px solid ${LINE}`,
        overflow: 'hidden',
        flexShrink: 0,
        verticalAlign: 'text-bottom',
      }}
    >
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`}
        alt=""
        loading="lazy"
        width={14}
        height={14}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
        }}
        style={{ display: 'block', width: 14, height: 14, objectFit: 'cover' }}
      />
    </span>
  );
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
  const cacheHit = runOutput?.cache_hit === true;
  const cleanedModel = rawModel?.replace(/\s*\(cached\)\s*$/i, '');
  const model = cleanedModel;
  const dryRun = runOutput?.dry_run === true;

  // Top result — drives the big display score + "Top: X" summary line.
  const topRow = visible[0];
  const topScore = topRow ? displayScore(topRow.score, score_scale) : null;
  const topCompany = topRow ? pickCompany(topRow, company_key) : null;
  const isResumeShaped =
    appSlug === 'resume-screener' ||
    (topRow && typeof topRow.filename === 'string') ||
    (topRow && typeof topRow.redacted_id === 'string');
  const summaryNoun = isResumeShaped ? 'Top candidate' : 'Top';

  return (
    <div
      data-renderer="ScoredRowsTable"
      className="app-expanded-card floom-slap-output"
      style={{
        padding: 0,
        overflow: 'hidden',
        borderTop: `2px solid ${ACCENT}`,
      }}
    >
      {/* HERO ROW — big display score for the top result. Renders only
          when we actually have a numeric top score. */}
      {topScore && topCompany && topCompany !== '—' && (
        <div
          data-testid="scored-rows-hero"
          style={{
            padding: '20px 20px 16px',
            borderBottom: `1px solid ${LINE}`,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            flexWrap: 'wrap',
            background: 'linear-gradient(180deg, rgba(4,120,87,0.03) 0%, transparent 100%)',
          }}
        >
          <ScoreRing score={topScore} size={72} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
            <div
              data-testid="scored-rows-hero-label"
              style={{
                fontSize: 11,
                color: MUTED,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
            >
              {summaryNoun}
            </div>
            <div
              data-testid="scored-rows-hero-line"
              className="floom-display"
              style={{
                fontFamily:
                  "'Tiempos Headline', 'Charter', ui-serif, Georgia, serif",
                fontSize: 32,
                lineHeight: 1.15,
                color: INK,
                fontWeight: 500,
                letterSpacing: '-0.02em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {topCompany}{' '}
              <span
                data-testid="scored-rows-hero-score"
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  color: tierColor(topScore.asTen),
                  fontWeight: 600,
                }}
              >
                {topScore.scale === '0-100' ? `${topScore.text}/100` : `${topScore.text}/10`}
              </span>{' '}
              <span
                style={{
                  color: tierColor(topScore.asTen),
                  fontSize: 18,
                  fontWeight: 600,
                  letterSpacing: 0,
                }}
              >
                · {tierLabel(topScore.asTen)} fit
              </span>
            </div>
          </div>
        </div>
      )}

      {/* STICKY ACTION BAR — Copy + Download stay visible on scroll in
          long output columns. The meta chips (Total/Scored/Failed) live
          here too so nothing competes with the hero line above. */}
      <div
        style={{
          padding: '12px 16px',
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
          backdropFilter: 'saturate(1.05)',
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

      <div style={{ maxHeight: 640, overflow: 'auto' }}>
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
                    fontSize: 11,
                    fontWeight: 600,
                    color: MUTED,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
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
              const isTop = i === 0 && !!score;
              const bullets = toBullets(reason);
              return (
                <tr
                  key={i}
                  data-testid={`scored-rows-row-${i}`}
                  data-top={isTop ? 'true' : undefined}
                  style={{
                    borderTop: i === 0 ? 'none' : `1px solid ${LINE}`,
                    opacity: isError ? 0.6 : 1,
                    background: isTop ? TOP_HIGHLIGHT_BG : undefined,
                    boxShadow: isTop
                      ? `inset 3px 0 0 ${TOP_HIGHLIGHT_RULE}`
                      : undefined,
                  }}
                >
                  <td
                    style={{
                      padding: '12px 12px',
                      color: INK,
                      fontWeight: 600,
                      verticalAlign: 'top',
                      width: '20%',
                      wordBreak: 'break-word',
                    }}
                  >
                    {company}
                  </td>
                  <td
                    style={{
                      padding: '12px 12px',
                      paddingLeft: 16,
                      color: INK,
                      verticalAlign: 'middle',
                      fontVariantNumeric: 'tabular-nums',
                      width: 110,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {score ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <ScoreRing score={score} size={36} />
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'baseline',
                            gap: 2,
                          }}
                        >
                          <span
                            style={{
                              fontSize: 18,
                              fontWeight: 600,
                              color: tierColor(score.asTen),
                            }}
                          >
                            {score.text}
                          </span>
                          <span style={{ color: MUTED, fontSize: 11 }}>
                            /{score.scale === '0-100' ? '100' : '10'}
                          </span>
                        </span>
                      </span>
                    ) : (
                      <span style={{ color: MUTED }}>—</span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '12px 12px',
                      verticalAlign: 'middle',
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
                          color: tierColor(score.asTen),
                        }}
                      >
                        <span
                          aria-hidden
                          style={{
                            display: 'inline-block',
                            width: 6,
                            height: 16,
                            borderRadius: 2,
                            background: tierColor(score.asTen),
                          }}
                        />
                        {tierLabel(score.asTen)}
                      </span>
                    ) : (
                      <span style={{ color: MUTED, fontSize: 12 }}>
                        {typeof row.status === 'string' ? row.status : '—'}
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '12px 12px',
                      color: INK,
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                    }}
                  >
                    {bullets.length >= 2 ? (
                      <ul
                        data-testid={`scored-rows-bullets-${i}`}
                        style={{
                          margin: 0,
                          padding: 0,
                          listStyle: 'none',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                        }}
                      >
                        {bullets.map((b, j) => (
                          <li
                            key={j}
                            style={{
                              position: 'relative',
                              paddingLeft: 14,
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
                                width: 4,
                                height: 4,
                                borderRadius: '50%',
                                background: MUTED,
                              }}
                            />
                            {b}
                          </li>
                        ))}
                      </ul>
                    ) : bullets[0] ? (
                      <span style={{ fontSize: 13, lineHeight: 1.5 }}>{bullets[0]}</span>
                    ) : (
                      <span style={{ color: MUTED }}>—</span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '12px 12px',
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
                          color: ACCENT,
                          textDecoration: 'none',
                          fontSize: 13,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.textDecoration = 'underline';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.textDecoration = 'none';
                        }}
                      >
                        <FaviconChip domain={source.domain} />
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

      {/* Mobile polish — score cells stack under the company name on
          narrow widths so nothing truncates to unreadable. */}
      <style>{`
        @media (max-width: 520px) {
          .floom-slap-output table { font-size: 13px; }
          .floom-slap-output thead { display: none; }
          .floom-slap-output tbody tr {
            display: grid;
            grid-template-columns: 1fr auto;
            grid-template-areas:
              "company score"
              "fit fit"
              "why why"
              "source source";
            gap: 4px 12px;
            padding: 10px 12px;
            border-top: 1px solid var(--line);
          }
          .floom-slap-output tbody tr td { padding: 2px 0 !important; border: 0 !important; }
          .floom-slap-output tbody tr td:nth-child(1) { grid-area: company; width: auto !important; }
          .floom-slap-output tbody tr td:nth-child(2) { grid-area: score; padding-left: 0 !important; }
          .floom-slap-output tbody tr td:nth-child(3) { grid-area: fit; }
          .floom-slap-output tbody tr td:nth-child(4) { grid-area: why; }
          .floom-slap-output tbody tr td:nth-child(5) { grid-area: source; width: auto !important; }
        }
      `}</style>
    </div>
  );
}
