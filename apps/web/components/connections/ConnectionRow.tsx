"use client";

import { useRouter } from "next/navigation";
import { RefreshCw, Trash2, Zap, MoreHorizontal, ChevronRight, ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BrandLogo } from "./BrandLogo";
import { formatTimestamp, type ConnectionView } from "./connection-data";

// S27: compact row replaces the 116px-tall ConnectionCard. At 30+
// connections the card list scrolled forever; this fits ~14 rows
// per viewport at 720p.
//
// Layout (desktop):
//   [logo] [name + account]   [scopes count]   [last used]   [status pill]   [actions]
//
// Layout (mobile, <md):
//   [logo] [name]                                            [status pill]
//   [account label]                              [actions overflow]
//
// Actions:
//   - Reconnect: primary outline button
//   - Test: outline button
//   - Disconnect: ghost destructive button
//   - Refresh status: icon-only

// Thin indeterminate progress bar shown at the bottom of a "Connecting" row.
function ConnectingProgressBar() {
  return (
    <div
      aria-hidden="true"
      className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden rounded-b-none"
      style={{ background: "color-mix(in srgb,var(--accent) 12%,transparent)" }}
    >
      <div
        className="absolute inset-y-0 w-1/3 rounded-[var(--radius-pill)]"
        style={{
          background: "var(--accent)",
          animation: "conn-progress 1.6s cubic-bezier(0.4,0,0.2,1) infinite",
        }}
      />
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  // P1-7 (audit 2026-05-29): the Status column previously rendered nothing for
  // active connections, so a healthy connection looked state-less while only
  // Expired/Failed got a pill. The column read as "either Expired or nothing".
  // Restore a positive "Active" pill for parity — every row now shows its
  // actual state. (This intentionally reverses the earlier S29l "no decoration"
  // call: the audit found a blank cell reads as missing data, not as healthy.)
  if (status === "active") {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-pill)] [border:var(--bd-pill)] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--positive)]">
        Active
      </span>
    );
  }
  if (status === "initiated") {
    return (
      <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] [border:var(--bd-pill)] bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
        <svg
          aria-hidden="true"
          className="size-2.5 shrink-0 animate-spin"
          viewBox="0 0 16 16"
          fill="none"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.25" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        Connecting
      </span>
    );
  }
  const map: Record<string, string> = {};
  const label =
    status === "expired"
      ? "Expired"
      : status === "failed"
      ? "Failed"
      : "Inactive";
  const cls =
    map[status] ??
    "[border:var(--bd-pill)] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] text-[var(--negative)]";
  return (
    <span className={cn("inline-flex items-center rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-medium", cls)}>
      {label}
    </span>
  );
}

