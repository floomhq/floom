"use client";

// S45: Notifications bell. Moves "Needs your attention" out of /overview body
// into a header-anchored popover. Same row format as S43 NeedsAttention, but
// inside a compact 380px dropdown — no colored left borders, no warm-tint bg.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, CheckCircle, KeyRound, Plug } from "lucide-react";
import { toast } from "sonner";
import yaml from "js-yaml";

import { api } from "@/lib/api";
import type { SystemOverviewAttentionItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const providerNameAliases: Record<string, string> = {
  github: "GitHub",
  googlecalendar: "Google Calendar",
  "google-calendar": "Google Calendar",
  googledrive: "Google Drive",
  "google-drive": "Google Drive",
  hubspot: "HubSpot",
  notion: "Notion",
  salesforce: "Salesforce",
  slack: "Slack",
};

function humanizeSlug(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const normalized = value.replace(/[_-]+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function formatProviderName(value: string | null | undefined) {
  if (!value) return "Connection";
  const key = value.toLowerCase().replace(/[\s_]+/g, "-");
  return (
    providerNameAliases[key] ??
    providerNameAliases[key.replace(/-/g, "")] ??
    humanizeSlug(value, "Connection")
  );
}

function formatRelative(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function setYamlPaused(content: string) {
  const parsed = yaml.load(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const next = { ...(parsed as Record<string, unknown>), paused: true };
    return yaml.dump(next, { lineWidth: 100, noRefs: true, sortKeys: false });
  }
  return `paused: true\n${content}`;
}

interface AlertsBellProps {
  /** Items from the /overview endpoint — pass directly from parent. */
  items: SystemOverviewAttentionItem[];
  onRefresh?: () => void;
}

export function AlertsBell({ items, onRefresh }: AlertsBellProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchApprovalCount() {
      try {
        const res = await api.approvals.count();
        if (!cancelled) setPendingApprovals(res.pending);
      } catch {
        // ignore
      }
    }
    fetchApprovalCount();
    const interval = setInterval(fetchApprovalCount, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const failures = items.filter(
    (item) => item.kind === "failing" || item.type === "failure_cluster",
  );
  const connections = items.filter((item) =>
    ["connection_expired", "connection_expiring"].includes(item.kind ?? item.type),
  );
  const setupItems = items.filter((item) => item.type === "setup_incomplete");
  const count = failures.length + (connections.length > 0 ? 1 : 0) + (setupItems.length > 0 ? 1 : 0) + (pendingApprovals > 0 ? 1 : 0);

  const retry = useCallback(
    async (workerId: string) => {
      setBusy(`retry:${workerId}`);
      try {
        await api.workers.run(workerId, {});
        toast.success("Run queued");
        onRefresh?.();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Retry failed");
      } finally {
        setBusy(null);
      }
    },
    [onRefresh],
  );

  const disable = useCallback(
    async (workerId: string) => {
      setBusy(`disable:${workerId}`);
      try {
        const worker = await api.workers.get(workerId);
        if (worker.files.some((file) => file.binary)) {
          throw new Error("Worker has binary files. Open the worker editor to disable it.");
        }
        const files = worker.files
          .filter((file) => typeof file.content === "string")
          .map((file) => ({
            path: file.path,
            content:
              file.path === "worker.yml"
                ? setYamlPaused(file.content || "")
                : file.content || "",
          }));
        if (!files.some((file) => file.path === "worker.yml")) {
          throw new Error("worker.yml was not available for this worker.");
        }
        await api.workers.updateFiles(workerId, files);
        toast.success("Worker disabled");
        onRefresh?.();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Disable failed");
      } finally {
        setBusy(null);
      }
    },
    [onRefresh],
  );

  return (
    <div className="relative flex items-center">
      <button
        ref={triggerRef}
        type="button"
        aria-label={
          count > 0
            ? `${count} worker${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} attention`
            : "Notifications — all clear"
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-ui)] transition-colors duration-150",
          count > 0
            ? "text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-[var(--ink)]"
            : "text-[var(--ink-faint)] hover:bg-[var(--active-nav-bg)] hover:text-[var(--ink-soft)]",
        )}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--warning)] px-1 text-[10px] font-semibold leading-none text-white"
          >
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Worker notifications"
          className="absolute right-0 top-full z-50 mt-2 w-[380px] rounded-[var(--radius-ui)] bg-[var(--paper)] shadow-[var(--shadow-pop)] outline-none"
        >
          <div className="[border-bottom:var(--bd-div)] px-4 py-3">
            <p className="text-sm font-semibold text-[var(--ink)]">
              {count > 0 ? `${count} item${count === 1 ? "" : "s"} need attention` : "Notifications"}
            </p>
          </div>

          <div className="max-h-[400px] overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <Bell className="h-6 w-6 text-[var(--ink-faint)]" aria-hidden="true" />
                <p className="text-sm text-[var(--ink-soft)]">All workers running normally</p>
              </div>
            ) : (
              <div className="[&>*+*]:[border-top:var(--bd-div)]">
                {failures.map((item) => (
                  <div key={`failure-${item.worker_id}`} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <AlertTriangle
                        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--ink)]">
                          {item.worker_name || humanizeSlug(item.worker_id, "Worker")} is failing
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
                          {item.recent_failure_count !== null &&
                          item.recent_failure_count !== undefined
                            ? `${item.recent_failure_count} failures in 24h`
                            : item.message}
                          {item.last_failed_at
                            ? ` · last failed ${formatRelative(item.last_failed_at)}`
                            : ""}
                          {item.cause ? ` · ${item.cause}` : ""}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {item.worker_id && (
                            <Link
                              href={`/workers?sel=${encodeURIComponent(item.worker_id)}`}
                              onClick={() => setOpen(false)}
                              className="inline-flex h-6 items-center rounded-[var(--radius-ui)] bg-[var(--paper)] px-2.5 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] transition-colors"
                            >
                              View worker
                            </Link>
                          )}
                          <Link
                            href={`/runs?worker=${item.worker_id}&status=failed`}
                            onClick={() => setOpen(false)}
                            className="inline-flex h-6 items-center rounded-[var(--radius-ui)] bg-[var(--paper)] px-2.5 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] transition-colors"
                          >
                            View logs
                          </Link>
                          {item.worker_id && (
                            <button
                              type="button"
                              onClick={() => retry(item.worker_id!)}
                              disabled={busy === `retry:${item.worker_id}`}
                              className="inline-flex h-6 items-center rounded-[var(--radius-ui)] bg-[var(--paper)] px-2.5 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] transition-colors disabled:opacity-40"
                            >
                              Retry
                            </button>
                          )}
                          {item.worker_id && (
                            <button
                              type="button"
                              onClick={() => disable(item.worker_id!)}
                              disabled={busy === `disable:${item.worker_id}`}
                              className="inline-flex h-6 items-center rounded-[var(--radius-ui)] bg-[var(--paper)] px-2.5 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] transition-colors disabled:opacity-40"
                            >
                              Disable
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {connections.length > 0 && (
                  <div className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <Plug
                        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-soft)]"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--ink)]">
                          {connections.length}{" "}
                          {connections.length === 1 ? "connection needs" : "connections need"} re-auth
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
                          {connections
                            .map((item) =>
                              formatProviderName(
                                item.provider_display_name ||
                                  item.provider_names?.[0] ||
                                  item.provider_slug,
                              ),
                            )
                            .join(", ")}
                        </p>
                        <div className="mt-2">
                          <Link
                            href="/connections"
                            onClick={() => setOpen(false)}
                            className="inline-flex h-6 items-center rounded-[var(--radius-ui)] bg-[var(--paper)] px-2.5 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] transition-colors"
                          >
                            Reconnect all
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {setupItems.length > 0 && (
                  <div className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <KeyRound
                        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--ink)]">
                          {setupItems.length} worker{setupItems.length === 1 ? "" : "s"} need setup
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
                          {setupItems.map((item) => item.worker_name || item.worker_id).join(", ")}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {setupItems.map((item) =>
                            item.kind === "missing_connection" ? (
                              <Link
                                key={item.worker_id}
                                href="/connections"
                                onClick={() => setOpen(false)}
                                className="inline-flex h-6 items-center rounded-[var(--radius-ui)] bg-[var(--paper)] px-2.5 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] transition-colors"
                              >
                                Add connection
                              </Link>
                            ) : (
                              <Link
                                key={item.worker_id}
                                href="/connections/secrets"
                                onClick={() => setOpen(false)}
                                className="inline-flex h-6 items-center rounded-[var(--radius-ui)] bg-[var(--paper)] px-2.5 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] transition-colors"
                              >
                                Add secret
                              </Link>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {pendingApprovals > 0 && (
                  <div className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <CheckCircle
                        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--ink)]">
                          {pendingApprovals} approval{pendingApprovals === 1 ? "" : "s"} awaiting
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
                          Workers are waiting for your decision before executing.
                        </p>
                        <div className="mt-2">
                          <Link
                            href="/approvals"
                            onClick={() => setOpen(false)}
                            className="inline-flex h-6 items-center rounded-[var(--radius-ui)] bg-[var(--paper)] px-2.5 text-[11px] font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] transition-colors"
                          >
                            Review approvals
                          </Link>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
