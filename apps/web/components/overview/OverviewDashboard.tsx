"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import yaml from "js-yaml";
import {
  AlertTriangle,
  ArrowUp,
  CalendarClock,
  ChevronRight,
  Plug,
} from "lucide-react";
import { toast } from "sonner";

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
}: {
  value: number | string;
  label: string;
  context: string;
  trend?: number | null;
  warning?: boolean;
  loading: boolean;
}) {
  return (
    <div className={cn(cardClass, "p-6")}>
      <div className="min-h-[84px]">
        {loading ? (
          <Skeleton className="h-9 w-20 rounded-lg" />
        ) : (
          <div className="text-3xl font-medium text-[var(--text-primary)]">{value}</div>
        )}
        <div className="mt-2 flex items-center gap-2">
          {warning ? (
            <span
              className="size-2 rounded-full bg-[var(--warning)]"
              aria-label="Has failures"
            />
          ) : null}
          <p className="text-sm text-[var(--text-muted)]">{label}</p>
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
  return { label: "Running", color: "var(--pending)" };
}

function useOverview() {
  const [data, setData] = useState<SystemOverview | null>(null);
  const [loading, setLoading] = useState(true);

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

  return { data, loading, reload: load };
}

function groupAttention(items: SystemOverviewAttentionItem[]) {
  const failures = items.filter((item) => item.kind === "failing" || item.type === "failure_cluster");
  const connections = items.filter((item) =>
    ["connection_expired", "connection_expiring"].includes(item.kind || item.type),
  );
  return { failures, connections };
}

function ActionButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 items-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--active-nav-bg)] disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function LinkAction({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-7 items-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 text-xs font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--active-nav-bg)]"
    >
      {children}
    </Link>
  );
}

function setYamlPaused(content: string) {
  const parsed = yaml.load(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const next = { ...(parsed as Record<string, unknown>), paused: true };
    return yaml.dump(next, { lineWidth: 100, noRefs: true, sortKeys: false });
  }
  return `paused: true\n${content}`;
}

