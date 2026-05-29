"use client";

// S39 overview redesign, ported from engine (apps/web/components/overview).
// Cloud differences from engine:
//  - No header AlertsBell: needs-attention renders inline as a bordered block
//    (matches the prior cloud overview pattern).
//  - Engine CSS-var classes (--text-primary, --bg-card, --radius-card, ...)
//    translated to cloud's shadcn semantic tokens (text-foreground, bg-card,
//    border-line, rounded-lg, ...). No engine CSS imported.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUp,
  ArrowUpRight,
  CalendarClock,
  ChevronRight,
  Plug,
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

const cardClass = "rounded-lg border border-line bg-card";

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
  return (
    providerNameAliases[key] ??
    providerNameAliases[key.replace(/-/g, "")] ??
    humanizeSlug(value, "Connection")
  );
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
  return (
    <div className={cn(cardClass, "p-4")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {loading ? (
            <Skeleton className="h-7 w-16 rounded-md" />
          ) : (
            <div className="text-2xl font-semibold text-foreground">{value}</div>
          )}
          <div className="mt-1 flex items-center gap-1.5">
            {warning ? (
              <span
                className="size-1.5 rounded-full bg-amber-500"
                aria-label="Has failures"
              />
            ) : null}
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        </div>
        {sparkline && sparkline.length > 0 && !loading ? (
          <Sparkline
            data={sparkline}
            width={72}
            height={32}
            tone="overview"
            className="shrink-0 opacity-60"
          />
        ) : loading ? (
          <Skeleton className="h-8 w-[72px] rounded-md" />
        ) : null}
      </div>
      <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        {trend !== null && trend !== undefined && trend > 0 ? (
          <ArrowUp className="size-3 opacity-50" aria-hidden="true" />
        ) : null}
        <span className={trend !== null && trend !== undefined ? "opacity-70" : undefined}>
          {context}
        </span>
      </p>
    </div>
  );
}

function statusMeta(status: string) {
  const normalized = status.toLowerCase();
  if (["success", "completed", "approved"].includes(normalized)) {
    return { label: "Completed", className: "text-emerald-600", dot: "bg-emerald-500" };
  }
  if (["error", "failed", "rejected", "cancelled", "timeout"].includes(normalized)) {
    return { label: "Failed", className: "text-red-600", dot: "bg-red-500" };
  }
  if (normalized === "queued") {
    return { label: "Queued", className: "text-amber-600", dot: "bg-amber-500" };
  }
  return { label: "Running", className: "text-amber-600", dot: "bg-amber-500" };
}

function useOverview() {
  const [data, setData] = useState<SystemOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadOnce() {
      setLoading(true);
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
  }, []);

  return { data, loading };
}

