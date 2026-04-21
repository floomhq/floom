// Row table for outputs that are an array of objects with a consistent
// shape (e.g. search results, query rows, schedule). Uses the union of
// keys from the first 10 rows as columns, caps at 50 rows, and shows a
// "+ N more" note below when truncated.
//
// Values render as text. Nested objects/arrays collapse to a one-line
// JSON preview — if you need to inspect nested structure, use the
// JsonRaw fallback's "Show raw" disclosure.
import { CopyButton } from './CopyButton';

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

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value);
  }
  if (typeof value === 'string') return value;
  // Nested — collapse to a one-line JSON preview so the table doesn't
  // blow up.
  const s = JSON.stringify(value);
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

export function RowTable({ rows, label, maxRows = 50, maxCols = 8, appSlug, runId }: RowTableProps) {
  const visible = rows.slice(0, maxRows);
  const extra = rows.length - visible.length;
  const columns = deriveColumns(visible, maxCols);
  const copyValue = JSON.stringify(rows, null, 2);

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

  return (
    <div
      data-renderer="RowTable"
      className="app-expanded-card"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          {label ?? `${rows.length} rows`}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            data-testid="row-table-download-csv"
            onClick={downloadCsv}
            disabled={rows.length === 0}
            style={{
              fontSize: 12,
              padding: '5px 10px',
              border: '1px solid var(--line)',
              background: 'var(--card)',
              color: 'var(--ink)',
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
      <div style={{ maxHeight: 480, overflow: 'auto' }}>
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
                    {renderCell(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    </div>
  );
}
