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
import { useEffect, useState } from 'react';
import { CopyButton } from './CopyButton';
import { SectionHeader } from './SectionHeader';
import { ExpandIcon } from '../Icons';

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

function renderCell(value: unknown): JSX.Element | string {
  if (isArrayOfStrings(value)) {
    return <StringListCell items={value} />;
  }
  return formatScalar(value);
}

function BaseTable({ columns, rows }: { columns: string[]; rows: Array<Record<string, unknown>> }) {
  return (
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
                zIndex: 1,
              }}
            >
              {humanizeKey(col)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
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
  );
}

export function RowTable({ rows, label, maxRows = 50, maxCols = 8, appSlug, runId }: RowTableProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const visible = rows.slice(0, maxRows);
  const extra = rows.length - visible.length;
  const columns = deriveColumns(visible, maxCols);
  const copyValue = JSON.stringify(rows, null, 2);

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
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const actionButtons = (
    <>
      <button
        type="button"
        className="output-copy-btn"
        onClick={() => setIsExpanded(true)}
        title="Expand to full screen"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
        }}
      >
        <ExpandIcon size={12} />
        Expand
      </button>
      <button
        type="button"
        data-testid="row-table-download-csv"
        className="output-copy-btn"
        onClick={downloadCsv}
        disabled={rows.length === 0}
        style={{
          cursor: rows.length === 0 ? 'not-allowed' : 'pointer',
          opacity: rows.length === 0 ? 0.5 : 1,
        }}
      >
        Download CSV
      </button>
      <CopyButton value={copyValue} label="Copy JSON" />
    </>
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
        actions={actionButtons}
      />
      <div style={{ maxHeight: 480, overflow: 'auto' }}>
        <BaseTable columns={columns} rows={visible} />
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

      {isExpanded && (
        <TableExpandModal
          label={label ?? 'Rows'}
          rows={rows}
          columns={deriveColumns(rows, 20)} // Show up to 20 columns in expanded view
          onClose={() => setIsExpanded(false)}
          downloadCsv={downloadCsv}
          copyValue={copyValue}
        />
      )}
    </div>
  );
}

function TableExpandModal({
  label,
  rows,
  columns,
  onClose,
  downloadCsv,
  copyValue,
}: {
  label: string;
  rows: Array<Record<string, unknown>>;
  columns: string[];
  onClose: () => void;
  downloadCsv: () => void;
  copyValue: string;
}) {
  // Close on Escape
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  // Prevent body scroll
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow || 'unset';
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        backdropFilter: 'blur(2px)',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 16,
          width: '95vw',
          maxWidth: 1400,
          maxHeight: '90vh',
          boxShadow: '0 24px 64px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <SectionHeader
          label={label}
          hint={`${rows.length} rows`}
          bordered
          actions={
            <>
              <button
                type="button"
                className="output-copy-btn"
                onClick={downloadCsv}
                disabled={rows.length === 0}
              >
                Download CSV
              </button>
              <CopyButton value={copyValue} label="Copy JSON" />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--muted)',
                  fontSize: 24,
                  cursor: 'pointer',
                  padding: '0 4px',
                  lineHeight: 1,
                  marginLeft: 4,
                }}
              >
                ×
              </button>
            </>
          }
        />
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
          <BaseTable columns={columns} rows={rows} />
        </div>
      </div>
    </div>
  );
}
