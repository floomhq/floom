// CompetitorTiles — compact table renderer for competitor-analyzer output.
//
// Rewritten 2026-04-24 (PR #661 follow-up) to match the same philosophy
// shift Lead Scorer's ScoredRowsTable took in PR #702: Floom apps produce
// JSON; the UI renders it with simple primitives. Bespoke per-app cards
// (serif "COMPETITIVE LANDSCAPE" hero, favicon chips, 2x2 strengths/gaps
// grids, gradient backgrounds) don't scale across 3 AI apps, and the
// CSV/JSON/markdown downloads are the source of truth. The UI should be
// a compact table, not ornamentation.
//
// Columns: Competitor · Strengths · Gaps · Source. Strengths and Gaps
// collapse to a 2-line preview that click-expands to a bulleted list.
// Strategic summary stays as a collapsible block below the table,
// collapsed by default. Download CSV + Copy JSON + Copy markdown kept as
// the primary outputs.
//
// Called from rendererCascade.tsx when the runtime shape looks like
// {competitors: [{company, positioning, strengths, weaknesses, ...}]}.
// Falls back to the existing RowTable + Markdown composite if the
// shape doesn't match.
import { useState } from 'react';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';
import { rowsToCsv } from './RowTable';

export interface CompetitorTile {
  url?: string;
  company?: string;
  positioning?: string;
  pricing?: string;
  target_market?: string;
  strengths?: string[];
  weaknesses?: string[];
  source_citations?: string[];
  [key: string]: unknown;
}

export interface CompetitorTilesProps {
  competitors: CompetitorTile[];
  summary?: string;
  runOutput?: Record<string, unknown>;
  appSlug?: string;
  runId?: string;
}

const ACCENT = '#047857';
const INK = 'var(--ink)';
const MUTED = 'var(--muted)';
const LINE = 'var(--line)';
const CARD = 'var(--card)';
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

