// CompetitorTiles — slap-level renderer for competitor-analyzer output
// (#643). Replaces the cramped auto-pick table with a stacked tile-per-
// competitor layout. Each tile: company name (display serif) + one-line
// positioning, pricing chip, and a 2x2 strengths/weaknesses grid with
// restrained check / alert glyphs (brand green for strengths, muted
// slate for gaps — NO amber, NO red).
//
// Called from rendererCascade.tsx when the runtime shape looks like
// {competitors: [{company, positioning, strengths, weaknesses, ...}]}.
// Falls back to the existing RowTable + Markdown composite if the
// shape doesn't match.
import { useState } from 'react';
import { Check, AlertCircle } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { Markdown } from './Markdown';

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
const STRENGTH = '#047857';
const GAP = '#6b6f76'; // muted slate, NOT red
const INK = 'var(--ink)';
const MUTED = 'var(--muted)';
const LINE = 'var(--line)';
const CARD = 'var(--card)';

function domainOf(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function FaviconChip({ domain }: { domain: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 16,
        height: 16,
        borderRadius: 4,
        background: 'var(--bg)',
        border: `1px solid ${LINE}`,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <img
        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`}
        alt=""
        loading="lazy"
        width={16}
        height={16}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
        }}
        style={{ display: 'block', width: 16, height: 16, objectFit: 'cover' }}
      />
    </span>
  );
}

function TileBulletList({
  items,
  color,
  icon,
  label,
  max = 4,
}: {
  items: string[];
  color: string;
  icon: 'check' | 'alert';
  label: string;
  max?: number;
}) {
  const Icon = icon === 'check' ? Check : AlertCircle;
  const visible = items.slice(0, max);
  const extra = items.length - visible.length;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          color: MUTED,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      {visible.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTED }}>—</div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {visible.map((item, i) => (
            <li
              key={i}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                fontSize: 13,
                lineHeight: 1.5,
                color: INK,
              }}
            >
              <Icon
                size={13}
                color={color}
                strokeWidth={2}
                style={{ flexShrink: 0, marginTop: 3 }}
                aria-hidden="true"
              />
              <span style={{ minWidth: 0 }}>{item}</span>
            </li>
          ))}
          {extra > 0 && (
            <li
              style={{
                fontSize: 12,
                color: MUTED,
                paddingLeft: 21,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              + {extra} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function CompetitorTile({ tile }: { tile: CompetitorTile }) {
  const domain = domainOf(tile.url);
  const strengths = Array.isArray(tile.strengths)
    ? tile.strengths.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  const weaknesses = Array.isArray(tile.weaknesses)
    ? tile.weaknesses.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
  const positioning =
    typeof tile.positioning === 'string' && tile.positioning.length > 0
      ? tile.positioning
      : null;
  const pricing =
    typeof tile.pricing === 'string' && tile.pricing.length > 0 ? tile.pricing : null;

  return (
    <div
      data-testid={`competitor-tile-${domain ?? tile.company ?? 'row'}`}
      style={{
        background: CARD,
        border: `1px solid ${LINE}`,
        borderRadius: 12,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {/* HEADER: company name + domain link */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
          <div
            className="floom-display"
            style={{
              fontFamily: "'Tiempos Headline', 'Charter', ui-serif, Georgia, serif",
              fontSize: 22,
              fontWeight: 500,
              color: INK,
              letterSpacing: '-0.015em',
              lineHeight: 1.15,
              wordBreak: 'break-word',
            }}
          >
            {tile.company ?? domain ?? 'Competitor'}
          </div>
          {positioning && (
            <div
              style={{
                fontSize: 13,
                color: MUTED,
                lineHeight: 1.5,
                fontStyle: 'normal',
              }}
            >
              {positioning}
            </div>
          )}
        </div>
        {domain && (
          <a
            href={tile.url ?? `https://${domain}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 12,
              color: ACCENT,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              border: `1px solid ${LINE}`,
              borderRadius: 999,
              background: 'var(--bg)',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none';
            }}
          >
            <FaviconChip domain={domain} />
            {domain}
          </a>
        )}
      </div>

      {/* PRICING chip */}
      {pricing && (
        <div
          style={{
            fontSize: 12,
            color: INK,
            padding: '6px 10px',
            background: 'var(--bg)',
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            alignSelf: 'flex-start',
            maxWidth: '100%',
            lineHeight: 1.45,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: MUTED,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Pricing
          </span>
          <span style={{ fontWeight: 500 }}>{pricing}</span>
        </div>
      )}

      {/* 2-COL STRENGTHS / WEAKNESSES grid */}
      <div
        className="competitor-tile-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 20,
          paddingTop: 4,
        }}
      >
        <TileBulletList
          items={strengths}
          color={STRENGTH}
          icon="check"
          label="Strengths"
        />
        <TileBulletList
          items={weaknesses}
          color={GAP}
          icon="alert"
          label="Gaps vs you"
        />
      </div>
    </div>
  );
}