export function ConnectionRow({
  connection,
  deleting,
  refreshing,
  reconnecting,
  testing,
  highlighted,
  lastUsedLoading,
  expanded,
  usedByCount,
  onDelete,
  onReconnect,
  onRefresh,
  onTest,
  onToggle,
}: {
  connection: ConnectionView;
  deleting?: boolean;
  refreshing?: boolean;
  reconnecting?: boolean;
  testing?: boolean;
  highlighted?: boolean;
  /** N13: true while the last-used async fetch is still in flight — show skeleton instead of "—" */
  lastUsedLoading?: boolean;
  /** Whether this row is expanded to show extra detail */
  expanded?: boolean;
  /** How many workers use this connection */
  usedByCount?: number;
  onDelete: (connection: ConnectionView) => void;
  onReconnect: (slug: string) => void;
  onRefresh: (connection: ConnectionView) => void;
  onTest: (connection: ConnectionView) => void;
  /** Called when the row header is clicked to toggle expansion */
  onToggle?: () => void;
}) {
  const router = useRouter();
  const isConnecting = connection.status === "initiated";

  return (
    <div
      id={`connection-${connection.id}`}
      className={cn(
        "relative [border-bottom:var(--bd-div)] last:[border-bottom:0] transition-colors",
        highlighted &&
          "bg-[color-mix(in_srgb,var(--positive)_10%,transparent)]"
      )}
    >
      {/* Clickable main row */}
      <div
        role={onToggle ? "button" : undefined}
        tabIndex={onToggle ? 0 : undefined}
        onClick={onToggle}
        onKeyDown={onToggle ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } } : undefined}
        className={cn(
          "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(0,1.5fr)_minmax(0,1fr)_120px_140px_auto] gap-3 md:gap-4 items-center px-3 py-2.5",
          onToggle && "cursor-pointer hover:bg-[var(--active-nav-bg)] transition-colors select-none",
          !onToggle && "hover:bg-[var(--active-nav-bg)] transition-colors"
        )}
      >
        {/* Logo */}
        <div className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-card)]">
          <BrandLogo icon={connection.icon} className="size-4" />
        </div>

        {/* Name + account label */}
        <div className="min-w-0 flex items-center gap-1.5">
          {onToggle && (
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
                expanded && "rotate-90"
              )}
            />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate text-foreground">{connection.displayName}</p>
            <p className="text-xs text-muted-foreground truncate">
              {connection.accountLabel}
            </p>
          </div>
        </div>

        {/* Scopes count (desktop only). #507: show scopes in a proper Tooltip
            instead of the native browser title attribute which truncates and has
            no styling. */}
        <span
          className="hidden md:inline-flex items-center gap-1 text-xs text-muted-foreground truncate"
          onClick={(e) => e.stopPropagation()}
        >
          {connection.scopes.length > 0 ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger className="underline-offset-2 hover:underline cursor-default">
                  {`${connection.scopes.length} scope${connection.scopes.length === 1 ? "" : "s"}`}
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start" className="max-w-xs">
                  <ul className="space-y-0.5 text-left">
                    {connection.scopes.map((scope) => (
                      <li key={scope} className="font-mono text-[11px]">{scope}</li>
                    ))}
                  </ul>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : connection.status === "expired" ||
            connection.status === "failed" ||
            connection.lastCheckStatus === "expired" ||
            connection.lastCheckStatus === "failed" ? (
            // P2-6 (audit 2026-05-29): for expired/failed rows the inline
            // refresh glyph read as a stuck loader and could never load
            // scopes anyway (the connection is dead). Show a clean dash only;
            // the path back is Reconnect, not a scope re-check.
            // em-dash-ok: null placeholder in table cell
            <span className="text-muted-foreground/50">—</span>
          ) : (
            <>
              {/* em-dash-ok: null placeholder in table cell */}
              <span className="text-muted-foreground/50">—</span>
              <button
                type="button"
                className="inline-flex items-center text-muted-foreground/40 hover:text-muted-foreground transition-colors"
                title="Refresh to load granted scopes"
                onClick={() => onTest(connection)}
              >
                <RefreshCw className="size-3" />
              </button>
            </>
          )}
        </span>

        {/* Last used (desktop only) — N13: show skeleton while async data loads */}
        <span className="hidden md:inline text-xs text-muted-foreground truncate">
          {lastUsedLoading
            ? <Skeleton className="h-3 w-16 rounded" />
            : connection.lastUsedAt
            ? `Used ${formatTimestamp(connection.lastUsedAt)}`
            : <span className="text-muted-foreground/50">—</span>}
        </span>

        {/* Status pill (desktop only — mobile shows in row above) */}
        <span className="hidden md:inline">
          <StatusPill status={connection.status} />
        </span>

        {/* S29w (score walk): was Reconnect + 3 icon-buttons (Test/Refresh/
            Disconnect) = 4 actions per row. Now Reconnect (only when needed) + a
            single overflow menu containing Test / Refresh / Disconnect. Row reads
            as one primary action with secondary options behind a click.
            E1 fix: Reconnect appears ONLY when the connection is broken
            (expired / failed / needs-reauth / inactive). An active connection
            never shows Reconnect, even when last_check_status is "active"
            rather than "valid" (GitHub reports the former). Active = healthy;
            only the overflow menu is offered. */}
        <div
          className="flex shrink-0 items-center justify-end gap-1 md:pr-1"
          onClick={(e) => e.stopPropagation()}
        >
          {connection.status !== "active" &&
            (connection.status === "expired" ||
              connection.status === "failed" ||
              connection.lastCheckStatus === "expired" ||
              connection.lastCheckStatus === "failed") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onReconnect(connection.app_name)}
              disabled={reconnecting}
              title={reconnecting ? "Opening" : "Reconnect"}
            >
              <RefreshCw className={cn("size-3", reconnecting && "animate-spin")} />
              <span className="hidden sm:inline">{reconnecting ? "Opening" : "Reconnect"}</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-7 w-7 items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title="More"
              aria-label={`More actions for ${connection.displayName}`}
            >
              <MoreHorizontal className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onTest(connection)} disabled={testing || refreshing}>
                <Zap className={cn("size-3.5", testing && "animate-pulse")} />
                {testing ? "Checking..." : "Check connection"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDelete(connection)}
                disabled={deleting}
                variant="destructive"
              >
                <Trash2 className="size-3.5" />
                {deleting ? "Disconnecting..." : "Disconnect"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Mobile: status pill on row 2 if needed */}
        <span className="col-span-3 md:hidden inline-flex">
          <StatusPill status={connection.status} />
        </span>
      </div>

      {/* Expanded peek — same background, no box, just additional content */}
      {expanded && (
        <div className="[border-top:var(--bd-div)] bg-[color-mix(in_srgb,var(--active-nav-bg)_60%,transparent)] px-3 py-3 md:pl-[64px]">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="text-[var(--ink-soft)]">
              {connection.accountLabel}
            </span>
            <span className="text-[var(--ink-soft)]">
              {connection.scopes.length > 0
                ? `${connection.scopes.length} scope${connection.scopes.length === 1 ? "" : "s"}`
                : "No scopes"}
            </span>
            <StatusPill status={connection.status} />
            {usedByCount !== undefined && (
              <span className="text-[var(--ink-soft)]">
                Used by {usedByCount} worker{usedByCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => onTest(connection)}
              disabled={testing}
            >
              <Zap className={cn("size-3", testing && "animate-pulse")} />
              {testing ? "Testing..." : "Test"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => { router.push(`/connections/${connection.id}`); }}
            >
              <ExternalLink className="size-3" />
              Open
            </Button>
          </div>
        </div>
      )}

      {/* Indeterminate progress bar along the bottom edge while OAuth resolves */}
      {isConnecting && <ConnectingProgressBar />}
    </div>
  );
}
