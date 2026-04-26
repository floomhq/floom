// Two-column key/value table for objects with a handful of fields.
// Replaces the old "dump as JSON" path for the common shape where a
// creator returns `{password: "...", alphabet_size: 62, entropy_bits: 119}`
// — three fields, mixed types, clearly a key/value breakdown.
//
// Nested values (objects / arrays) are rendered compactly (a one-line
// preview with a "Show" disclosure that expands to a pretty JSON block).
// Plain scalars render inline.
import { useState } from 'react';
import { CopyButton } from './CopyButton';
import { SectionHeader } from './SectionHeader';
import { StringList } from './StringList';

function isArrayOfStrings(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((item) => typeof item === 'string')
  );
}

export interface KeyValueTableProps {
  entries: Array<[string, unknown]>;
  label?: string;
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderScalar(value: unknown): string {
  if (value === null) return '—';
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value)
      ? value.toLocaleString('en-US')
      : String(value);
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function isNested(value: unknown): value is object {
  return (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date)
  );
}

export function KeyValueTable({ entries, label }: KeyValueTableProps) {
  const allJson = JSON.stringify(
    Object.fromEntries(entries),
    null,
    2,
  );

  return (
    <div
      data-renderer="KeyValueTable"
      className="app-expanded-card floom-output-card"
      style={{ position: 'relative' }}
    >
      <SectionHeader
        label={label ?? 'Result'}
        actions={<CopyButton value={allJson} label="Copy JSON" />}
      />
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
          lineHeight: 1.55,
          tableLayout: 'fixed',
        }}
      >
        <tbody>
          {entries.map(([key, value], i) => (
            <Row key={key + i} k={key} v={value} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ k, v }: { k: string; v: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const stringList = isArrayOfStrings(v);
  const nested = !stringList && isNested(v);

  return (
    <tr style={{ borderTop: '1px solid var(--line)' }}>
      <td
        style={{
          padding: '8px 12px 8px 0',
          color: 'var(--muted)',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          verticalAlign: 'top',
          width: '40%',
          maxWidth: 200,
          wordBreak: 'break-word',
        }}
      >
        {humanizeKey(k)}
      </td>
      <td
        style={{
          padding: '8px 0',
          color: 'var(--ink)',
          wordBreak: 'break-word',
        }}
      >
        {stringList ? (
          // Inline bullet list for `string[]` fields — no click-to-expand
          // needed for short lists. Reuses the StringList component so the
          // chip/bullet heuristic stays consistent with the top-level
          // renderer.
          <div style={{ marginTop: 2 }}>
            <StringList items={v as string[]} maxItems={10} />
          </div>
        ) : nested ? (
          <div>
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                color: 'var(--accent)',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
              }}
            >
              {expanded ? '▾' : '▸'}{' '}
              {Array.isArray(v) ? `${v.length} items` : `${Object.keys(v as object).length} fields`}
            </button>
            {expanded && (
              <pre
                style={{
                  marginTop: 6,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  background: 'rgba(0,0,0,0.03)',
                  padding: 10,
                  borderRadius: 6,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 240,
                  overflow: 'auto',
                }}
              >
                {JSON.stringify(v, null, 2)}
              </pre>
            )}
          </div>
        ) : (
          <span
            style={{
              fontFamily:
                typeof v === 'string' && v.length > 60
                  ? 'inherit'
                  : "'JetBrains Mono', monospace",
              fontSize: typeof v === 'string' && v.length > 60 ? 13 : 12,
              userSelect: 'all',
            }}
          >
            {renderScalar(v)}
          </span>
        )}
      </td>
    </tr>
  );
}
