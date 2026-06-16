"use client";

// A1 refined (Federico-approved layout). Spec: /tmp/overview-a1-spec.html.
//
// Hero row: LEFT = work-done block (muted label, big number + inline sparkline,
// green delta + "vs last week", thin supporting-stats line). RIGHT = time-aware
// greeting ("Good afternoon, {firstName}") + muted date/context subline.
//
// Below a divider, two columns: LEFT (wider) "Recent work" outcome rows;
// RIGHT "What's next" combining the old "Needs attention" (now "Needs you")
// and "Coming up" groups into one card with two small group labels.
//
// Data layer (useOverview cache-first hook) is owned by a parallel lane, not
// touched here. The empty-workspace ActivationPanel path is preserved.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { useOverview as useOverviewQuery } from "@/lib/query/hooks";
import type {
  SystemOverview,
  SystemOverviewAttentionItem,
  SystemOverviewRunItem,
  SystemOverviewScheduledItem,
} from "@/lib/types";

// Retained pure helper (covered by tests/overview-worker-metric.test.ts). The
// hero's supporting-stats line shows the "workers on duty" count via this.
export function workerStatusMetric(
  stats:
    | Pick<SystemOverview["stats"], "active_workers_count" | "paused_workers_count">
    | null
    | undefined,
) {
  const active = stats?.active_workers_count ?? 0;
  const paused = stats?.paused_workers_count ?? 0;
  if (active === 0 && paused > 0) {
    return { value: paused, label: "Workers paused", context: "All workers paused" };
  }
  return {
    value: active,
    label: "Workers on duty",
    context: paused > 0 ? `${paused} paused` : "Running when triggered",
  };
}
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatRelative,
  formatRelativeFuture,
  formatTimeOfDay,
} from "@/lib/formatters";
import { cn } from "@/lib/utils";
import { workerIcon } from "@/lib/worker-icon";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { ActivationPanel } from "@/components/overview/ActivationPanel";

export type { SystemOverviewAttentionItem };

// Spec rule 2: flat-by-token: borders come from CSS variables (--bd-card is
// `none`), so the computed border width is 0px. bg-step + soft shadow only.
const cardClass =
  "rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]";

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
  gmail: "Gmail",
};

function formatProviderName(value: string | null | undefined) {
  if (!value) return "Connection";
  const key = value.toLowerCase().replace(/[\s_]+/g, "-");
  return (
    providerNameAliases[key] ??
    providerNameAliases[key.replace(/-/g, "")] ??
    humanizeSlug(value, "Connection")
  );
}

function useOverview(initialData: SystemOverview | null) {
  // Cache-first via TanStack Query. Returning to /overview within the cache
  // window renders instantly from cache; initialData seeds the cache so even the
  // first paint has no skeleton. (Data layer owned by the caching lane.)
  const q = useOverviewQuery(initialData);
  return {
    data: q.data ?? null,
    loading: q.isLoading && !q.data,
    reload: () => q.refetch(),
  };
}

