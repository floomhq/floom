"use client";

import { RefreshCw, Trash2, Zap, MoreHorizontal } from "lucide-react";
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
function StatusPill({ status }: { status: string }) {
  // S29l (ChatGPT-audit P-2): "Active" on every connection row is decoration.
  // Only render the pill when the user needs to act (initiated/expired/failed/
  // inactive). Active state is implied by the absence of a warning pill.
  if (status === "active") return null;
  const map: Record<string, string> = {
    initiated: "border-[color-mix(in_srgb,#9a6a16_24%,var(--line))] bg-[color-mix(in_srgb,#9a6a16_10%,transparent)] text-[#8a5d12]",
  };
  const label =
    status === "initiated"
      ? "Connecting"
      : status === "expired"
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
  onDelete: (connection: ConnectionView) => void;
  onReconnect: (slug: string) => void;
  onRefresh: (connection: ConnectionView) => void;
  onTest: (connection: ConnectionView) => void;
}) {
  return (
    <div className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(0,1.5fr)_minmax(0,1fr)_120px_140px_auto] gap-3 md:gap-4 items-center px-3 py-2.5 border-b border-line last:border-b-0 hover:bg-muted/50 transition-colors">
      {/* Logo */}
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-[var(--paper)]">
        <BrandLogo icon={connection.icon} className="size-4" />
      </div>

      {/* Name + account label */}
      <div className="min-w-0">
        <p className="text-sm font-medium truncate text-foreground">{connection.displayName}</p>
        <p className="text-xs text-muted-foreground truncate">
          {connection.accountLabel}
        </p>
      </div>

      {/* Scopes count (desktop only) */}
      <span className="hidden md:inline text-xs text-muted-foreground truncate">
        {connection.scopes.length > 0
          ? `${connection.scopes.length} scope${connection.scopes.length === 1 ? "" : "s"}`
          : <span className="text-muted-foreground/50">default scopes</span>}
      </span>

      {/* Last used (desktop only) */}
      <span className="hidden md:inline text-xs text-muted-foreground truncate">
        {connection.lastUsedAt ? `Used ${formatTimestamp(connection.lastUsedAt)}` : <span className="text-muted-foreground/50">—</span>}
      </span>

      {/* Status pill (desktop only — mobile shows in row above) */}
      <span className="hidden md:inline">
        <StatusPill status={connection.status} />
      </span>

      {/* S29w (score walk): was Reconnect + 3 icon-buttons (Test/Refresh/
          Disconnect) = 4 actions per row. Now Reconnect + a single
          overflow menu containing Test / Refresh / Disconnect. Row reads
          as one primary action with secondary options behind a click.

          FIX #5: a direct, always-visible "Refresh status" icon button is
          surfaced inline (refreshing is the common, low-stakes action) so
          users don't have to open the overflow menu for it. Test/Disconnect
          stay in the menu. */}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onRefresh(connection)}
          disabled={refreshing}
          title={refreshing ? "Refreshing status" : "Refresh status"}
          aria-label={`Refresh status for ${connection.displayName}`}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
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
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-7 w-7 items-center justify-center hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="More"
            aria-label={`More actions for ${connection.displayName}`}
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* base-ui Menu.Item uses onClick, not onSelect (that was the
                Radix API). Previously these were silently dropped — menu
                closed on click but the handler never fired. */}
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
    </div>
  );
}
