// Row table for outputs that are an array of objects with a consistent
// shape (e.g. search results, query rows, schedule). Uses the union of
// keys from the first 10 rows as columns, caps at 50 rows, and shows a
// "+ N more" note below when truncated.
//
// Cell rendering:
//  - strings / numbers / booleans render inline.
//  - `string[]` fields render as a vertical bullet list, truncated with
//    a "+ N more" affordance past STRING_LIST_PREVIEW (the competitor-
//    analyzer `strengths`/`weaknesses`/`source_citations` case, plus the
//    resume-screener `gaps` case). No per-app hardcoding: detection is
//    runtime shape only.
//  - other nested objects/arrays collapse to a one-line JSON preview
//    and expose a "Show raw" disclosure via JsonRaw elsewhere.
import { useState } from 'react';
import { SectionHeader } from './SectionHeader';
import {
  FullscreenButton,
  IconCopyButton,
  IconDownloadButton,
  TableFullscreenModal,
} from './OutputActionBar';

export interface RowTableProps {
  rows: Array<Record<string, unknown>>;
  label?: string;
  maxRows?: number;
  maxCols?: number;
  /**
   * Issue #282: slug + run_id used to name the downloaded CSV, e.g.
   * `lead-scorer-<run_id>.csv`. Optional so legacy callers that don't
   * pass them fall back to a timestamped name.
   */
  appSlug?: string;
  runId?: string;
}

/**
 * Produce an RFC 4180-compliant CSV string from an array of row objects.
 * Exported for stress tests. Column order matches `columns`; values are
 * flattened the same way `renderCell` flattens them for display (nested
 * objects → one-line JSON), so "what you see in the table = what you
 * get in the file". Quoting rules: wrap in `"` when the value contains
 * `"`, `,`, or a newline; escape literal quotes by doubling them.
 */
export function rowsToCsv(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): string {
  const escape = (raw: unknown): string => {
    if (raw === null || raw === undefined) return '';
    let s: string;
    if (typeof raw === 'string') s = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') s = String(raw);
    else s = JSON.stringify(raw);
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const headerLine = columns.map((c) => escape(c)).join(',');
  const bodyLines = rows.map((row) =>
    columns.map((c) => escape(row[c])).join(','),
  );
  return [headerLine, ...bodyLines].join('\r\n');
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveColumns(rows: Array<Record<string, unknown>>, max: number): string[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 10)) {
    for (const k of Object.keys(row)) {
      keys.add(k);
      if (keys.size >= max) return Array.from(keys);
    }
  }
  return Array.from(keys);
}

/**
 * Max bullet items visible before "Show N more" folds the tail. Picked
 * to match the most common LLM output shape for fields like `strengths`
 * / `weaknesses` / `source_citations` / `gaps` (3-5 bullets per row).
 */
const STRING_LIST_PREVIEW = 5;

function isArrayOfStrings(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((item) => typeof item === 'string')
  );
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value);
  }
  if (typeof value === 'string') return value;
  // Nested object / non-string array — collapse to a one-line JSON
  // preview so the table doesn't blow up.
  const s = JSON.stringify(value);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

/**
 * R10 (2026-04-28): wireframe v17 score column. When a column name reads
 * as a numeric score (`score`, `rating`, `grade`, etc.) and the value is
 * a number in [0, 100] OR [0, 10], render a small inline progress bar
 * next to the value. Federico R10 brief: "Numeric scores: render with
 * inline mini-progress-bar (a 0-100 score gets a visual bar)".
 */
function isScoreColumn(columnName: string): boolean {
  const k = columnName.toLowerCase();
  return /^(score|rating|grade|fit|quality|confidence|priority)$/.test(k) || /_score$/.test(k);
}

function ScoreCell({ value }: { value: number }) {
  // Detect 0-10 vs 0-100 scale heuristically — values in [0, 10] (with
  // optional decimal) are the wireframe's preferred scale; everything
  // higher we treat as 0-100. Falls back to plain text if value is out
  // of range so we never show a misleading bar.
  const v = value;
  let pct: number;
  let display: string;
  if (v >= 0 && v <= 10) {
    pct = (v / 10) * 100;
    display = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1);
  } else if (v > 10 && v <= 100) {
    pct = v;
    display = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1);
  } else {
    return <>{formatScalar(v)}</>;
  }
  // Threshold colour: muted (< 50%), accent (>= 50%). Federico locked
  // single accent green palette (no traffic-light reds/yellows).
  const isStrong = pct >= 50;
  return (
    <div
      data-renderer="ScoreCell"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 96,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontWeight: 600,
          fontSize: 12.5,
          color: 'var(--ink)',
          minWidth: 32,
          flexShrink: 0,
        }}
      >
        {display}
      </span>
      <span
        aria-hidden="true"
        style={{
          flex: 1,
          height: 5,
          borderRadius: 999,
          background: 'var(--line)',
          overflow: 'hidden',
          minWidth: 40,
        }}
      >
        <span
          style={{
            display: 'block',
            width: `${Math.max(2, Math.min(100, pct))}%`,
            height: '100%',
            background: isStrong ? 'var(--accent, #047857)' : 'var(--muted)',
            borderRadius: 999,
          }}
        />
      </span>
    </div>
  );
}

/**
 * Cell renderer. Strings / numbers / booleans render as plain text.
 * `string[]` fields — the common LLM-output shape for bullets like
 * `strengths`, `weaknesses`, `source_citations`, `gaps` — render as an
 * inline vertical bullet list instead of a stringified JSON blob. Any
 * other nested value collapses to a one-line JSON preview.
 */
