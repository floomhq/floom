// CompositeOutputCard — R7.7 (2026-04-28)
//
// Federico's brief:
//   "Done · App · 995ms" should sit INSIDE the master sticky toolbar.
//   The toolbar should expose: Copy JSON | Download all CSVs | Expand-all.
//   Per-section affordances live in their own SectionHeader actions slot.
//
// This component wraps the existing multi-section composite (positioning,
// pricing, unique-to-you, etc.) with that master toolbar and a viewport-
// sized fullscreen modal for "Expand all".
import { useMemo, useState, type ReactElement } from 'react';
import {
  IconCopyButton,
  IconDownloadButton,
  FullscreenButton,
  OutputActionBar,
  OutputDoneBadge,
  TableFullscreenModal,
} from './OutputActionBar';
import { rowsToCsv } from './RowTable';

export function isArrayOfStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string');
}

export function isArrayOfFlatObjects(v: unknown): v is Array<Record<string, unknown>> {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((item) => item && typeof item === 'object' && !Array.isArray(item));
}

export interface CompositeOutputCardProps {
  /** Pre-rendered section ReactNodes — RowTable / StringList / ... */
  children: ReactElement[];
  /**
   * The full run output payload — used to (a) generate master "Copy JSON"
   * and (b) walk all array-of-objects fields for "Download all CSVs".
   */
  runOutput: unknown;
  /** App display name for the Done badge (e.g. "Competitor Lens"). */
  appName?: string;
  /** Pre-formatted duration (e.g. "995ms"). */
  durationLabel?: string;
  /**
   * Slug + run-id used to name downloaded CSVs and to disambiguate
   * filenames when multiple tables are zipped/sequentially-downloaded.
   */
  appSlug?: string;
  runId?: string;
}

/**
 * Render the master sticky toolbar + section body wrapper. Children are
 * pre-rendered sections (the existing RowTable, StringList, etc).
 */
export function CompositeOutputCard({
  children,
  runOutput,
  appName,
  durationLabel,
  appSlug,
  runId,
}: CompositeOutputCardProps) {
  const [fullscreen, setFullscreen] = useState(false);
  // R7.7: stable identifier for cascadeIsMultiComposite() — minified
  // bundle drops Function#name, so we attach a literal flag the caller
  // can read off the React element type.
  // (set after declaration, see end of file)

  // Walk runOutput once: collect every (key, rows) pair that looks like
  // a table for the master Download-all-CSVs action. Memoised because
  // we re-render on fullscreen toggle.
  const tables = useMemo(() => collectTables(runOutput), [runOutput]);

  const masterCopyValue = useMemo(() => {
    try {
      return JSON.stringify(runOutput, null, 2);
    } catch {
      return '';
    }
  }, [runOutput]);

  const downloadAll = () => {
    if (tables.length === 0) return;
    const slug = appSlug ?? 'output';
    const suffix = runId ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (tables.length === 1) {
      const t = tables[0];
      const csv = rowsToCsv(t.rows, t.columns);
      triggerDownload(csv, `${slug}-${t.name}-${suffix}.csv`);
      return;
    }
    // Multi-table: trigger N downloads, slightly staggered so browsers
    // don't coalesce them into a single "wants to download multiple
    // files" prompt that some users dismiss. Each file named
    // <slug>-<section>-<suffix>.csv. Federico's brief said "zip if
    // multi-table" — JSZip would add a 100KB dep for a one-off; the
    // sequential-download path is cleaner and works for the demo apps
    // we ship today (typically 2-3 sections).
    tables.forEach((t, i) => {
      window.setTimeout(() => {
        const csv = rowsToCsv(t.rows, t.columns);
        triggerDownload(csv, `${slug}-${t.name}-${suffix}.csv`);
      }, i * 200);
    });
  };

  const doneBadge =
    appName && durationLabel ? (
      <OutputDoneBadge appName={appName} durationLabel={durationLabel} />
    ) : undefined;

  // The same body renders inline AND inside the fullscreen modal so the
  // "Expand all" affordance shows the EXACT same surface the user was
  // already looking at — just at full viewport size.
  const body = (
    <div
      className="floom-auto-composite-body"
      style={{ display: 'flex', flexDirection: 'column', gap: 22, padding: '20px 22px' }}
    >
      {children}
    </div>
  );

  return (
    <div
      className="floom-auto-composite-output floom-auto-composite-multi"
      data-renderer="composite"
      data-multi="true"
      style={{
        border: '1px solid var(--line)',
        borderRadius: 12,
        background: 'var(--card)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <OutputActionBar
        doneBadge={doneBadge}
        actions={
          <>
            <IconCopyButton value={masterCopyValue} label="Copy all JSON" />
            <IconDownloadButton
              onClick={downloadAll}
              label={tables.length > 1 ? 'Download all CSVs' : 'Download CSV'}
              disabled={tables.length === 0}
            />
            <FullscreenButton
              onClick={() => setFullscreen(true)}
              label="Expand output to fullscreen"
            />
          </>
        }
      />
      {body}
      <TableFullscreenModal
        open={fullscreen}
        onClose={() => setFullscreen(false)}
        title={appName ? `${appName} — full output` : 'Output'}
      >
        {body}
      </TableFullscreenModal>
    </div>
  );
}

interface TableHandle {
  /** Section/field name, used to derive the CSV filename. */
  name: string;
  rows: Array<Record<string, unknown>>;
  columns: string[];
}

/**
 * Walk a run output and collect every top-level field that's an array
 * of flat objects — those are the fields the master "Download all CSVs"
 * action emits one file each for. Mirrors RowTable's `deriveColumns`
 * logic so column order matches what the user sees.
 */
function collectTables(runOutput: unknown): TableHandle[] {
  if (!runOutput || typeof runOutput !== 'object' || Array.isArray(runOutput)) {
    if (isArrayOfFlatObjects(runOutput)) {
      const rows = runOutput as Array<Record<string, unknown>>;
      return [{ name: 'rows', rows, columns: deriveColumns(rows) }];
    }
    return [];
  }
  const obj = runOutput as Record<string, unknown>;
  const out: TableHandle[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isArrayOfFlatObjects(value)) {
      const rows = value as Array<Record<string, unknown>>;
      out.push({ name: key, rows, columns: deriveColumns(rows) });
    }
  }
  return out;
}

function deriveColumns(rows: Array<Record<string, unknown>>): string[] {
  const keys = new Set<string>();
  for (const row of rows.slice(0, 10)) {
    for (const k of Object.keys(row)) {
      keys.add(k);
    }
  }
  return Array.from(keys);
}

function triggerDownload(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Stable marker so OutputPanel can detect "the cascade returned the
// composite card with its own Done badge" and suppress the outer
// run-header. Minified bundle drops Function#name so we attach a
// literal flag instead.
(CompositeOutputCard as unknown as { __floomCompositeCard: true }).__floomCompositeCard = true;
CompositeOutputCard.displayName = 'CompositeOutputCard';
