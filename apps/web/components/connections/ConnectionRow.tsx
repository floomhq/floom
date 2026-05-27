"use client";

import { RefreshCw, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const map: Record<string, string> = {
    active: "border-[color-mix(in_srgb,var(--positive)_24%,var(--line))] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] text-[var(--positive)]",
    initiated: "border-[color-mix(in_srgb,#9a6a16_24%,var(--line))] bg-[color-mix(in_srgb,#9a6a16_10%,transparent)] text-[#8a5d12]",
  };
  const label =
    status === "active"
      ? "Active"
      : status === "initiated"
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

      {/* Actions: compact icon buttons on desktop, hover-revealed on mobile */}
      <div className="flex shrink-0 items-center gap-1">
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
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7"
          onClick={() => onTest(connection)}
          disabled={testing}
          title="Test connection"
          aria-label={`Test ${connection.displayName}`}
        >
          <Zap className={cn("size-3.5", testing && "animate-pulse")} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7"
          onClick={() => onRefresh(connection)}
          disabled={refreshing}
          title="Refresh status"
          aria-label={`Refresh ${connection.displayName} status`}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7 text-[var(--negative)] hover:bg-[color-mix(in_srgb,var(--negative)_9%,transparent)] hover:text-[var(--negative)]"
          onClick={() => onDelete(connection)}
          disabled={deleting}
          title="Disconnect"
          aria-label={`Disconnect ${connection.displayName}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      {/* Mobile: status pill on row 2 if needed */}
      <span className="col-span-3 md:hidden inline-flex">
        <StatusPill status={connection.status} />
      </span>
    </div>
  );
}
