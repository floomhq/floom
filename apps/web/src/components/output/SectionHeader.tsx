// Shared header strip for output sections. Used by KeyValueTable,
// StringList, RowTable, ScoredRowsTable, CompetitorTiles so every
// section in the multi-section composite has the same label rhythm
// and the same kind of right-aligned action slot (Copy, Download).
//
// Visual rules (Federico's "sexy + shareable" bar, 2026-04-25):
//   - 6px green accent dot before the label, used exactly once per
//     section. This is the single accent touch — labels stay muted.
//   - 11px uppercase tracked label, JetBrains Mono fallback.
//   - Actions render right-aligned with a fixed gap of 8.
//   - 16px horizontal padding when bordered=false (inline header,
//     used by KeyValueTable / StringList), 14px x 16px when
//     bordered=true (under a top border, used by table-style cards
//     so the bar visually divides from the table body).
import type { ReactNode } from 'react';

export interface SectionHeaderProps {
  label: string;
  /** Right-aligned actions (Copy, Download CSV, etc.). Optional. */
  actions?: ReactNode;
  /**
   * When true, render with a bottom border and table-card padding.
   * When false (default), inline above the body with 10px bottom margin.
   */
  bordered?: boolean;
  /** Optional secondary line under the label, e.g. "12 rows · 988ms". */
  hint?: string;
  /** When true, dim the accent dot — used by sub-sections inside a card. */
  subdued?: boolean;
}

export function SectionHeader({
  label,
  actions,
  bordered = false,
  hint,
  subdued = false,
}: SectionHeaderProps) {
  return (
    <div
      className="floom-output-section-header"
      data-testid="output-section-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: bordered ? '12px 16px' : '0',
        marginBottom: bordered ? 0 : 10,
        borderBottom: bordered ? '1px solid var(--line)' : undefined,
        background: bordered ? 'var(--card)' : 'transparent',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          aria-hidden="true"
          className="floom-output-section-dot"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: subdued ? 'var(--muted)' : 'var(--accent, #047857)',
            opacity: subdued ? 0.45 : 1,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontWeight: 600,
            fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {label}
        </span>
        {hint ? (
          <span
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              opacity: 0.75,
            }}
          >
            · {hint}
          </span>
        ) : null}
      </div>
      {actions ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
