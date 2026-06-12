import { RefreshCw, Trash2, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BrandLogo } from "./BrandLogo";
import {
  formatRelativeTime,
  formatScope,
  formatTimestamp,
  type ConnectionView,
} from "./connection-data";

function statusBadge(status: string) {
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="[border:var(--bd-pill)] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] text-[var(--positive)]"
      >
        Active
      </Badge>
    );
  }
  if (status === "initiated") {
    return (
      <Badge
        variant="outline"
        className="[border:var(--bd-pill)] bg-[color-mix(in_srgb,#9a6a16_10%,transparent)] text-[#8a5d12]"
      >
        Connecting
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="[border:var(--bd-pill)] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] text-[var(--negative)]"
    >
      {status === "expired" ? "Expired" : status === "failed" ? "Failed" : "Inactive"}
    </Badge>
  );
}

function checkStatusLabel(checkStatus?: string): string {
  if (!checkStatus) return "unknown";
  if (checkStatus === "valid") return "valid";
  if (checkStatus === "expired") return "expired";
  if (checkStatus === "failed") return "failed";
  return checkStatus;
}

export function ConnectionCard({
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
  const visibleScopes = connection.scopes.slice(0, 3);
  const hiddenCount = Math.max(connection.scopes.length - visibleScopes.length, 0);

  return (
    <article className="group rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--glass-bg-strong)] p-4 shadow-sm transition-colors hover:bg-[var(--paper)]">
      <div className="grid min-h-[116px] grid-cols-[minmax(0,1fr)_auto] gap-4">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--paper)]">
              <BrandLogo icon={connection.icon} className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold leading-5 text-[var(--ink)]">
                  {connection.displayName}
                </h2>
                {statusBadge(connection.status)}
              </div>
              <p className="mt-0.5 max-w-full truncate text-xs text-[var(--ink-soft)]">
                Connected as {connection.accountLabel}
              </p>
            </div>
          </div>

          <div className="mt-3">
            {connection.scopes.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-1.5 group-hover:hidden group-focus-within:hidden">
                  {visibleScopes.map((scope) => (
                    <ScopeChip key={scope} scope={scope} />
                  ))}
                  {hiddenCount > 0 && <ScopeChip scope={`+${hiddenCount} more`} muted />}
                </div>
                <div className="hidden flex-wrap gap-1.5 group-hover:flex group-focus-within:flex">
                  {connection.scopes.map((scope) => (
                    <ScopeChip key={scope} scope={scope} />
                  ))}
                </div>
              </>
            ) : null /* S22f: drop the "Default scopes" placeholder. Roast P1:
                       label with no value is noise; "Default" is implied. */}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            {/* S22f: only render Last used when we actually have a timestamp.
                Roast P1: "Last used: Never" appearing on every card read as
                "nothing ever uses these" which contradicted the dashboard. */}
            {connection.lastUsedAt && (
              <p className="text-xs text-[var(--ink-mute)]">
                Last used {formatTimestamp(connection.lastUsedAt)}
              </p>
            )}
            {connection.lastCheckedAt && (
              <p className="text-xs text-[var(--ink-mute)]">
                Checked {formatRelativeTime(connection.lastCheckedAt)}
                {connection.lastCheckStatus && (
                  <span
                    className={cn(
                      "ml-1 font-medium",
                      connection.lastCheckStatus === "valid"
                        ? "text-[var(--positive)]"
                        : "text-[var(--negative)]"
                    )}
                  >
                    &middot; {checkStatusLabel(connection.lastCheckStatus)}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2 sm:flex-row sm:items-start">
          {/* E1 fix: Reconnect only when status=expired or lastCheckStatus≠valid */}
          {(connection.status === "expired" || connection.lastCheckStatus !== "valid") && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-[106px]"
              onClick={() => onReconnect(connection.app_name)}
              disabled={reconnecting}
            >
              <RefreshCw className={cn("size-3.5", reconnecting && "animate-spin")} />
              {reconnecting ? "Opening" : "Reconnect"}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-[106px]"
            onClick={() => onTest(connection)}
            disabled={testing}
          >
            <Zap className={cn("size-3.5", testing && "animate-pulse")} />
            {testing ? "Testing" : "Test"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-[106px] text-[var(--negative)] hover:bg-[color-mix(in_srgb,var(--negative)_9%,transparent)] hover:text-[var(--negative)]"
            onClick={() => onDelete(connection)}
            disabled={deleting}
          >
            <Trash2 className="size-3.5" />
            {deleting ? "Removing" : "Disconnect"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title="Refresh status"
            aria-label={`Refresh ${connection.displayName} status`}
            onClick={() => onRefresh(connection)}
            disabled={refreshing}
          >
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>
    </article>
  );
}

function ScopeChip({ scope, muted = false }: { scope: string; muted?: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "max-w-full [border:var(--bd-pill)] bg-[var(--paper-2)] px-2 font-mono text-[0.68rem] text-[var(--ink-soft)]",
        muted && "font-sans text-[var(--ink-mute)]"
      )}
      title={scope}
    >
      <span className="max-w-[260px] truncate">{muted ? scope : formatScope(scope)}</span>
    </Badge>
  );
}
