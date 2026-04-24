// SampleOutputPreview — idle-state "shape of the output" preview for
// /p/:slug.
//
// Federico 2026-04-24: the app page's right column at idle used to
// read as dead space — "Total Rows will appear here / Fill in the form
// and press Run" plus a tiny `{...}` placeholder. This component
// replaces that with a faint, monospace preview of what the app
// actually returns (sample Lead Scorer rows, sample resume scores,
// sample competitor rows) so the visitor sees the SHAPE of the run
// before pressing Run. Muted color, wrapped in a subtle card, clearly
// labeled "example output · not yours".
//
// Only hero / demo apps get a curated sample. Unknown apps fall
// through to the generic skeleton below (so we don't render a
// misleading fake preview for apps whose output we don't know).

import { type CSSProperties } from 'react';

/**
 * Static sample outputs per slug. ASCII-ish: aligned columns in a
 * monospace <pre>, with muted color + subtle border. Kept short (3-5
 * rows) so the idle-state panel doesn't overflow and feel cramped.
 *
 * If the set of launch showcase apps changes, add an entry here — a
 * null entry makes the component render nothing (not a broken
 * "undefined" label), which is the intended fallback.
 */
type SampleRow = { cells: string[]; accent?: boolean };
type Sample = { header: string[]; rows: SampleRow[]; footnote: string };

const SAMPLES: Record<string, Sample | undefined> = {
  'lead-scorer': {
    header: ['Company', 'Score', 'Fit'],
    rows: [
      { cells: ['Stripe', '87/100', 'Strong'], accent: true },
      { cells: ['Vercel', '72/100', 'Mixed'] },
      { cells: ['Figma', '61/100', 'Mixed'] },
      { cells: ['Squarespace', '24/100', 'Weak'] },
      { cells: ['…', '…', '…'] },
    ],
    footnote: 'one row per lead · fit score + reasoning',
  },
  'resume-screener': {
    // Columns chosen to fit the 380-420px right column at 11.5px
    // mono without horizontal scroll. "Why" lives in the footnote
    // rather than a fourth column.
    header: ['Rank', 'Candidate', 'Score'],
    rows: [
      { cells: ['1', 'Alice — Backend', '92/100'], accent: true },
      { cells: ['2', 'Bob — Full-stack', '78/100'] },
      { cells: ['3', 'Dirk — Python', '85/100'] },
      { cells: ['…', '…', '…'] },
    ],
    footnote: 'ranked shortlist · pass/fail + one-line reason per pick',
  },
  'competitor-analyzer': {
    // 2 cols: company + one-line takeaway. Kept short so the row
    // fits ~40 chars total at 11.5px mono in a ~380px panel.
    header: ['Company', 'Takeaway'],
    rows: [
      { cells: ['stripe.com', 'Dev payments'], accent: true },
      { cells: ['n8n.io', 'OSS workflows'] },
      { cells: ['zapier.com', 'No-code auto'] },
      { cells: ['…', '…'] },
    ],
    footnote: '3 competitors · positioning, strengths, gaps',
  },
};

export interface SampleOutputPreviewProps {
  slug: string;
  /**
   * Optional class-name override. Default wraps the preview in a
   * muted card matching the EmptyOutputCard's container; callers that
   * already render their own card should pass an empty string.
   */
  className?: string;
}

export function SampleOutputPreview({ slug, className }: SampleOutputPreviewProps) {
  const sample = SAMPLES[slug];
  if (!sample) return null;

  // Compute per-column max widths for the ASCII alignment. JetBrains
  // Mono has near-uniform advance, so padEnd to the longest cell per
  // column gives a tidy grid without measuring glyph widths.
  const colCount = sample.header.length;
  const maxWidths: number[] = new Array(colCount).fill(0);
  for (let c = 0; c < colCount; c++) {
    maxWidths[c] = Math.max(
      sample.header[c].length,
      ...sample.rows.map((r) => (r.cells[c] ?? '').length),
    );
  }

  const padCell = (s: string, col: number): string => {
    const target = maxWidths[col];
    // Use non-breaking spaces for alignment inside <pre> so browsers
    // don't collapse leading/trailing spaces, which would fracture
    // column alignment at narrow widths.
    return (s + ' '.repeat(Math.max(0, target - s.length)));
  };

  const separator = (ch: string): string =>
    maxWidths.map((w) => ch.repeat(w)).join(`${ch} ${ch} ${ch}`);

  const headerLine = sample.header
    .map((h, c) => padCell(h.toUpperCase(), c))
    .join('  ');
  const rowLines = sample.rows.map((r) =>
    r.cells.map((cell, c) => padCell(cell, c)).join('  '),
  );

  const wrapStyle: CSSProperties = {
    margin: 0,
    padding: '14px 16px',
    borderRadius: 10,
    background: '#f5f5f3', // warm light neutral — matches card polish
    border: '1px solid var(--line)',
    color: '#8a8580', // muted, clearly "not real data"
    fontFamily: "'JetBrains Mono', ui-monospace, 'Courier New', monospace",
    fontSize: 11.5,
    lineHeight: 1.7,
    overflow: 'auto',
    // Keep at 100% of container; panel column decides the overall
    // width. Monospace means cells align as long as the row fits.
  };

  return (
    <div className={className ?? ''} data-testid="sample-output-preview">
      <div
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 10.5,
          color: 'var(--muted)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        Example output · not yours
      </div>
      <pre style={wrapStyle} aria-hidden="true">
        <span style={{ color: '#1b1a17', fontWeight: 600 }}>{headerLine}</span>
        {'\n'}
        <span style={{ color: 'var(--line)' }}>{separator('─')}</span>
        {rowLines.map((line, i) => {
          const row = sample.rows[i];
          return (
            <span
              key={i}
              style={{
                display: 'block',
                color: row.accent ? '#1b1a17' : '#8a8580',
                fontWeight: row.accent ? 500 : 400,
              }}
            >
              {line}
            </span>
          );
        })}
      </pre>
      <div
        style={{
          marginTop: 8,
          fontSize: 12,
          color: 'var(--muted)',
          lineHeight: 1.5,
        }}
      >
        {sample.footnote}
      </div>
    </div>
  );
}

/**
 * Whether a sample exists for the given slug. Used by EmptyOutputCard
 * to decide between the rich per-slug preview and the generic
 * skeleton fallback.
 */
export function hasSampleForSlug(slug: string): boolean {
  return SAMPLES[slug] !== undefined;
}