function NeedsAttention({ items }: { items: SystemOverviewAttentionItem[] }) {
  if (items.length === 0) return null;
  const connectionIssues = items.filter(
    (a) => a.type === "connection_expired" || a.type === "connection_expiring",
  );
  const failures = items.filter((a) => a.type === "failure_cluster" || a.kind === "failing");

  return (
    <section className={cn(cardClass, "p-4 space-y-2")}>
      <h2 className="text-sm font-medium text-muted-foreground">Needs attention</h2>
      <div className="divide-y divide-line">
        {connectionIssues.length > 0 && (
          <Link
            href="/connections"
            className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted"
          >
            <div className="flex items-center gap-3">
              <Plug className="size-4 text-amber-600" />
              <div>
                <p className="text-sm font-medium">
                  {connectionIssues.length}{" "}
                  {connectionIssues.length === 1 ? "connection needs" : "connections need"}{" "}
                  re-authorization
                </p>
                <p className="text-xs text-muted-foreground">
                  {connectionIssues
                    .map(
                      (c) =>
                        c.provider_display_name || c.connection_id?.slice(0, 8),
                    )
                    .filter(Boolean)
                    .join(", ") || "Open Connections to fix."}
                </p>
              </div>
            </div>
            <ArrowUpRight className="size-4 text-muted-foreground" />
          </Link>
        )}
        {failures.map((item, idx) => (
          <Link
            key={`failure-${idx}`}
            href={item.action_url || "/runs"}
            className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted"
          >
            <div className="flex items-center gap-3">
              <AlertTriangle className="size-4 text-red-600" />
              <div>
                <p className="text-sm font-medium">
                  {item.worker_name
                    ? `${item.worker_name} keeps failing`
                    : "Worker keeps failing"}
                </p>
                <p className="text-xs text-muted-foreground">{item.message}</p>
              </div>
            </div>
            <ArrowUpRight className="size-4 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </section>
  );
}

function WorkerActivity({
  runs,
  loading,
}: {
  runs: SystemOverviewRunItem[];
  loading: boolean;
}) {
  return (
    <section className={cn(cardClass, "p-6 lg:col-span-2")}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Worker activity</h2>
        <Link href="/runs" className="text-xs text-muted-foreground hover:text-foreground">
          See all
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 7 }).map((_, index) => (
            <Skeleton key={index} className="h-11 w-full rounded-lg" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <div className="divide-y divide-line">
          {runs.slice(0, 8).map((run) => {
            const meta = statusMeta(run.status);
            return (
              <Link
                key={run.run_id}
                href={`/runs/${run.run_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn("size-2 shrink-0 rounded-full", meta.dot)} />
                    <span className={cn("text-xs font-medium", meta.className)}>
                      {meta.label}
                    </span>
                    <span className="truncate text-sm font-medium text-foreground">
                      {run.worker_name || humanizeSlug(run.worker_id, "Worker")}
                    </span>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{run.started_at ? formatRelative(run.started_at) : "Queued"}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDuration(run.duration_ms)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="rounded-full border border-line px-2 py-0.5">
                      {formatTriggerSource(run.trigger_source)}
                    </span>
                  </p>
                </div>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
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
}: {
  items: SystemOverviewScheduledItem[];
  loading: boolean;
}) {
  return (
    <section className={cn(cardClass, "p-6")}>
      <h2 className="mb-3 text-sm font-semibold text-foreground">Coming up today</h2>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-44 flex-col items-center justify-center text-center">
          <CalendarClock className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
          <p className="max-w-48 text-sm font-medium text-foreground">
            No runs scheduled in the next 24 hours
          </p>
          <Link
            href="/workers"
            className="mt-3 text-xs font-medium text-foreground hover:underline"
          >
            Schedule a worker →
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((item) => (
            <Link
              key={`${item.worker_id}-${item.next_fire_at}`}
              href={`/workers/${item.worker_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="grid grid-cols-[48px_1fr] gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted"
            >
              <span className="text-sm font-medium text-foreground">
                {formatTimeOfDay(item.next_fire_at)}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block truncate text-sm text-foreground",
                    item.paused && "line-through decoration-muted-foreground",
                  )}
                >
                  {item.worker_name || humanizeSlug(item.worker_id, "Worker")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {formatRelativeFuture(item.next_fire_at)} ·{" "}
                  {formatTriggerSource(item.trigger_source || item.trigger_label)}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export function OverviewDashboard() {
  const { data, loading } = useOverview();

  const workerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const run of data?.recent_runs ?? []) {
      if (run.worker_id && run.worker_name) names.set(run.worker_id, run.worker_name);
    }
    for (const item of data?.scheduled_today ?? []) {
      if (item.worker_id && item.worker_name) names.set(item.worker_id, item.worker_name);
    }
    for (const outcome of data?.outcomes ?? []) {
      if (outcome.worker_id && outcome.worker_name)
        names.set(outcome.worker_id, outcome.worker_name);
    }
    return names;
  }, [data]);

  const attentionItems = useMemo(
    () =>
      (data?.needs_attention ?? []).map((item) => ({
        ...item,
        worker_name:
          item.worker_name ||
          (item.worker_id
            ? workerNames.get(item.worker_id) || humanizeSlug(item.worker_id, "Worker")
            : undefined),
        provider_display_name: item.provider_display_name
          ? formatProviderName(item.provider_display_name)
          : item.provider_slug
            ? formatProviderName(item.provider_slug)
            : item.provider_display_name,
      })),
    [data?.needs_attention, workerNames],
  );

  const completedThisWeek =
    data?.stats.work_shipped_7d ??
    data?.outcomes?.reduce((total, item) => total + item.count, 0) ??
    0;
  const previousWeek = data?.stats.work_shipped_previous_7d ?? 0;
  const workTrend = metricTrend(completedThisWeek, previousWeek);
  const nextScheduledAt =
    data?.stats.next_scheduled_at ?? data?.scheduled_today?.[0]?.next_fire_at ?? null;
  const nextScheduled = nextScheduledAt
    ? `Next at ${formatTimeOfDay(nextScheduledAt)}`
    : "No scheduled runs";
  const heroCount = completedThisWeek || data?.stats.runs_24h || 0;
  const runsToday = data?.stats.runs_today ?? data?.stats.runs_24h ?? 0;
  const completedToday = data?.stats.completed_today;
  const failedToday = data?.stats.failed_today;
  const hasRunBreakdown = completedToday !== undefined || failedToday !== undefined;

  const runs7dSparkline = useMemo(
    () => data?.stats.runs_7d_sparkline ?? [],
    [data?.stats.runs_7d_sparkline],
  );

  const metrics = useMemo(
    () => [
      {
        value: completedThisWeek,
        label: "Work shipped",
        context:
          workTrend !== null
            ? `${workTrend >= 0 ? "+" : ""}${workTrend}% vs last week`
            : "This week",
        trend: workTrend,
        sparkline: runs7dSparkline,
      },
      {
        value: runsToday,
        label: "Runs today",
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
    [
      completedThisWeek,
      completedToday,
      data,
      failedToday,
      hasRunBreakdown,
      nextScheduled,
      runsToday,
      workTrend,
      runs7dSparkline,
    ],
  );

  return (
    <div className="space-y-5">
      {/* Hero — compact */}
      <section>
        <h1 className="text-xl font-semibold tracking-normal text-foreground">Work done</h1>
        <p className="mt-1 text-sm text-muted-foreground">{heroCount} outcomes this week.</p>
      </section>

      {/* Metric tiles with sparklines — S39 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} {...metric} loading={loading} />
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse"
          aria-hidden="true"
        />
        <span>
          {data?.stats.running_now ?? 0} running · {data?.stats.queued_now ?? 0} queued ·{" "}
          {data?.stats.completed_today ?? 0} completed today
        </span>
      </div>

      <NeedsAttention items={attentionItems} />

      {/* Activity + Coming up — 2-col, capped at 8 rows each */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <WorkerActivity runs={data?.recent_runs ?? []} loading={loading} />
        <ComingUp items={data?.scheduled_today ?? []} loading={loading} />
      </div>
    </div>
  );
}
