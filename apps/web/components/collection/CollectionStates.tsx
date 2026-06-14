import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

/** Empty / loading / error share one slot (SPEC §7). */

export function EmptyState({
  title,
  help,
  action,
}: {
  title: string;
  help?: string;
  action?: ReactNode;
}) {
  return (
    <div className="c-statebox" role="status">
      <span className="g">
        <Inbox size={24} />
      </span>
      <h3>{title}</h3>
      {help && <p style={{ margin: 0, maxWidth: 360 }}>{help}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ rows = 5 }: { rows?: number }) {
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
                style={{ height: 12, width: "40%", background: "var(--bg-3)", borderRadius: "var(--radius-ui)" }}
              />
              <div
                className="animate-pulse"
                style={{
                  height: 10,
                  width: "60%",
                  background: "var(--bg-3)",
                  borderRadius: "var(--radius-ui)",
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

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="c-statebox" role="alert">
      <span className="g">
        <Inbox size={24} />
      </span>
      <h3>Something went wrong</h3>
      <p style={{ margin: 0, maxWidth: 360 }}>{message}</p>
      {onRetry && (
        <button type="button" className="c-addbtn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