// Time-aware greeting + first name. The greeting word depends on the viewer's
// local clock, which only exists client-side, computing it during SSR would
// hydrate-mismatch. We stamp it once in a client effect (mirrors how the old
// code initialized `now`). Until then we render the neutral "Hello" with no
// name so the first paint is stable.
function useGreeting() {
  const [greeting, setGreeting] = useState("Hello");
  const [firstName, setFirstName] = useState<string | null>(null);

  useEffect(() => {
    const hour = new Date().getHours();
    if (hour < 12) setGreeting("Good morning");
    else if (hour < 18) setGreeting("Good afternoon");
    else setGreeting("Good evening");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.me();
        if (cancelled) return;
        const source = me.display_name || me.email || "";
        // First token of the display name; for an email fall back to the local
        // part before the first separator.
        const raw = me.display_name
          ? source.trim().split(/\s+/)[0]
          : source.split("@")[0]?.split(/[._-]/)[0] ?? "";
        const name = raw
          ? raw.charAt(0).toUpperCase() + raw.slice(1)
          : null;
        if (name) setFirstName(name);
      } catch {
        // No name available: greeting renders without one ("Good afternoon").
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { greeting, firstName };
}

// Stable "today" stamp for the greeting subline date. Set once client-side to
// avoid SSR locale/timezone hydration mismatch.
function useTodayLabel() {
  const [label, setLabel] = useState("");
  useEffect(() => {
    setLabel(
      new Date().toLocaleDateString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
    );
  }, []);
  return label;
}

function statusMeta(status: string) {
  const normalized = status.toLowerCase();
  if (["success", "completed", "approved"].includes(normalized)) {
    return { label: "delivered", color: "var(--success)", positive: true };
  }
  if (["error", "failed", "rejected", "cancelled", "timeout"].includes(normalized)) {
    return { label: "failed", color: "var(--warning)", positive: false };
  }
  if (normalized === "queued") {
    return { label: "queued", color: "var(--text-muted)", positive: false };
  }
  if (normalized === "pending_approval") {
    return { label: "awaiting approval", color: "var(--text-muted)", positive: false };
  }
  return { label: "running", color: "var(--accent)", positive: false };
}

// Group consecutive runs by worker_id + status so repeated outcomes collapse
// into one row with a ×N count (matches prior behaviour).
type ActivityGroup = { run: SystemOverviewRunItem; count: number };

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

function WorkerRowIcon({ workerId, workerName }: { workerId: string; workerName?: string | null }) {
  const resolved = workerIcon({ id: workerId, name: workerName || undefined });
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center size-[30px] bg-[var(--bg-2)] text-[var(--text-muted)]"
      style={{ borderRadius: "var(--radius-squircle)" }}
      aria-hidden="true"
    >
      {resolved.kind === "brand" ? (
        <BrandLogo icon={resolved.slug} className="size-3.5" />
      ) : (
        <resolved.Icon className="size-3.5" />
      )}
    </span>
  );
}

// LEFT column. "Recent work": outcome rows (worker + status pill + one-line
// what-it-did + relative time). Reuses recent_runs.
function RecentWork({
  runs,
  loading,
}: {
  runs: SystemOverviewRunItem[];
  loading: boolean;
}) {
  const grouped = groupRuns(runs).slice(0, 6);
  return (
    <section className={cn(cardClass, "px-[18px] py-1.5")}>
      <div className="flex items-center justify-between py-3.5 pb-1 font-semibold">
        <h2 className="text-[15px] text-[var(--text-primary)]">Recent work</h2>
        <Link href="/runs" className="text-[12.5px] font-medium text-[var(--accent)] hover:underline">
          See all
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2 py-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-[52px] w-full rounded-[var(--radius-button)]" />
          ))}
        </div>
      ) : grouped.length === 0 ? (
        <div className="flex min-h-[120px] items-center justify-center px-6 py-10 text-center text-sm text-[var(--text-muted)]">
          No runs yet.
        </div>
      ) : (
        <div className="[&>*+*]:[border-top:var(--bd-div)]">
          {grouped.map(({ run, count }) => {
            const meta = statusMeta(run.status);
            const when = run.started_at ? formatRelative(run.started_at) : "queued";
            return (
              <Link
                key={run.run_id}
                href={`/runs?sel=${run.run_id}`}
                className="-mx-[18px] flex items-start gap-3 px-[18px] py-3 transition-colors hover:bg-[var(--active-nav-bg)]"
              >
                <WorkerRowIcon workerId={run.worker_id} workerName={run.worker_name} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                      {run.worker_name || humanizeSlug(run.worker_id, "Worker")}
                    </span>
                    <span
                      className="rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-semibold leading-none"
                      style={{
                        color: meta.color,
                        background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
                      }}
                    >
                      {meta.label}
                    </span>
                    {count > 1 && (
                      <span className="text-[11px] font-medium text-[var(--text-muted)]">
                        x{count}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-[var(--text-muted)]">
                    {humanizeSlug(run.trigger_source, "Ran")} run
                  </p>
                </div>
                <span className="shrink-0 text-[12.5px] text-[var(--ink-faint)]">{when}</span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Map a needs-attention item to a human label + action link, mirroring the
// AlertsBell action routing (View worker / Reconnect / Add connection).
function attentionAction(item: SystemOverviewAttentionItem): {
  title: string;
  detail: string;
  actionLabel: string;
  href: string;
} {
  const kind = item.kind ?? item.type;
  const workerLabel = item.worker_name || humanizeSlug(item.worker_id, "Worker");
  if (["connection_expired", "connection_expiring"].includes(kind)) {
    const provider = formatProviderName(
      item.provider_display_name || item.provider_names?.[0] || item.provider_slug,
    );
    return {
      title: `${provider} needs reconnect`,
      detail: item.message || "Connection expired",
      actionLabel: "Reconnect",
      href: "/connections",
    };
  }
  if (kind === "missing_connection") {
    return {
      title: `${workerLabel} needs a connection`,
      detail: item.message || "Add a connection to run",
      actionLabel: "Add",
      href: `/connections?worker=${encodeURIComponent(item.worker_id ?? "")}`,
    };
  }
  if (item.type === "setup_incomplete") {
    return {
      title: `${workerLabel} needs setup`,
      detail: item.message || "Add a secret to run",
      actionLabel: "Set up",
      href: `/connections/secrets?return_to=${encodeURIComponent(`/workers?sel=${item.worker_id ?? ""}`)}`,
    };
  }
  // Default: failing worker.
  return {
    title: `${workerLabel} failed`,
    detail:
      item.recent_failure_count
        ? `${item.recent_failure_count} failures in 24h`
        : item.message || "Run failed",
    actionLabel: "Fix",
    href: item.worker_id ? `/runs?worker=${item.worker_id}&status=failed` : "/runs",
  };
}

// RIGHT column. "What's next": "Needs you" group (shown only when there are
// attention items) then "Coming up" group (scheduled runs). Replaces the old
// separate Needs-attention / Coming-up split.
function WhatsNext({
  attention,
  scheduled,
  loading,
}: {
  attention: SystemOverviewAttentionItem[];
  scheduled: SystemOverviewScheduledItem[];
  loading: boolean;
}) {
  const needs = attention.slice(0, 4);
  const coming = scheduled.slice(0, 4);
  const empty = !loading && needs.length === 0 && coming.length === 0;
  return (
    <section className={cn(cardClass, "px-[18px] py-1.5")}>
      <div className="py-3.5 pb-1 text-[15px] font-semibold text-[var(--text-primary)]">
        What&rsquo;s next
      </div>
      {loading ? (
        <div className="space-y-2 py-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-[48px] w-full rounded-[var(--radius-button)]" />
          ))}
        </div>
      ) : empty ? (
        <div className="flex min-h-[120px] flex-col items-center justify-center px-6 py-10 text-center">
          <p className="text-sm font-medium text-[var(--text-primary)]">Nothing needs you</p>
          <Link
            href="/workers"
            className="mt-2 text-xs font-medium text-[var(--accent)] hover:underline"
          >
            Schedule a worker
          </Link>
        </div>
      ) : (
        <>
          {needs.length > 0 && (
            <>
              <div className="px-0 pt-3 pb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--ink-faint)]">
                Needs you
              </div>
              <div className="[&>*+*]:[border-top:var(--bd-div)]">
                {needs.map((item, idx) => {
                  const a = attentionAction(item);
                  return (
                    <div
                      key={`needs-${item.worker_id ?? item.connection_id ?? idx}`}
                      className="flex items-start gap-3 py-3"
                    >
                      <span
                        className="mt-1.5 size-[7px] shrink-0 rounded-[var(--radius-pill)] bg-[var(--warning)]"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                          {a.title}
                        </div>
                        <div className="mt-0.5 truncate text-[12.5px] text-[var(--text-muted)]">
                          {a.detail}
                        </div>
                      </div>
                      <Link
                        href={a.href}
                        className="shrink-0 text-[12.5px] font-medium text-[var(--accent)] hover:underline"
                      >
                        {a.actionLabel}
                      </Link>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {coming.length > 0 && (
            <>
              <div className="px-0 pt-3 pb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--ink-faint)]">
                Coming up
              </div>
              <div className="[&>*+*]:[border-top:var(--bd-div)]">
                {coming.map((item) => (
                  <Link
                    key={`${item.worker_id}-${item.next_fire_at}`}
                    href={`/workers?sel=${item.worker_id}`}
                    className="-mx-[18px] flex items-start gap-3 px-[18px] py-3 transition-colors hover:bg-[var(--active-nav-bg)]"
                  >
                    <span
                      className="mt-1.5 size-[7px] shrink-0 rounded-[var(--radius-pill)] bg-[var(--accent)]"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          "truncate text-sm font-semibold",
                          item.paused ? "text-[var(--text-muted)]" : "text-[var(--text-primary)]",
                        )}
                      >
                        {item.worker_name || humanizeSlug(item.worker_id, "Worker")}
                      </div>
                      <div className="mt-0.5 truncate text-[12.5px] text-[var(--text-muted)]">
                        {formatRelativeFuture(item.next_fire_at)} at {formatTimeOfDay(item.next_fire_at)}
                      </div>
                    </div>
                    <span className="shrink-0 text-[12.5px] text-[var(--ink-faint)]">
                      {item.paused ? "paused" : "scheduled"}
                    </span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

export function OverviewDashboard({
  initialData = null,
}: {
  initialData?: import("@/lib/types").SystemOverview | null;
}) {
  const { data, loading } = useOverview(initialData);
  const { greeting, firstName } = useGreeting();
  const todayLabel = useTodayLabel();

  const completedThisWeek =
    data?.stats.work_shipped_7d ??
    data?.outcomes?.reduce((total, item) => total + item.count, 0) ??
    0;
  const previousWeek = data?.stats.work_shipped_previous_7d ?? 0;
  const workTrend = metricTrend(completedThisWeek, previousWeek);

  // Supporting stats line: success rate, workers on duty, est. time saved.
  const successRate = data?.stats.success_rate_7d ?? null;
  const workersOnDuty = workerStatusMetric(data?.stats).value;
  const runsToday = data?.stats.runs_today ?? data?.stats.runs_24h ?? 0;

  // No `hours_saved` field exists in SystemOverviewStats. Estimate ~15 min of
  // manual work saved per finished task (rounded to whole hours). Honest,
  // derived, and omitted when there is no work to estimate from.
  const estHoursSaved =
    completedThisWeek > 0 ? Math.max(1, Math.round((completedThisWeek * 15) / 60)) : 0;

  // 7d run-series for the inline hero sparkline. Plot the per-bucket totals as a
  // thin stroke-only accent polyline (spec: "thin stroke-only SVG polyline").
  const sparkPoints = useMemo(() => {
    const buckets = data?.stats.runs_7d_sparkline ?? [];
    if (buckets.length < 2) return null;
    const counts = buckets.map((b) => b.total);
    const max = Math.max(...counts, 1);
    const w = 150;
    const h = 44;
    const stepX = w / (counts.length - 1);
    return counts
      .map((v, i) => {
        const x = i * stepX;
        const y = h - 4 - (v / max) * (h - 8);
        return `${x.toFixed(0)},${y.toFixed(0)}`;
      })
      .join(" ");
  }, [data?.stats.runs_7d_sparkline]);

  // Empty-workspace path preserved: no active workers AND no work this week.
  const isEmptyWorkspace =
    !loading &&
    (data?.stats.active_workers_count ?? 0) === 0 &&
    completedThisWeek === 0;

  if (isEmptyWorkspace) {
    return (
      <div className="flex flex-col flex-1 pb-6 pt-1 lg:min-h-[620px] lg:overflow-auto">
        <ActivationPanel />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 pb-6 pt-1">
      {/* Hero row: work-done block left, greeting right. */}
      <section className="flex flex-col items-start justify-between gap-6 pb-5 sm:flex-row sm:items-start">
        <div>
          <div className="mb-1.5 text-[13px] text-[var(--text-muted)]">Work done this week</div>
          <div className="flex items-end gap-[18px]">
            {loading ? (
              <Skeleton className="h-[50px] w-[80px] rounded-[var(--radius-button)]" />
            ) : (
              <div className="text-[50px] font-bold leading-none tracking-[-0.025em] text-[var(--text-primary)]">
                {completedThisWeek}
              </div>
            )}
            {sparkPoints && (
              <svg
                width="150"
                height="44"
                viewBox="0 0 150 44"
                className="mb-1.5 block"
                aria-hidden="true"
              >
                <polyline
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  points={sparkPoints}
                />
              </svg>
            )}
          </div>
          <div className="mt-2 text-[13px]">
            {workTrend !== null && workTrend > 0 && (
              <span className="font-semibold text-[var(--success)]">&#8593; {workTrend}%</span>
            )}{" "}
            <span className="text-[var(--ink-faint)]">vs last week</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
            {successRate !== null && (
              <span>
                <b className="font-semibold text-[var(--text-primary)]">
                  {Math.round(successRate * (successRate <= 1 ? 100 : 1))}%
                </b>{" "}
                <span className="text-[var(--text-muted)]">success</span>
              </span>
            )}
            <span>
              <b className="font-semibold text-[var(--text-primary)]">{workersOnDuty}</b>{" "}
              <span className="text-[var(--text-muted)]">
                {workersOnDuty === 1 ? "worker on duty" : "workers on duty"}
              </span>
            </span>
            {estHoursSaved > 0 && (
              <span>
                <b className="font-semibold text-[var(--text-primary)]">~{estHoursSaved}h</b>{" "}
                <span className="text-[var(--text-muted)]">saved</span>
              </span>
            )}
          </div>
        </div>

        <div className="text-left sm:text-right">
          <div className="text-[19px] font-semibold text-[var(--text-primary)]">
            {greeting}
            {firstName ? `, ${firstName}` : ""}
          </div>
          <div className="mt-0.5 text-[12.5px] text-[var(--text-muted)]">
            {todayLabel}
            {runsToday > 0
              ? ` · ${runsToday} ${runsToday === 1 ? "worker" : "workers"} ran today`
              : ""}
          </div>
        </div>
      </section>

      {/* Divider, then the two columns. */}
      <div className="grid flex-1 grid-cols-1 gap-[18px] pt-[18px] [box-shadow:inset_0_1px_0_var(--line-soft)] lg:grid-cols-[1.35fr_1fr]">
        <RecentWork runs={data?.recent_runs ?? []} loading={loading} />
        <WhatsNext
          attention={data?.needs_attention ?? []}
          scheduled={data?.scheduled_today ?? []}
          loading={loading}
        />
      </div>
    </div>
  );
}
