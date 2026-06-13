"use client";

import { RefreshCw, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/collection/StatusPill";
import type { StatusPillSpec } from "@/lib/collection/types";
import { BrandLogo } from "./BrandLogo";
import { formatTimestamp, type ConnectionView } from "./connection-data";

// S28: Connected tab now uses the SAME grid + card shape as /connections/browse
// (CatalogCard). Federico explicit: "should simply be same design as #browse".
// 172px tall, auto-fill min-176px wide. Logo + name + account + status badge
// + Reconnect button at bottom. Test/Refresh/Disconnect hidden as an icon
// row that appears on hover (the card is dense; full action set fits via
// hover-reveal without making the resting state busy).

function statusBadgeSpec(status: string): StatusPillSpec {
  if (status === "active") {
    return { tone: "ok", label: "Active" };
  }
  if (status === "initiated") {
    return { tone: "pending", label: "Connecting" };
  }
  const lbl =
    status === "expired" ? "Expired" : status === "failed" ? "Failed" : "Inactive";
  return { tone: "err", label: lbl };
}

export function ConnectionGridCard({
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
  const statusSpec = statusBadgeSpec(connection.status);

  return (
    <article className="group grid h-[172px] grid-rows-[auto_1fr_auto] rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)] transition-[background-color,box-shadow] duration-150 ease-[var(--ease)] hover:bg-[var(--bg-2)] hover:shadow-md">
      {/* Top row: logo + name + slug (account label) */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-2)]">
          <BrandLogo icon={connection.icon} className="size-6" />
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{connection.displayName}</h2>
          <p className="mt-0.5 truncate text-xs text-[var(--ink-mute)]">{connection.accountLabel}</p>
        </div>
      </div>

      {/* Middle: status badge + last used. Reveals 3 icon-only secondary
          actions on hover (Test / Refresh / Disconnect) so the resting state
          isn't busy. */}
      <div className="min-w-0 pt-3 flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5 min-w-0">
          <StatusPill spec={statusSpec} />
          {connection.lastUsedAt && (
            <span className="text-[11px] text-[var(--ink-mute)] truncate">
              Used {formatTimestamp(connection.lastUsedAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onTest(connection)}
            disabled={testing}
            title="Test connection"
            aria-label={`Test ${connection.displayName}`}
          >
            <Zap className={cn("size-3", testing && "animate-pulse")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onRefresh(connection)}
            disabled={refreshing}
            title="Refresh status"
            aria-label={`Refresh ${connection.displayName} status`}
          >
            <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-[var(--negative)] hover:bg-[color-mix(in_srgb,var(--negative)_9%,transparent)] hover:text-[var(--negative)]"
            onClick={() => onDelete(connection)}
            disabled={deleting}
            title="Disconnect"
            aria-label={`Disconnect ${connection.displayName}`}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      {/* Bottom: Reconnect CTA — only when the connection actually needs it.
          E1 fix: active/valid connections skip this; the hover-reveal Test /
          Refresh / Disconnect actions are sufficient. */}
      {(connection.status === "expired" || connection.lastCheckStatus !== "valid") && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          disabled={reconnecting}
          onClick={() => onReconnect(connection.app_name)}
        >
          <RefreshCw className={cn("size-3.5", reconnecting && "animate-spin")} />
          {reconnecting ? "Opening..." : "Reconnect"}
        </Button>
      )}
    </article>
  );
}
