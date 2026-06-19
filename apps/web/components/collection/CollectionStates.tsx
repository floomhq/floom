import type { ComponentType, ReactNode } from "react";
import { Inbox, AlertTriangle } from "lucide-react";

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
  // Skeleton mirrors the list layout (SPEC §4 — no partial flashes).
  return (
    <div className="c-ltable" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="c-lrow"
          style={{ gridTemplateColumns: "1fr", pointerEvents: "none" }}
        >
          <div className="c-lprimary">
            <span className="c-av animate-pulse" style={{ background: "var(--bg-3)" }} />
            <div className="c-lp-tx" style={{ flex: 1 }}>
              <div
                className="animate-pulse"
                style={{ height: 12, width: "40%", background: "var(--bg-3)", borderRadius: "var(--radius-button)" }}
              />
              <div
                className="animate-pulse"
                style={{
                  height: 10,
                  width: "60%",
                  background: "var(--bg-3)",
                  borderRadius: "var(--radius-button)",
                  marginTop: 6,
                }}
              />
            </div>
          </div>
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
