"use client";

import { RefreshCw, Trash2, Zap, MoreHorizontal } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
      style={{ background: "color-mix(in srgb,#9a6a16 12%,transparent)" }}
    >
      <div
        className="absolute inset-y-0 w-1/3 rounded-full"
        style={{
          background: "#b07a1a",
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
      <span className="inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--positive)_24%,var(--line))] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--positive)]">
        Active
      </span>
    );
  }
  if (status === "initiated") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,#9a6a16_24%,var(--line))] bg-[color-mix(in_srgb,#9a6a16_10%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[#8a5d12]">
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
    "border-[color-mix(in_srgb,var(--negative)_24%,var(--line))] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] text-[var(--negative)]";
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", cls)}>
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
  onDelete,
  onReconnect,
  onRefresh,
  onTest,
}: {
  connection: ConnectionView;
  deleting?: boolean;
  refreshing?: boolean;
  reconnecting?: boolean;
  testing?: boolean;
  highlighted?: boolean;
  /** N13: true while the last-used async fetch is still in flight — show skeleton instead of "—" */
  lastUsedLoading?: boolean;
  onDelete: (connection: ConnectionView) => void;
  onReconnect: (slug: string) => void;
  onRefresh: (connection: ConnectionView) => void;
  onTest: (connection: ConnectionView) => void;
}) {
  const isConnecting = connection.status === "initiated";

  return (
    <div
      id={`connection-${connection.id}`}
      className={cn(
        "relative grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(0,1.5fr)_minmax(0,1fr)_120px_140px_auto] gap-3 md:gap-4 items-center px-3 py-2.5 border-b border-[var(--border-default)] last:border-b-0 hover:bg-[var(--active-nav-bg)] transition-colors",
        highlighted &&
          "bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--positive)_40%,transparent)]"
      )}
    >
      {/* Logo */}
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)]">
        <BrandLogo icon={connection.icon} className="size-4" />
      </div>

      {/* Name + account label */}
      <div className="min-w-0">
        <p className="text-sm font-medium truncate text-foreground">{connection.displayName}</p>
        <p className="text-xs text-muted-foreground truncate">
          {connection.accountLabel}
        </p>
      </div>

      {/* Scopes count (desktop only).
          E3 fix: scopes are now captured from Composio (data.scope string).
          Show the real granted-scope count. When not yet loaded (no sweep has
          run for this row), show an honest "—" placeholder with an inline
          refresh that triggers a re-check — NOT a fake "default scopes" label. */}
      <span className="hidden md:inline-flex items-center gap-1 text-xs text-muted-foreground truncate">
        {connection.scopes.length > 0 ? (
          <span title={connection.scopes.join(", ")}>
            {`${connection.scopes.length} scope${connection.scopes.length === 1 ? "" : "s"}`}
          </span>
        ) : connection.status === "expired" ||
          connection.status === "failed" ||
          connection.lastCheckStatus === "expired" ||
          connection.lastCheckStatus === "failed" ? (
          // P2-6 (audit 2026-05-29): for expired/failed rows the inline
          // refresh glyph read as a stuck loader ("— ↻") and could never load
          // scopes anyway (the connection is dead). Show a clean dash only;
          // the path back is Reconnect, not a scope re-check.
          <span className="text-muted-foreground/50">—</span>
        ) : (
          <>
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
          never shows Reconnect — even when last_check_status is "active"
          rather than "valid" (GitHub reports the former). Active = healthy;
          only the overflow menu is offered. */}
      <div className="flex shrink-0 items-center justify-end gap-1 md:pr-1">
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
            <DropdownMenuItem onClick={() => onTest(connection)} disabled={testing}>
              <Zap className="size-3.5" />
              {testing ? "Testing..." : "Test connection"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRefresh(connection)} disabled={refreshing}>
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
              {refreshing ? "Refreshing..." : "Refresh status"}
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

      {/* Indeterminate progress bar along the bottom edge while OAuth resolves */}
      {isConnecting && <ConnectingProgressBar />}
    </div>
  );
}