function domainOf(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function BulletCell({
  items,
  index,
  column,
}: {
  items: string[];
  index: number;
  column: 'strengths' | 'gaps';
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return <span style={{ color: MUTED }}>—</span>;
  if (items.length === 1) {
    return <span style={{ fontSize: 13, lineHeight: 1.5 }}>{items[0]}</span>;
  }
  if (!expanded) {
    const preview = items.join(' · ');
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded="false"
        aria-label={`Expand ${items.length} ${column}`}
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
      data-testid={`competitor-${column}-bullets-${index}`}
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
      {items.map((b, j) => (
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

function buildMarkdown(
  competitors: CompetitorTile[],
  summary: string | undefined,
): string {
  const lines: string[] = [];
  for (const c of competitors) {
    const name = c.company ?? domainOf(c.url) ?? 'Competitor';
    lines.push(`## ${name}`);
    if (c.positioning) lines.push(c.positioning);
    if (c.pricing) lines.push(`**Pricing:** ${c.pricing}`);
    if (Array.isArray(c.strengths) && c.strengths.length > 0) {
      lines.push('**Strengths:**');
      for (const s of c.strengths) lines.push(`- ${s}`);
    }
    if (Array.isArray(c.weaknesses) && c.weaknesses.length > 0) {
      lines.push('**Gaps:**');
      for (const w of c.weaknesses) lines.push(`- ${w}`);
    }
    if (c.url) lines.push(`Source: ${c.url}`);
    lines.push('');
  }
  if (summary && summary.trim().length > 0) {
    lines.push('## Strategic summary');
    lines.push(summary);
  }
  return lines.join('\n');
}

export function CompetitorTiles({
  competitors,
  summary,
  runOutput,
  appSlug,
  runId,
}: CompetitorTilesProps) {
  const [summaryOpen, setSummaryOpen] = useState(false);
  const total = competitors.length;
  const totalStrengths = competitors.reduce(
    (acc, t) => acc + (Array.isArray(t.strengths) ? t.strengths.length : 0),
    0,
  );
  const totalGaps = competitors.reduce(
    (acc, t) => acc + (Array.isArray(t.weaknesses) ? t.weaknesses.length : 0),
    0,
  );
  const rawModel =
    typeof runOutput?.meta === 'object' && runOutput?.meta
      ? ((runOutput.meta as Record<string, unknown>).model as string | undefined)
      : undefined;
  const cacheHit =
    typeof runOutput?.meta === 'object' && runOutput?.meta
      ? (runOutput.meta as Record<string, unknown>).cache_hit === true
      : false;
  const cleanedModel = rawModel?.replace(/\s*\(cached\)\s*$/i, '');
  const copyJsonValue = JSON.stringify(
    { competitors, summary, meta: runOutput?.meta },
    null,
    2,
  );
  const copyMarkdownValue = buildMarkdown(competitors, summary);

  const csvColumns = ['company', 'url', 'positioning', 'pricing', 'strengths', 'gaps'];
  const downloadCsv = () => {
    const normalized = competitors.map((c) => ({
      company: c.company ?? domainOf(c.url) ?? '',
      url: c.url ?? '',
      positioning: c.positioning ?? '',
      pricing: c.pricing ?? '',
      strengths: Array.isArray(c.strengths) ? c.strengths.join(' | ') : '',
      gaps: Array.isArray(c.weaknesses) ? c.weaknesses.join(' | ') : '',
    }));
    const csv = rowsToCsv(normalized, csvColumns);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const slug = appSlug ?? 'competitors';
    const suffix = runId ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}-${suffix}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div
      data-renderer="CompetitorTiles"
      className="floom-scored-output"
      style={{
        padding: 0,
        overflow: 'hidden',
        border: `1px solid ${LINE}`,
        borderRadius: 8,
        background: CARD,
      }}
    >
      {/* Sticky action bar: summary counts + Copy JSON + Copy markdown + Download CSV */}
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
        <div
          data-testid="competitor-tiles-summary-line"
          style={{ fontSize: 12, color: MUTED, fontFamily: MONO }}
        >
          {total} competitors · {totalStrengths} strengths · {totalGaps} gaps
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            data-testid="competitor-tiles-download-csv"
            onClick={downloadCsv}
            disabled={competitors.length === 0}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              border: `1px solid ${LINE}`,
              background: CARD,
              color: INK,
              borderRadius: 6,
              cursor: competitors.length === 0 ? 'not-allowed' : 'pointer',
              opacity: competitors.length === 0 ? 0.5 : 1,
              fontFamily: 'inherit',
            }}
          >
            Download CSV
          </button>
          <CopyButton value={copyMarkdownValue} label="Copy markdown" />
          <CopyButton value={copyJsonValue} label="Copy JSON" />
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
              {['Competitor', 'Strengths', 'Gaps vs you', 'Source'].map((h) => (
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
            {competitors.map((c, i) => {
              const strengths = Array.isArray(c.strengths)
                ? c.strengths.filter((s): s is string => typeof s === 'string' && s.length > 0)
                : [];
              const weaknesses = Array.isArray(c.weaknesses)
                ? c.weaknesses.filter((s): s is string => typeof s === 'string' && s.length > 0)
                : [];
              const domain = domainOf(c.url);
              const displayName = c.company ?? domain ?? 'Competitor';
              return (
                <tr
                  key={i}
                  data-testid={`competitor-tile-${domain ?? c.company ?? `row-${i}`}`}
                  style={{
                    borderTop: i === 0 ? 'none' : `1px solid ${LINE}`,
                  }}
                >
                  <td
                    style={{
                      padding: '8px 10px',
                      color: INK,
                      fontWeight: 500,
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                      width: 160,
                    }}
                  >
                    <div>{displayName}</div>
                    {c.positioning ? (
                      <div style={{ fontSize: 12, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>
                        {c.positioning}
                      </div>
                    ) : null}
                    {c.pricing ? (
                      <div
                        style={{
                          fontSize: 11,
                          color: MUTED,
                          marginTop: 2,
                          fontFamily: MONO,
                        }}
                      >
                        {c.pricing}
                      </div>
                    ) : null}
                  </td>
                  <td
                    style={{
                      padding: '8px 10px',
                      color: INK,
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                    }}
                  >
                    <BulletCell items={strengths} index={i} column="strengths" />
                  </td>
                  <td
                    style={{
                      padding: '8px 10px',
                      color: INK,
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                    }}
                  >
                    <BulletCell items={weaknesses} index={i} column="gaps" />
                  </td>
                  <td
                    style={{
                      padding: '8px 10px',
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                      width: 160,
                    }}
                  >
                    {domain ? (
                      <a
                        href={c.url ?? `https://${domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: ACCENT,
                          textDecoration: 'none',
                          fontSize: 13,
                        }}
                      >
                        {domain}
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

      {/* Strategic summary — collapsed by default. Click to expand. */}
      {summary && summary.trim().length > 0 && (
        <div
          data-testid="competitor-tiles-summary"
          style={{
            padding: '10px 14px',
            borderTop: `1px solid ${LINE}`,
            background: 'var(--bg)',
          }}
        >
          <button
            type="button"
            onClick={() => setSummaryOpen((v) => !v)}
            aria-expanded={summaryOpen}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: 0,
              background: 'transparent',
              border: 0,
              color: MUTED,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>
              {summaryOpen ? '−' : '+'}
            </span>
            Strategic summary
          </button>
          {summaryOpen && (
            <div
              style={{
                marginTop: 8,
                fontSize: 13,
                lineHeight: 1.6,
                color: INK,
              }}
            >
              <Markdown content={summary} />
            </div>
          )}
        </div>
      )}

      {cleanedModel && (
        <div
          data-testid="competitor-tiles-model-chip"
          style={{
            padding: '6px 14px',
            borderTop: `1px solid ${LINE}`,
            fontSize: 11,
            color: MUTED,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            display: 'flex',
            justifyContent: 'space-between',
            background: CARD,
          }}
        >
          <span>Model</span>
          <span style={{ fontFamily: MONO }}>
            {cleanedModel}
            {cacheHit ? (
              <span
                data-testid="competitor-tiles-cache-hit-suffix"
                style={{ opacity: 0.65, marginLeft: 6 }}
              >
                · CACHED
              </span>
            ) : null}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Shape check: does this runOutput look like a competitor-analyzer
 * response? Used by rendererCascade.tsx to route straight to
 * CompetitorTiles before the generic composite path fires.
 */
export function looksLikeCompetitorOutput(runOutput: unknown): boolean {
  if (!runOutput || typeof runOutput !== 'object') return false;
  const obj = runOutput as Record<string, unknown>;
  const c = obj.competitors;
  if (!Array.isArray(c) || c.length === 0) return false;
  const first = c[0];
  if (!first || typeof first !== 'object') return false;
  const row = first as Record<string, unknown>;
  // Require at least one of the identifying fields. Keeps us from
  // hijacking unrelated "competitors"-named arrays.
  const hasPositioning = typeof row.positioning === 'string';
  const hasStrengths = Array.isArray(row.strengths);
  const hasWeaknesses = Array.isArray(row.weaknesses);
  return hasPositioning || hasStrengths || hasWeaknesses;
}
