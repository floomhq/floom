"use client";

// S44: accepts server-fetched initialData to eliminate client-side fetch round-trip.
// S45: sparklines on metric tiles, alerts moved to AlertsBell in header.
// W8: worker icons in activity + upcoming list rows.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  CalendarClock,
  ChevronRight,
} from "lucide-react";

import { api } from "@/lib/api";
import type {
  OverviewSparklineBucket,
  SystemOverview,
  SystemOverviewAttentionItem,
  SystemOverviewRunItem,
  SystemOverviewScheduledItem,
} from "@/lib/types";
import { Sparkline } from "@/components/Sparkline";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatDuration,
  formatRelative,
  formatRelativeFuture,
  formatTimeOfDay,
} from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { workerIcon } from "@/lib/worker-icon";
import { BrandLogo } from "@/components/connections/BrandLogo";

export type { SystemOverviewAttentionItem };

const cardClass =
  "rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]";

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

function metricTrend(current: number, previous: number) {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function humanizeSlug(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const normalized = value.replace(/[_-]+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function formatProviderName(value: string | null | undefined) {
  if (!value) return "Connection";
  const key = value.toLowerCase().replace(/[\s_]+/g, "-");
  return providerNameAliases[key] ?? providerNameAliases[key.replace(/-/g, "")] ?? humanizeSlug(value, "Connection");
}

function formatTriggerSource(value: string | null | undefined) {
  if (!value) return "schedule";
  const normalized = value.toLowerCase();
  if (normalized.includes("cron") || normalized.includes("schedule")) return "schedule";
  if (normalized.includes("manual")) return "manual";
  if (normalized.includes("webhook")) return "webhook";
  return humanizeSlug(value, "schedule").toLowerCase();
}

function MetricCard({
  value,
  label,
  context,
  trend,
  warning,
  loading,
  sparkline,
}: {
  value: number | string;
  label: string;
  context: string;
  trend?: number | null;
  warning?: boolean;
  loading: boolean;
  sparkline?: OverviewSparklineBucket[];
}) {
  const hasSparkline = Boolean(sparkline && sparkline.length > 0);
  return (
    <div className={cn(cardClass, "flex flex-col overflow-hidden")}>
      {/* Stat at the top */}
      <div className="px-4 pt-3">
        {loading ? (
          <Skeleton className="h-7 w-16 rounded-[var(--radius-button)]" />
        ) : (
          <div className="text-2xl font-semibold text-[var(--text-primary)]">{value}</div>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          {warning ? (
            <span
              className="size-1.5 rounded-[var(--radius-pill)] bg-[var(--warning)]"
              aria-label="Has failures"
            />
          ) : null}
          <p className="text-xs text-[var(--text-muted)]">{label}</p>
        </div>
        <p className="mt-2 flex items-center gap-1 text-xs text-[var(--text-muted)]">
          {trend !== null && trend !== undefined && trend > 0 ? (
            <ArrowUp className="size-3 opacity-50" aria-hidden="true" />
          ) : null}
          <span className={trend !== null && trend !== undefined ? "opacity-70" : undefined}>
            {context}
          </span>
        </p>
      </div>
      {/* Full-width sparkline pinned to the bottom, edge-to-edge */}
      <div className="mt-2 h-10">
        {loading ? (
          <Skeleton className="h-full w-full rounded-none" />
        ) : hasSparkline ? (
          <Sparkline
            data={sparkline as OverviewSparklineBucket[]}
            width={240}
            height={40}
            variant="area"
            className="h-full w-full"
          />
        ) : null}
      </div>
    </div>
  );
}

function statusMeta(status: string) {
  const normalized = status.toLowerCase();
  if (["success", "completed", "approved"].includes(normalized)) {
    return { label: "Completed", color: "var(--success)" };
  }
  if (["error", "failed", "rejected", "cancelled", "timeout"].includes(normalized)) {
    return { label: "Failed", color: "var(--warning)" };
  }
  if (normalized === "queued") {
    return { label: "Queued", color: "var(--pending)" };
  }
  if (normalized === "pending_approval") {
    return { label: "Awaiting approval", color: "var(--text-muted)" };
  }
  return { label: "Running", color: "var(--pending)" };
}

function useOverview(initialData: SystemOverview | null) {
  // S44: start with server-fetched data — no loading flash on first render.
  const [data, setData] = useState<SystemOverview | null>(initialData);
  const [loading, setLoading] = useState(initialData === null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.system.overview();
      setData(result);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadOnce() {
      // Only show the skeleton when we have nothing to paint. With
      // server-fetched initialData we revalidate silently in the background so
      // the overview never strands a stale status (e.g. a run that finished
      // after SSR still showing "Running" while /runs shows "Completed").
      if (initialData === null) setLoading(true);
      try {
        const result = await api.system.overview();
        if (!cancelled) setData(result);
      } catch (error) {
        console.error(error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadOnce();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch when the tab regains focus so cross-view status stays consistent
  // (navigating /runs -> /overview, or returning to the tab, surfaces the
  // latest run statuses rather than the value cached at SSR time).
  useEffect(() => {
    function onFocus() {
      void load();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  return { data, loading, reload: load };
}

function useOverviewVisibleRows() {
  const [rows, setRows] = useState(6);

  useEffect(() => {
    function updateRows() {
      const height = window.innerHeight;
      if (height < 820) {
        setRows(4);
      } else if (height < 940) {
        setRows(6);
      } else {
        setRows(8);
      }
    }
    updateRows();
    window.addEventListener("resize", updateRows);
    return () => window.removeEventListener("resize", updateRows);
  }, []);

  return rows;
}

// W8: small leading icon for each row — matches the squircle style from
// WorkerIconPills but at xs scale (size-5). Resolves via workerIcon() exactly
// as worker cards do: connection brand → category glyph → hash fallback.
// Overview run/scheduled items carry only id + name (no connections/tags),
// so the resolver uses name-keyword matching then stable-hash fallback.
function WorkerRowIcon({ workerId, workerName }: { workerId: string; workerName?: string | null }) {
  const resolved = workerIcon({ id: workerId, name: workerName || undefined });
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center size-5 bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[var(--accent-line)]"
      style={{ borderRadius: "var(--radius-squircle)" }}
      aria-hidden="true"
    >
      {resolved.kind === "brand" ? (
        <BrandLogo icon={resolved.slug} className="size-3" />
      ) : (
        <resolved.Icon className="size-3" />
      )}
    </span>
  );
}

function WorkerActivity({
  runs,
  loading,
  visibleRows,
}: {
  runs: SystemOverviewRunItem[];
  loading: boolean;
  visibleRows: number;
}) {
  const visibleRuns = runs.slice(0, visibleRows);
  return (
    <section className={cn(cardClass, "flex flex-col p-4 lg:col-span-2")}>
      <div className="mb-2 flex items-center justify-between shrink-0">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Worker activity</h2>
        <Link href="/runs" className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          See all
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <p className="flex flex-1 items-center justify-center py-8 text-center text-sm text-[var(--text-muted)]">No runs yet.</p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--border-soft)]">
          {visibleRuns.map((run) => {
            const meta = statusMeta(run.status);
            return (
              <Link
                key={run.run_id}
                href={`/runs?sel=${run.run_id}`}
                className="flex items-center justify-between gap-3 px-2 py-1.5 transition-colors hover:bg-[var(--active-nav-bg)]"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                    <span className="text-xs font-medium" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                    <WorkerRowIcon workerId={run.worker_id} workerName={run.worker_name} />
                    <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {run.worker_name || humanizeSlug(run.worker_id, "Worker")}
                    </span>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-muted)]">
                    <span>{run.started_at ? formatRelative(run.started_at) : "Queued"}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDuration(run.duration_ms)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="rounded-full border border-[var(--border-soft)] px-2 py-0.5">
                      {formatTriggerSource(run.trigger_source)}
                    </span>
                  </p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ComingUp({
  items,
  loading,
  visibleRows,
}: {
  items: SystemOverviewScheduledItem[];
  loading: boolean;
  visibleRows: number;
}) {
  const visibleItems = items.slice(0, Math.max(3, visibleRows - 1));
  return (
    <section className={cn(cardClass, "flex flex-col p-4")}>
      <h2 className="mb-2 text-sm font-semibold text-[var(--text-primary)] shrink-0">Coming up today</h2>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 min-h-32 flex-col items-center justify-center text-center">
          <CalendarClock className="mb-3 size-8 text-[var(--text-muted)]" aria-hidden="true" />
          <p className="max-w-48 text-sm font-medium text-[var(--text-primary)]">
            No runs scheduled in the next 24 hours
          </p>
          <Link
            href="/workers"
            className="mt-3 text-xs font-medium text-[var(--text-primary)] hover:underline"
          >
            Schedule a worker →
          </Link>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
          {visibleItems.map((item) => (
            <Link
              key={`${item.worker_id}-${item.next_fire_at}`}
              href={`/workers?sel=${item.worker_id}`}
              className="grid grid-cols-[48px_1fr] gap-3 px-2 py-1.5 transition-colors hover:bg-[var(--active-nav-bg)]"
            >
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {formatTimeOfDay(item.next_fire_at)}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <WorkerRowIcon workerId={item.worker_id} workerName={item.worker_name} />
                  <span
                    className={cn(
                      "block truncate text-sm",
                      // Paused workers are de-emphasized (muted), not struck
                      // through — strikethrough reads as cancelled/done for an
                      // item that is otherwise listed as upcoming.
                      item.paused
                        ? "text-[var(--text-muted)]"
                        : "text-[var(--text-primary)]",
                    )}
                  >
                    {item.worker_name || humanizeSlug(item.worker_id, "Worker")}
                  </span>
                  {item.paused && (
                    <span className="shrink-0 rounded-[var(--radius-pill)] border border-[var(--line)] px-1.5 py-px text-[10px] font-medium leading-none text-[var(--text-muted)]">
                      Paused
                    </span>
                  )}
                </span>
                <span className="block text-xs text-[var(--text-muted)]">
                  {formatRelativeFuture(item.next_fire_at)} · {formatTriggerSource(item.trigger_source || item.trigger_label)}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}


export function OverviewDashboard({
  initialData = null,
  onAttentionItems,
  onReloadRef,
}: {
  initialData?: import("@/lib/types").SystemOverview | null;
  /** Called after each data load so parent (header) can update the bell count */
  onAttentionItems?: (items: SystemOverviewAttentionItem[]) => void;
  /** Mutable ref that receives the reload fn so parent (bell) can trigger refresh */
  onReloadRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const { data, loading, reload } = useOverview(initialData);
  const visibleRows = useOverviewVisibleRows();
  const workerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const run of data?.recent_runs ?? []) {
      if (run.worker_id && run.worker_name) names.set(run.worker_id, run.worker_name);
    }
    for (const item of data?.scheduled_today ?? []) {
      if (item.worker_id && item.worker_name) names.set(item.worker_id, item.worker_name);
    }
    for (const outcome of data?.outcomes ?? []) {
      if (outcome.worker_id && outcome.worker_name) names.set(outcome.worker_id, outcome.worker_name);
    }
    return names;
  }, [data]);
  const attentionItems = useMemo(
    () =>
      (data?.needs_attention ?? []).map((item) => ({
        ...item,
        worker_name:
          item.worker_name ||
          (item.worker_id ? workerNames.get(item.worker_id) || humanizeSlug(item.worker_id, "Worker") : undefined),
        provider_display_name: item.provider_display_name
          ? formatProviderName(item.provider_display_name)
          : item.provider_slug
            ? formatProviderName(item.provider_slug)
            : item.provider_display_name,
      })),
    [data?.needs_attention, workerNames],
  );

  // S45: bubble attention items up so the AlertsBell in the header can show a badge
  useEffect(() => {
    if (onAttentionItems) onAttentionItems(attentionItems);
  }, [attentionItems, onAttentionItems]);

  // S45: expose reload to parent via ref so bell buttons can trigger a refresh
  useEffect(() => {
    if (onReloadRef) onReloadRef.current = reload;
  }, [reload, onReloadRef]);

  const completedThisWeek =
    data?.stats.work_shipped_7d ??
    data?.outcomes?.reduce((total, item) => total + item.count, 0) ??
    0;
  const previousWeek = data?.stats.work_shipped_previous_7d ?? 0;
  const workTrend = metricTrend(completedThisWeek, previousWeek);
  const nextScheduledAt = data?.stats.next_scheduled_at ?? data?.scheduled_today?.[0]?.next_fire_at ?? null;
  const nextScheduled = nextScheduledAt
    ? `Next at ${formatTimeOfDay(nextScheduledAt)}`
    : "No scheduled runs";
  const runsToday = data?.stats.runs_today ?? data?.stats.runs_24h ?? 0;
  const completedToday = data?.stats.completed_today;
  const failedToday = data?.stats.failed_today;
  const hasRunBreakdown = completedToday !== undefined || failedToday !== undefined;

  // S45: sparklines per metric tile
  const runs7dSparkline = useMemo(
    () => data?.stats.runs_7d_sparkline ?? [],
    [data?.stats.runs_7d_sparkline],
  );

  const metrics = useMemo(
    () => [
      {
        value: completedThisWeek,
        label: "Runs completed",
        // Backend scopes this to active, real workers (excludes paused/example/
        // system/listener churn) so the flagship metric reflects real outcomes,
        // not failing internal listeners. Failing listeners stay in Needs
        // attention, not here.
        context:
          workTrend !== null
            ? `${workTrend >= 0 ? "+" : ""}${workTrend}% vs last week`
            : "Your active workers, last 7 days",
        trend: workTrend,
        sparkline: runs7dSparkline,
      },
      {
        value: runsToday,
        label: "Runs today",
        // completed/failed breakdown is scoped to active, real workers (matches
        // "Runs completed" above); the runsToday total is raw activity volume.
        context: hasRunBreakdown
          ? `${completedToday ?? 0} ok · ${failedToday ?? 0} failed`
          : `${runsToday} in last 24h`,
        warning: Boolean(failedToday),
        sparkline: runs7dSparkline,
      },
      {
        value: data?.stats.active_workers_count ?? 0,
        label: "Workers active",
        context: `${data?.stats.paused_workers_count ?? 0} paused`,
        sparkline: runs7dSparkline,
      },
      {
        value: data?.stats.scheduled_24h_count ?? data?.scheduled_today?.length ?? 0,
        label: "Coming up today",
        context: nextScheduled,
        sparkline: runs7dSparkline,
      },
    ],
    [completedThisWeek, completedToday, data, failedToday, hasRunBreakdown, nextScheduled, runsToday, workTrend, runs7dSparkline],
  );

  return (
    <div className="flex flex-col flex-1 space-y-3 pb-3 pt-4 lg:min-h-[620px] lg:overflow-hidden">
      {/* Hero — compact */}
      <section>
        <h1 className="text-xl font-semibold tracking-normal text-[var(--text-primary)]">Work done</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {completedThisWeek} {completedThisWeek === 1 ? "run" : "runs"} completed in the last 7 days.
        </p>
      </section>

      {/* Metric tiles with sparklines — S45 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 xl:[&>*]:min-h-[118px]">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} {...metric} loading={loading} />
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className="size-1.5 rounded-[var(--radius-pill)] bg-[var(--success)] motion-safe:animate-pulse" aria-hidden="true" />
        <span>
          {data?.stats.running_now ?? 0} running · {data?.stats.queued_now ?? 0} queued ·{" "}
          {data?.stats.completed_today ?? 0} completed today ·{" "}
          {data?.stats.scheduled_24h_count ?? data?.scheduled_today?.length ?? 0} scheduled
        </span>
      </div>

      {/* Activity + Coming up — 2-col; grows to fill remaining viewport height
          so the page doesn't leave a whitespace band at the bottom. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 lg:flex-1 lg:min-h-0">
        <WorkerActivity runs={data?.recent_runs ?? []} loading={loading} visibleRows={visibleRows} />
        <ComingUp items={data?.scheduled_today ?? []} loading={loading} visibleRows={visibleRows} />
      </div>
    </div>
  );
}
