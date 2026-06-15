"use client";

// S44: accepts server-fetched initialData to eliminate client-side fetch round-trip.
// S45: sparklines on metric tiles, alerts moved to AlertsBell in header.
// W8: worker icons in activity + upcoming list rows.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  CalendarClock,
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

// Spec rule 2: flat-by-token — all borders from CSS variables, never hardcoded.
// --bd-card is `none` per design tokens; use the full border shorthand so the
// computed border width is 0px when the token is none.
const cardClass =
  "rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]";
const listClass =
  "overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-list)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]";

function metricTrend(current: number, previous: number) {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export function workerStatusMetric(
  stats:
    | Pick<SystemOverview["stats"], "active_workers_count" | "paused_workers_count">
    | null
    | undefined,
) {
  const active = stats?.active_workers_count ?? 0;
  const paused = stats?.paused_workers_count ?? 0;
  if (active === 0 && paused > 0) {
    return {
      value: paused,
      label: "Workers paused",
      context: "All workers paused",
    };
  }
  return {
    value: active,
    label: "Workers active",
    context: `${paused} paused`,
  };
}

function humanizeSlug(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const normalized = value.replace(/[_-]+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
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
  href,
}: {
  value: number | string;
  label: string;
  context: string;
  trend?: number | null;
  warning?: boolean;
  loading: boolean;
  sparkline?: OverviewSparklineBucket[];
  /** Wireframe §4: tiles navigate (runs/workers). */
  href?: string;
}) {
  const hasSparkline = Boolean(sparkline && sparkline.length > 0);
  const className = cn(
    cardClass,
    "flex min-h-[152px] flex-col overflow-hidden",
    href && "cursor-pointer transition-colors hover:bg-[var(--bg-2)]",
  );
  const body = (
    <>
      {/* Stat at the top */}
      <div className="px-[18px] pt-[18px]">
        {loading ? (
          <Skeleton className="h-7 w-16 rounded-[var(--radius-button)]" />
        ) : (
          <div className="text-[26px] font-semibold leading-tight text-[var(--text-primary)]">{value}</div>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          {warning ? (
            <span
              className="size-1.5 rounded-[var(--radius-pill)] bg-[var(--warning)]"
              aria-label="Has failures"
            />
          ) : null}
          <p className="text-[13px] font-medium text-[var(--text-primary)]">{label}</p>
        </div>
        <p className="mt-1 flex items-center gap-1 text-[12.5px] text-[var(--text-muted)]">
          {trend !== null && trend !== undefined && trend > 0 ? (
            <ArrowUp className="size-3 opacity-50" aria-hidden="true" />
          ) : null}
          <span className={trend !== null && trend !== undefined ? "opacity-70" : undefined}>
            {context}
          </span>
        </p>
      </div>
      {/* Full-width sparkline pinned to the bottom, edge-to-edge */}
      <div className="mt-auto h-12">
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
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
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
    return { label: "Queued", color: "var(--text-muted)" };
  }
  if (normalized === "pending_approval") {
    return { label: "Awaiting approval", color: "var(--text-muted)" };
  }
  return { label: "Running", color: "var(--info)" };
}

function useOverview(initialData: SystemOverview | null) {
  // S44: start with server-fetched data — no loading flash on first render.
  const [data, setData] = useState<SystemOverview | null>(initialData);
  const [loading, setLoading] = useState(initialData === null);

  // Explicit reload (e.g. triggered by the bell button): shows the skeleton so
  // the user gets clear feedback that a refresh is in progress.
  const reload = useCallback(async () => {
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

  // Silent revalidation: fetches fresh data but never flashes the skeleton
  // because we already have something to paint (avoids a jarring blink when
  // switching back to the tab).
  const revalidate = useCallback(async () => {
    try {
      const result = await api.system.overview();
      setData(result);
    } catch {
      // Ignore — silently stale is better than a skeleton on focus.
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

  // Re-fetch silently when the tab regains focus so cross-view status stays
  // consistent (navigating /runs → /overview, or returning to the tab, shows
  // the latest run statuses) without flashing the skeleton on every tab switch.
  useEffect(() => {
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [revalidate]);

  return { data, loading, reload };
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
      className="inline-flex shrink-0 items-center justify-center size-5 bg-[var(--accent-soft)] text-[var(--accent)] [border:var(--bd-card)]"
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

// Group consecutive runs by worker_id + status so repeated failures ("Granola
// to HubSpot … Failed" × 5) collapse into a single row with a count badge.
// We keep groups in chronological order (most-recent first) and navigate to the
// most-recent run in the group on click.
type ActivityGroup = {
  run: SystemOverviewRunItem; // representative (most-recent) run
  count: number;
};

function groupRuns(runs: SystemOverviewRunItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const run of runs) {
    const last = groups[groups.length - 1];
    if (last && last.run.worker_id === run.worker_id && last.run.status === run.status) {
      last.count += 1;
    } else {
      groups.push({ run, count: 1 });
    }
  }
  return groups;
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
  // Dedupe consecutive repeated failures/outcomes, then cap to visibleRows.
  const grouped = groupRuns(runs).slice(0, visibleRows);
  return (
    <section className="flex min-h-0 flex-col">
      <div className="mb-3 flex items-center justify-between shrink-0">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Recent activity</h2>
        <Link href="/runs" className="text-[12.5px] text-[var(--accent)] hover:underline">
          See all
        </Link>
      </div>
      {loading ? (
        <div className={cn(listClass, "space-y-2 p-2")}>
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-[52px] w-full rounded-[var(--radius-button)]" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className={cn(listClass, "flex min-h-[220px] flex-1 items-center justify-center px-6 py-10 text-center text-sm text-[var(--text-muted)]")}>
          No runs yet.
        </div>
      ) : (
        <div className={cn(listClass, "flex-1 min-h-0 overflow-y-auto [&>*+*]:[border-top:var(--bd-div)]")}>
          {grouped.map(({ run, count }) => {
            const meta = statusMeta(run.status);
            return (
              <Link
                key={run.run_id}
                href={`/runs?sel=${run.run_id}`}
                className="flex min-h-[52px] items-center gap-3 px-[18px] py-2 transition-colors hover:bg-[var(--active-nav-bg)]"
              >
                <WorkerRowIcon workerId={run.worker_id} workerName={run.worker_name} />
                <div className="min-w-0 flex-1">
                  <span className="truncate text-sm font-medium text-[var(--text-primary)]">
                    {run.worker_name || humanizeSlug(run.worker_id, "Worker")}
                  </span>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-[var(--text-muted)]">
                    <span>{run.started_at ? formatRelative(run.started_at) : "Queued"}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDuration(run.duration_ms)}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* Count badge when the same worker repeated the same outcome */}
                  {count > 1 && (
                    <span className="text-[11px] font-medium text-[var(--text-muted)]">
                      ×{count}
                    </span>
                  )}
                  {/* V4 SPEC §4: status pill right-aligned */}
                  <span
                    className="rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-medium leading-none"
                    style={{
                      color: meta.color,
                      background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
                    }}
                  >
                    {meta.label}
                  </span>
                </div>
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
    <section className="flex min-h-0 flex-col">
      <div className="mb-3 flex items-center justify-between shrink-0">
        <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Coming up today</h2>
        <Link href="/runs" className="text-[12.5px] text-[var(--accent)] hover:underline">
          See all
        </Link>
      </div>
      {loading ? (
        <div className={cn(listClass, "space-y-2 p-2")}>
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-[56px] w-full rounded-[var(--radius-button)]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className={cn(listClass, "flex min-h-[220px] flex-1 flex-col items-center justify-center px-6 py-10 text-center")}>
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
        <div className={cn(listClass, "flex-1 min-h-0 overflow-y-auto [&>*+*]:[border-top:var(--bd-div)]")}>
          {visibleItems.map((item) => (
            <Link
              key={`${item.worker_id}-${item.next_fire_at}`}
              href={`/workers?sel=${item.worker_id}`}
              className="grid min-h-[56px] grid-cols-[52px_1fr] gap-3 px-[18px] py-2 transition-colors hover:bg-[var(--active-nav-bg)]"
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
                    <span className="shrink-0 rounded-[var(--radius-pill)] [border:var(--bd-card)] px-1.5 py-px text-[10px] font-medium leading-none text-[var(--text-muted)]">
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
}: {
  initialData?: import("@/lib/types").SystemOverview | null;
}) {
  // #1292: the needs-attention surface is now owned by the global AlertsBell
  // (rendered in AppShell), which self-fetches the overview. The dashboard no
  // longer derives/bubbles attention items or exposes a reload ref for the bell.
  const { data, loading } = useOverview(initialData);
  const visibleRows = useOverviewVisibleRows();

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
  const overviewStats = data?.stats;
  const workerMetric = useMemo(() => workerStatusMetric(overviewStats), [overviewStats]);

  const metrics = useMemo(
    () => [
      {
        value: completedThisWeek,
        label: "Runs completed",
        href: "/runs",
        // Backend scopes this to active, real workers (excludes paused/example/
        // system/listener churn) so the flagship metric reflects real outcomes,
        // not failing internal listeners. Failing listeners stay in Needs
        // attention, not here.
        context:
          workTrend !== null
            ? `${workTrend >= 0 ? "+" : ""}${workTrend}% vs last week`
            : "Last 7 days",
        trend: workTrend,
        sparkline: runs7dSparkline,
      },
      {
        value: runsToday,
        label: "Runs today",
        href: "/runs",
        // completed/failed breakdown is scoped to active, real workers (matches
        // "Runs completed" above); the runsToday total is raw activity volume.
        context: hasRunBreakdown
          ? `${completedToday ?? 0} ok · ${failedToday ?? 0} failed`
          : `${runsToday} in last 24h`,
        warning: Boolean(failedToday),
        sparkline: runs7dSparkline,
      },
      {
        value: workerMetric.value,
        label: workerMetric.label,
        href: "/workers",
        context: workerMetric.context,
        sparkline: runs7dSparkline,
      },
      {
        value: data?.stats.scheduled_24h_count ?? data?.scheduled_today?.length ?? 0,
        label: "Coming up today",
        href: "/runs",
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
      workerMetric,
    ],
  );

  return (
    <div className="flex flex-col flex-1 pb-6 pt-1 lg:min-h-[620px] lg:overflow-hidden">
      {/* Hero — compact */}
      <section className="pb-4">
        <h1 className="text-[23px] font-semibold leading-tight tracking-normal text-[var(--text-primary)]">Work done</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {completedThisWeek} {completedThisWeek === 1 ? "run" : "runs"} completed in the last 7 days.
        </p>
      </section>

      {/* Metric tiles with sparklines — S45 */}
      {/* Spec §5c: 2×2 grid at <880px, 4-col at xl. Using `sm:` (640px) as the
          first breakpoint keeps the 2×2 layout on all mobile/tablet sizes. */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} {...metric} loading={loading} />
        ))}
      </div>

      {/* Activity + Coming up — 2-col; grows to fill remaining viewport height
          so the page doesn't leave a whitespace band at the bottom. */}
      <div className="mt-7 grid grid-cols-1 gap-7 lg:grid-cols-[1.4fr_1fr] lg:flex-1 lg:min-h-0">
        <WorkerActivity runs={data?.recent_runs ?? []} loading={loading} visibleRows={visibleRows} />
        <ComingUp items={data?.scheduled_today ?? []} loading={loading} visibleRows={visibleRows} />
      </div>
    </div>
  );
}