function StringListCell({ items }: { items: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, STRING_LIST_PREVIEW);
  const extra = items.length - visible.length;
  return (
    <div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          lineHeight: 1.5,
        }}
      >
        {visible.map((item, i) => (
          <li key={i} style={{ marginBottom: 2, wordBreak: 'break-word' }}>
            {item}
          </li>
        ))}
      </ul>
      {extra > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            marginTop: 4,
            padding: 0,
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            textDecoration: 'underline',
          }}
        >
          Show {extra} more
        </button>
      )}
      {expanded && items.length > STRING_LIST_PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          style={{
            marginTop: 4,
            padding: 0,
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            textDecoration: 'underline',
          }}
        >
          Show less
        </button>
      )}
    </div>
  );
}

function renderCell(value: unknown, columnName?: string): JSX.Element | string {
  if (isArrayOfStrings(value)) {
    return <StringListCell items={value} />;
  }
  // R10 (2026-04-28): wireframe v17 score column with mini progress bar.
  if (
    columnName &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    isScoreColumn(columnName)
  ) {
    return <ScoreCell value={value} />;
  }
  return formatScalar(value);
}

export function RowTable({ rows, label, maxRows = 50, maxCols = 8, appSlug, runId }: RowTableProps) {
  const visible = rows.slice(0, maxRows);
  const extra = rows.length - visible.length;
  const columns = deriveColumns(visible, maxCols);
  const copyValue = JSON.stringify(rows, null, 2);
  // R7.5 (2026-04-28): per-table fullscreen — Federico's brief.
  const [fullscreen, setFullscreen] = useState(false);

  // Issue #282: biz users want "a scored version of their spreadsheet",
  // not a JSON blob. Generate the CSV from ALL rows (not just the
  // visible slice), so the file is complete even when the table truncates
  // at maxRows. Client-side Blob + anchor download, no new dependency.
  const downloadCsv = () => {
    const csv = rowsToCsv(rows, columns);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const slug = appSlug ?? 'table';
    const suffix = runId ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = `${slug}-${suffix}.csv`;
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    // Firefox needs the anchor in the DOM for the click to trigger.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Release the object URL on the next tick so the download has time
    // to kick off. Not strictly necessary but avoids a mem leak on long
    // sessions where the user downloads many runs.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // R7.5: extracted so the same table body renders inline AND in the
  // fullscreen modal (where the maxHeight cap is removed).
  const tableBody = (capHeight: boolean) => (
    <div style={{ maxHeight: capHeight ? 480 : undefined, overflow: 'auto' }}>
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
            {columns.map((col) => (
              <th
                key={col}
                style={{
                  position: 'sticky',
                  top: 0,
                  background: 'var(--card)',
                  borderBottom: '1px solid var(--line)',
                  textAlign: 'left',
                  padding: '10px 12px',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  fontWeight: 600,
                }}
              >
                {humanizeKey(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => (
            <tr
              key={i}
              style={{
                borderTop: i === 0 ? 'none' : '1px solid var(--line)',
              }}
            >
              {columns.map((col) => (
                <td
                  key={col}
                  style={{
                    padding: '8px 12px',
                    color: 'var(--ink)',
                    wordBreak: 'break-word',
                    verticalAlign: 'top',
                  }}
                >
                  {renderCell(row[col], col)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div
      data-renderer="RowTable"
      className="app-expanded-card floom-output-card"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      <SectionHeader
        label={label ?? 'Rows'}
        hint={label ? `${rows.length} rows` : undefined}
        bordered
        actions={
          <>
            {/* R7.7 — icon buttons (clipboard / download / expand) so the
                composite output card stays scannable. Tooltips on hover. */}
            <IconCopyButton value={copyValue} label="Copy section JSON" />
            <IconDownloadButton
              onClick={downloadCsv}
              label="Download CSV"
              disabled={rows.length === 0}
            />
            <FullscreenButton
              onClick={() => setFullscreen(true)}
              label={`Expand ${label ?? 'table'} to fullscreen`}
            />
          </>
        }
      />
      {tableBody(true)}
      {extra > 0 && (
        <div
          style={{
            padding: '10px 16px',
            borderTop: '1px solid var(--line)',
            fontSize: 12,
            color: 'var(--muted)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          + {extra} more
        </div>
      )}
      {/* R10 (2026-04-28): wireframe v17 — Copy / Download CSV at the
          BOTTOM of the table too. The header sticky toolbar already has
          icon buttons; the wireframe also shows visible labelled buttons
          below the table footer so users finishing a long scroll don't
          have to scroll back up. */}
      {rows.length > 0 && (
        <div
          data-testid="row-table-footer-actions"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '12px 16px',
            borderTop: '1px solid var(--line)',
            background: 'var(--bg)',
            fontSize: 12,
          }}
        >
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: 'var(--muted)',
              letterSpacing: '0.04em',
            }}
          >
            {rows.length === 1 ? '1 row' : `${rows.length.toLocaleString()} rows`}
            {extra > 0 ? ` · ${visible.length} shown` : ''}
          </span>
          <div style={{ display: 'inline-flex', gap: 8 }}>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(copyValue);
                } catch {
                  /* clipboard blocked */
                }
              }}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid var(--line)',
                background: 'var(--card)',
                color: 'var(--ink)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Copy JSON
            </button>
            <button
              type="button"
              onClick={downloadCsv}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid var(--line)',
                background: 'var(--card)',
                color: 'var(--ink)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Download CSV
            </button>
          </div>
        </div>
      )}
      <TableFullscreenModal
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={label ?? 'Rows'}
      >
        {tableBody(false)}
      </TableFullscreenModal>
    </div>
  );
}
