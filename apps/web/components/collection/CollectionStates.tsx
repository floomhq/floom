import type { ComponentType, ReactNode } from "react";
import { Inbox, AlertTriangle, Search, LayoutGrid, List as ListIcon, Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";

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

const PAGE_X = 28;

export interface CollectionSkeletonProps {
  /** Number of skeleton list rows to render in the content area. */
  rows?: number;
  /** Real page title (e.g. "Library") — rendered as live text, never a bar. */
  title?: string;
  /** Real page subtitle — rendered as live text when present. */
  subtitle?: string;
  /** Label for the toolbar action button (e.g. "New worker"). Hidden when omitted. */
  actionLabel?: string;
  /** Search input placeholder. Defaults to `Search {title}…` when a title is set. */
  searchPlaceholder?: string;
  /** Show the search box (default true). */
  showSearch?: boolean;
  /** Show the list/grid view toggle (default false — only grid-enabled pages). */
  showViewToggle?: boolean;
  /** Show the filter row placeholder (default true — most collections have tags). */
  showFilter?: boolean;
}

/**
 * Full-page collection skeleton (Federico 2026-06-20; static-header pass
 * 2026-06-25): the route-level loading shell (`loading.tsx` →
 * CollectionRouteLoading) renders BEFORE the real CollectionView mounts, so
 * there is no real header/search/toolbar behind it. A bare stack of list bars
 * in that slot reads as "broken" because it does not represent the page that is
 * loading.
 *
 * This renders the page's REAL static header chrome — the live title/subtitle
 * text plus a static, non-interactive search box, view-toggle, filter and
 * action button that match CollectionView's markup + Tailwind classes — and
 * skeletons ONLY the list content rows. So a cache-miss tab switch shows the
 * real header instantly (no full-page flash, no layout jump into the loaded
 * CollectionView), with a shimmer only where the data is still loading.
 *
 * Used ONLY at the route level. Inside CollectionView the real header/search
 * already render during `config.loading`, so that path keeps using the
 * list-body-only <ListLoading/> below (no double header).
 */
export function CollectionSkeleton({
  rows = 6,
  title,
  subtitle,
  actionLabel,
  searchPlaceholder,
  showSearch = true,
  showViewToggle = false,
  showFilter = true,
}: CollectionSkeletonProps) {
  const placeholder =
    searchPlaceholder ?? (title ? `Search ${title.toLowerCase()}…` : "Search…");

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      {/* Real header: live title + subtitle text (mirrors CollectionView's
          `header`). Only the list below is a skeleton. */}
      <div style={{ padding: `22px ${PAGE_X}px 0` }}>
        <div className="c-headrow">
          <div className="c-headtitle">
            <div style={{ fontSize: 23, fontWeight: 600, letterSpacing: "-0.02em" }}>
              {title ?? " "}
            </div>
            {subtitle && (
              <div style={{ color: "var(--muted-foreground)", marginTop: 2 }}>{subtitle}</div>
            )}
          </div>
        </div>
      </div>

      {/* Control strip: real-looking but INERT search box, view toggle and
          action button (same markup/classes as CollectionView so there is no
          drift between the skeleton and loaded states). `inert` makes the whole
          row non-focusable + non-clickable during load so users can't tab into
          or click a control that can't change state yet. */}
      <div className="c-controlstrip" style={{ padding: `0 ${PAGE_X}px` }}>
        <div className="c-controlstrip-inner">
          <div className="c-controlstrip-toprow" inert>
            {showSearch && (
              <div className="c-srch" aria-hidden="true">
                <Search size={15} />
                <input
                  type="search"
                  aria-label="Search"
                  placeholder={placeholder}
                  defaultValue=""
                  readOnly
                  tabIndex={-1}
                />
              </div>
            )}
            <div className="c-toolbar-actions">
              {showViewToggle && (
                <SegmentedControl<"list" | "grid">
                  ariaLabel="View mode"
                  value="list"
                  onChange={() => {}}
                  options={[
                    { value: "list", label: "List view", icon: <ListIcon />, iconOnly: true },
                    { value: "grid", label: "Grid view", icon: <LayoutGrid />, iconOnly: true },
                  ]}
                />
              )}
              {actionLabel && (
                <Button tabIndex={-1} aria-hidden="true">
                  <Plus /> {actionLabel}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
      {showFilter && (
        <div className="c-filterstrip" style={{ padding: `0 ${PAGE_X}px` }}>
          <div>
            <Skeleton className="h-7 w-24 rounded-[var(--radius-pill)]" />
          </div>
        </div>
      )}

      {/* List: ONLY the content rows are a skeleton (the real header above is
          live). Rows match the real `.c-lrow` footprint so there is no jump. */}
      <div className="c-body" style={{ marginTop: 14 }}>
        <div className="c-listcol" style={{ padding: `0 ${PAGE_X}px 26px` }}>
          <ListLoading rows={rows} />
        </div>
      </div>
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