function NeedsAttention({
  items,
  onRefresh,
}: {
  items: SystemOverviewAttentionItem[];
  onRefresh: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const { failures, connections } = groupAttention(items);
  const openCount = failures.length + (connections.length > 0 ? 1 : 0);

  async function retry(workerId: string) {
    setBusy(`retry:${workerId}`);
    try {
      await api.workers.run(workerId, {});
      toast.success("Run queued");
      onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Retry failed");
    } finally {
      setBusy(null);
    }
  }

  async function disable(workerId: string) {
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
          content: file.path === "worker.yml" ? setYamlPaused(file.content || "") : file.content || "",
        }));
      if (!files.some((file) => file.path === "worker.yml")) {
        throw new Error("worker.yml was not available for this worker.");
      }
      await api.workers.updateFiles(workerId, files);
      toast.success("Worker disabled");
      onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Disable failed");
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return null;

  return (
    <section className={cn(cardClass, "p-6")}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Needs your attention</h2>
        <span className="rounded-full bg-[var(--active-nav-bg)] px-2.5 py-1 text-xs text-[var(--text-muted)]">
          {openCount} open
        </span>
      </div>
      <div className="space-y-2">
        {failures.map((item) => (
          <div
            key={`failure-${item.worker_id}`}
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {item.worker_name || humanizeSlug(item.worker_id, "Worker")} is failing
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {item.recent_failure_count !== null && item.recent_failure_count !== undefined
                    ? `${item.recent_failure_count} failures in 24h`
                    : item.message}
                  {item.last_failed_at ? ` · last failed ${formatRelative(item.last_failed_at)}` : ""}
                  {item.cause ? ` · ${item.cause}` : ""}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <LinkAction href={`/runs?worker=${item.worker_id}&status=failed`}>View logs</LinkAction>
                  {item.worker_id ? (
                    <ActionButton
                      onClick={() => retry(item.worker_id!)}
                      disabled={busy === `retry:${item.worker_id}`}
                    >
                      Retry
                    </ActionButton>
                  ) : null}
                  {item.worker_id ? (
                    <ActionButton
                      onClick={() => disable(item.worker_id!)}
                      disabled={busy === `disable:${item.worker_id}`}
                    >
                      Disable
                    </ActionButton>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ))}

        {connections.length > 0 ? (
          <div className="rounded-xl px-4 py-3">
            <div className="flex items-start gap-3">
              <Plug className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {connections.length} {connections.length === 1 ? "connection needs" : "connections need"} re-auth
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {connections
                    .map((item) => formatProviderName(item.provider_display_name || item.provider_names?.[0] || item.provider_slug))
                    .join(", ")}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton onClick={() => router.push("/connections")}>Reconnect all</ActionButton>
                </div>
              </div>
            </div>
          </div>
        ) : null}
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
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Worker activity</h2>
        <Link href="/runs" className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
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
        <p className="py-8 text-center text-sm text-[var(--text-muted)]">No runs yet.</p>
      ) : (
        <div className="divide-y divide-[var(--border-soft)]">
          {runs.slice(0, 10).map((run) => {
            const meta = statusMeta(run.status);
            return (
              <Link
                key={run.run_id}
                href={`/runs/${run.run_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--active-nav-bg)]"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                    <span className="text-xs font-medium" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
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
}: {
  items: SystemOverviewScheduledItem[];
  loading: boolean;
}) {
  return (
    <section className={cn(cardClass, "p-6")}>
      <h2 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Coming up today</h2>
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-44 flex-col items-center justify-center text-center">
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
        <div className="space-y-4">
          {items.map((item) => (
            <Link
              key={`${item.worker_id}-${item.next_fire_at}`}
              href={`/workers/${item.worker_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="grid grid-cols-[48px_1fr] gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--active-nav-bg)]"
            >
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {formatTimeOfDay(item.next_fire_at)}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    "block truncate text-sm text-[var(--text-primary)]",
                    item.paused && "line-through decoration-[var(--text-muted)]",
                  )}
                >
                  {item.worker_name || humanizeSlug(item.worker_id, "Worker")}
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

function fallbackSparklineBuckets(values: number[] | undefined): OverviewSparklineBucket[] {
  return (values ?? []).map((value, index) => ({
    label: `Hour ${index + 1}`,
    started_at: String(index),
    total: value,
    failed: 0,
  }));
}

function LastSevenDays({ data }: { data: SystemOverview | null }) {
  const sparkline =
    data?.stats.runs_7d_sparkline?.length
      ? data.stats.runs_7d_sparkline
      : fallbackSparklineBuckets(data?.stats.runs_24h_sparkline);
  return (
    <section className={cn(cardClass, "p-6")}>
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">Last 7 days</h2>
      <div className="mt-4 h-12">
        <Sparkline
          data={sparkline}
          width={760}
          height={48}
          tone="overview"
          className="h-12 w-full"
        />
      </div>
      <div className="mt-3 grid grid-cols-7 text-xs text-[var(--text-muted)]">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
    </section>
  );
}

export function OverviewDashboard() {
  const { data, loading, reload } = useOverview();
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
  const heroCount = completedThisWeek || data?.stats.runs_24h || 0;
  const runsToday = data?.stats.runs_today ?? data?.stats.runs_24h ?? 0;
  const completedToday = data?.stats.completed_today;
  const failedToday = data?.stats.failed_today;
  const hasRunBreakdown = completedToday !== undefined || failedToday !== undefined;

  const metrics = useMemo(
    () => [
      {
        value: completedThisWeek,
        label: "Work shipped",
        context:
          workTrend !== null
            ? `This week (${workTrend >= 0 ? "+" : ""}${workTrend}% vs last)`
            : "This week",
        trend: workTrend,
      },
      {
        value: runsToday,
        label: "Runs today",
        context: hasRunBreakdown
          ? `${completedToday ?? 0} completed · ${failedToday ?? 0} failed`
          : `${runsToday} in last 24h`,
        warning: Boolean(failedToday),
      },
      {
        value: data?.stats.active_workers_count ?? 0,
        label: "Workers active",
        context: `${data?.stats.paused_workers_count ?? 0} paused`,
      },
      {
        value: data?.stats.scheduled_24h_count ?? data?.scheduled_today?.length ?? 0,
        label: "Coming up today",
        context: nextScheduled,
      },
    ],
    [completedThisWeek, completedToday, data, failedToday, hasRunBreakdown, nextScheduled, runsToday, workTrend],
  );

  return (
    <div className="space-y-6 pt-10">
      <section>
        <h1 className="text-2xl font-semibold tracking-normal text-[var(--text-primary)]">Work done</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          Your workers completed {heroCount} outcomes this week.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} {...metric} loading={loading} />
        ))}
      </div>

      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <span className="size-2 rounded-full bg-[var(--success)] motion-safe:animate-pulse" aria-hidden="true" />
        <span>
          {data?.stats.running_now ?? 0} workers running now · {data?.stats.queued_now ?? 0} queued ·{" "}
          {data?.stats.completed_today ?? 0} completed today
        </span>
      </div>

      {attentionItems.length ? (
        <NeedsAttention items={attentionItems} onRefresh={reload} />
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <WorkerActivity runs={data?.recent_runs ?? []} loading={loading} />
        <ComingUp items={data?.scheduled_today ?? []} loading={loading} />
      </div>

      <LastSevenDays data={data} />
    </div>
  );
}
