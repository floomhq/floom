import type { ComponentType, ReactNode } from "react";
import { Inbox, AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The ONE shared loading / empty / error treatment for every list and
 * collection surface in the app (SPEC §7). Three distinct states share one
 * slot so a failed fetch can NEVER be mistaken for a slow one or an empty one:
 *
 *   <ListLoading/> — skeleton rows (we are still fetching)
 *   <ListEmpty/>   — the fetch succeeded and there is genuinely nothing
 *   <ListError/>   — the fetch FAILED (explicit message + retry), never a
 *                    perpetual skeleton and never an empty card
 *
 * Bespoke surfaces (e.g. /connections/mcp, /connections/secrets) must use
 * these instead of rolling their own skeleton/empty so the register is one
 * system. `EmptyState`/`LoadingState`/`ErrorState` remain as aliases for the
 * `Collection`-driven surfaces that already import them.
 */

export function ListEmpty({
  title,
  help,
  action,
  icon: Icon = Inbox,
  dropzone = false,
}: {
  title: string;
  help?: string;
  action?: ReactNode;
  icon?: ComponentType<{ size?: number }>;
  /** When true the empty state is itself a bounded dashed drop-zone box (the
   *  drop target affordance), used by drop-led surfaces like the Library. */
  dropzone?: boolean;
}) {
  return (
    <div className={dropzone ? "c-statebox c-dropbox" : "c-statebox"} role="status">
      <span className="g">
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
      {help && <p style={{ margin: 0, maxWidth: 360 }}>{help}</p>}
      {action}
    </div>
  );
}

export function ListLoading({ rows = 5 }: { rows?: number }) {
  // Restored to the previous good list skeleton (Federico 2026-06-18): a
  // bordered list card with full-width shimmer ROW bars that mirror the real
  // list rows, using the design-system <Skeleton> (skeleton-shimmer) — the
  // source of truth — NOT the cramped avatar + two short bars that read as
  // broken on a wide list. Rows are full-bleed `.c-lrow`-height bars so the
  // skeleton occupies the same footprint the loaded list will (no layout jump).
  return (
    <div className="c-ltable" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="c-lrow"
          style={{ gridTemplateColumns: "1fr", pointerEvents: "none" }}
        >
          <Skeleton className="h-4 w-full rounded-[var(--radius-button)]" />
        </div>
      ))}
    </div>
  );
}

export function ListError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="c-statebox" role="alert">
      {/* AlertTriangle (not the empty-state Inbox) so an ERROR never reads as
          "nothing here" — the failure is visually distinct from empty. */}
      <span className="g" style={{ color: "var(--negative, var(--destructive))" }}>
        <AlertTriangle size={24} />
      </span>
      <h3>Couldn&apos;t load</h3>
      <p style={{ margin: 0, maxWidth: 360 }}>{message}</p>
      {onRetry && (
        <button type="button" className="c-addbtn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

// Back-compat aliases — the `Collection`-driven surfaces import these names.
export const EmptyState = ListEmpty;
export const LoadingState = ListLoading;
export const ErrorState = ListError;