export function CompetitorTiles({
  competitors,
  summary,
  runOutput,
  appSlug: _appSlug,
  runId: _runId,
}: CompetitorTilesProps) {
  const [summaryOpen, setSummaryOpen] = useState(true);
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
  const copyValue = JSON.stringify(
    { competitors, summary, meta: runOutput?.meta },
    null,
    2,
  );

  return (
    <div
      data-renderer="CompetitorTiles"
      className="app-expanded-card floom-slap-output"
      style={{
        padding: 0,
        overflow: 'hidden',
        borderTop: `2px solid ${ACCENT}`,
        background: CARD,
      }}
    >
      {/* HEADER: title + summary meta */}
      <div
        style={{
          padding: '20px 20px 16px',
          borderBottom: `1px solid ${LINE}`,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          background: 'linear-gradient(180deg, rgba(4,120,87,0.03) 0%, transparent 100%)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              color: MUTED,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Competitive landscape
          </div>
          <div
            data-testid="competitor-tiles-summary-line"
            className="floom-display"
            style={{
              fontFamily: "'Tiempos Headline', 'Charter', ui-serif, Georgia, serif",
              fontSize: 26,
              lineHeight: 1.15,
              color: INK,
              fontWeight: 500,
              letterSpacing: '-0.02em',
              marginTop: 4,
            }}
          >
            {total} competitors ·{' '}
            <span style={{ color: STRENGTH, fontWeight: 600 }}>{totalStrengths}</span> strengths
            ·{' '}
            <span style={{ color: GAP, fontWeight: 600 }}>{totalGaps}</span> gaps
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <CopyButton value={copyValue} label="Copy JSON" />
        </div>
      </div>

      {/* SUMMARY — collapsible markdown prose (fold open by default) */}
      {summary && summary.trim().length > 0 && (
        <div
          data-testid="competitor-tiles-summary"
          style={{
            padding: '16px 20px',
            borderBottom: `1px solid ${LINE}`,
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
                marginTop: 10,
                fontSize: 14,
                lineHeight: 1.65,
                color: INK,
              }}
            >
              <Markdown content={summary} />
            </div>
          )}
        </div>
      )}

      {/* TILES — stacked vertically, one per competitor */}
      <div
        style={{
          padding: '16px 16px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          background: 'var(--bg)',
        }}
      >
        {competitors.map((c, i) => (
          <CompetitorTile key={i} tile={c} />
        ))}
      </div>

      {cleanedModel && (
        <div
          data-testid="competitor-tiles-model-chip"
          style={{
            padding: '8px 16px',
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
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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

      {/* Mobile polish — single-column grid on narrow widths */}
      <style>{`
        @media (max-width: 520px) {
          .competitor-tile-grid { grid-template-columns: 1fr !important; gap: 14px !important; }
        }
      `}</style>
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
