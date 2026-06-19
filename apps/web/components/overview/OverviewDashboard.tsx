"use client";

// V4 "Brief / digest" (Maintainer-approved, scored winner). Mockup: /tmp/ov-variant-4.png.
//
// The most reduced overview. A single editorial column:
//   1. Time-aware greeting ("Good evening, {firstName}") + date line.
//   2. "Work done this week" label + the BIG near-black number (heavier/larger
//      than the greeting — the number reclaims visual primacy) + inline sparkline.
//   3. A one-sentence plain-language summary (2-line cap) composed from the same
//      overview aggregates (delta %, success %, hours saved, runs today, needs-you
//      count). The "need your input" phrase is an accent LINK to the needs-you list.
//   4. A "needs you" list (lowercase hairline label) of attention items.
//   5. A quiet hairline "Recent work" strip — the last ~3 runs, one line each
//      (worker + outcome + time), hairline dividers, no cards/borders. This kills
//      the "too empty" risk on a fresh / quiet workspace.
//
// Data layer (useOverview cache-first hook) is owned by a parallel lane, not
// touched here. Only the presentational layout changed. The empty-workspace
// ActivationPanel path is preserved.
import { type ReactNode, useEffect, useState } from "react";
import Link from "next/link";

import { useOverview as useOverviewQuery } from "@/lib/query/hooks";
import type {
  SystemOverview,
  SystemOverviewAttentionItem,
  SystemOverviewRunItem,
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

// round-09 #7: runs_today is a count of RUNS, never distinct workers. The hero
// copy used to read "N workers ran today", fabricating a worker count from the
// runs metric (live: "30 workers ran today" with 1 worker + 3 runs). This pure
// helper labels the runs_today metric honestly so the copy can never say
// "worker". Covered by tests/overview-worker-metric.test.ts.
export function runsTodayLabel(runsToday: number): "run" | "runs" {
  return runsToday === 1 ? "run" : "runs";
}
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelative } from "@/lib/formatters";
import { ActivationPanel } from "@/components/overview/ActivationPanel";
import { Sparkline } from "@/components/Sparkline";

export type { SystemOverviewAttentionItem };

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

// Quiet hairline "Recent work" strip: the last ~3 runs, one line each
// (worker name + outcome + relative time), hairline dividers, NO card/border.
// This is the anti-empty fix — it keeps the brief from reading "too empty" on a
// fresh or quiet workspace. Reuses recent_runs.
function RecentWork({
  runs,
  loading,
}: {
  runs: SystemOverviewRunItem[];
  loading: boolean;
}) {
  const grouped = groupRuns(runs).slice(0, 3);
  if (!loading && grouped.length === 0) return null;
  return (
    <section className="pt-8">
      <div className="flex items-center justify-between pb-1">
        <h2 className="text-[12.5px] font-medium text-[var(--text-muted)]">Recent work</h2>
        <Link href="/runs" className="text-[12.5px] font-medium text-[var(--accent)] hover:underline">
          See all
        </Link>
      </div>
      {loading ? (
        <div className="space-y-2 py-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-[34px] w-full rounded-[var(--radius-button)]" />
          ))}
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
                className="flex items-baseline gap-3 py-[13px] transition-colors hover:opacity-80"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">
                  {run.worker_name || humanizeSlug(run.worker_id, "Worker")}
                </span>
                <span className="shrink-0 text-[12.5px]" style={{ color: meta.color }}>
                  {meta.label}
                </span>
                {count > 1 && (
                  <span className="shrink-0 text-[11px] font-medium text-[var(--text-muted)]">
                    x{count}
                  </span>
                )}
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
      detail: item.message || "Integration expired",
      actionLabel: "Reconnect",
      href: "/connections",
    };
  }
  if (kind === "missing_connection") {
    return {
      title: `${workerLabel} needs an integration`,
      detail: item.message || "Add an integration to run",
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

// "needs you" list: attention items only (failing workers, expired connections,
// missing setup). Lowercase hairline label (NOT all-caps), a small warning dot,
// title + one-line detail, and an accent action link (Fix / Reconnect / Set up).
// "Coming up" / scheduled runs are intentionally dropped in the V4 brief — they
// live behind the bell. Rendered with id="needs-you" so the summary sentence's
// "need your input" link can anchor to it.
function NeedsYou({
  attention,
  loading,
}: {
  attention: SystemOverviewAttentionItem[];
  loading: boolean;
}) {
  const needs = attention.slice(0, 3);
  if (loading) {
    return (
      <section id="needs-you" className="pt-7">
        <div className="space-y-2 py-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-[40px] w-full rounded-[var(--radius-button)]" />
          ))}
        </div>
      </section>
    );
  }
  if (needs.length === 0) return <span id="needs-you" />;
  return (
    <section id="needs-you" className="pt-7 [box-shadow:inset_0_1px_0_var(--line-soft)]">
      <div className="pt-7 pb-1 text-[12.5px] font-medium text-[var(--text-muted)]">needs you</div>
      <div className="[&>*+*]:[border-top:var(--bd-div)]">
        {needs.map((item, idx) => {
          const a = attentionAction(item);
          return (
            <div
              key={`needs-${item.worker_id ?? item.connection_id ?? idx}`}
              className="flex items-start gap-3 py-[15px]"
            >
              <span
                className="mt-[7px] size-[7px] shrink-0 rounded-[var(--radius-pill)] bg-[var(--warning)]"
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

  // Aggregates that feed the one-sentence summary.
  const successRate = data?.stats.success_rate_7d ?? null;
  const successPct =
    successRate !== null ? Math.round(successRate * (successRate <= 1 ? 100 : 1)) : null;
  const runsToday = data?.stats.runs_today ?? data?.stats.runs_24h ?? 0;
  const needsYouCount = data?.needs_attention?.length ?? 0;

  // No `hours_saved` field exists in SystemOverviewStats. Estimate ~15 min of
  // manual work saved per finished task (rounded to whole hours). Honest,
  // derived, and omitted when there is no work to estimate from.
  const estHoursSaved =
    completedThisWeek > 0 ? Math.max(1, Math.round((completedThisWeek * 15) / 60)) : 0;

  // 7d run-series for the inline hero sparkline. The shared <Sparkline> (area
  // variant) computes its own geometry from these per-bucket {label,total}
  // buckets and adds hover tooltip + active-point dot. We only pass the raw
  // buckets through.
  const sparkBuckets = data?.stats.runs_7d_sparkline ?? [];

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

  // One-sentence plain-language summary, composed from the same aggregates.
  // Capped at 2 lines via max-w + line-clamp. The "need your input" phrase is
  // an accent LINK anchoring to the #needs-you list below. Each clause is only
  // emitted when its underlying number is real.
  const summaryParts: ReactNode[] = [];
  if (workTrend !== null && workTrend > 0) {
    summaryParts.push(
      <span key="trend">
        Up <b className="font-semibold text-[var(--text-primary)]">{workTrend}%</b> on last week
      </span>,
    );
  }
  if (successPct !== null) {
    summaryParts.push(
      <span key="success">
        <b className="font-semibold text-[var(--text-primary)]">{successPct}%</b> of runs succeeded
      </span>,
    );
  }
  if (estHoursSaved > 0) {
    summaryParts.push(
      <span key="saved">
        roughly <b className="font-semibold text-[var(--text-primary)]">{estHoursSaved} hours</b> were
        saved
      </span>,
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 pb-6 pt-1">
      {/* Content column FILLS the pane width (Maintainer 2026-06-17: "the overview
          is not properly filling the container"). The previous fixed
          max-w-[920px] cap stopped ~377px short of the Emily-panel boundary on a
          1920px screen, leaving a dead gap. The pane already bounds the width:
          the AppShell wraps page content in `max-w-7xl mx-auto px-…` between the
          sidebar and the Emily dock, so the stats card, needs-you list, and
          recent-work list now extend to fill that pane. Only the summary
          paragraph keeps its own tighter max-w-[560px] so prose lines stay
          legible. */}
      <div className="w-full">
        {/* 1. Greeting + date line. */}
        <div className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-[var(--text-primary)]">
          {greeting}
          {firstName ? `, ${firstName}` : ""}
        </div>
        <div className="mt-1 text-[13px] text-[var(--text-muted)]">{todayLabel}</div>

        {/* 2. Label + the big near-black number (heavier/larger than the
            greeting, reclaims visual primacy) + inline sparkline.
            O2/OV-ASCII: wrapped in the same framed-card treatment as the
            WorkerAsciiDiagram (bg-[var(--bg-2)], radius-card, px-5 py-4)
            so the overview hero has the same surface vocabulary as the
            worker-detail "WHAT IT DOES" panel. */}
        <div
          className="mt-9 bg-[var(--bg-2)] px-5 py-4"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          <div className="text-[13px] text-[var(--text-muted)]">Work done this week</div>
          <div className="mt-1 flex items-end gap-5">
            {loading ? (
              <Skeleton className="h-[60px] w-[96px] rounded-[var(--radius-button)]" />
            ) : (
              <div className="text-[64px] font-bold leading-none tracking-[-0.03em] text-[var(--text-primary)]">
                {completedThisWeek}
              </div>
            )}
            {!loading && sparkBuckets.length >= 2 && (
              // Reuse the shared Sparkline (area variant): hover surfaces a
              // tooltip with the bucket value + weekday label and drops an
              // active-point dot on the hovered point. Theme-aware + flat,
              // matching the rest of the DS. Replaces the old static polyline.
              <div className="mb-2 w-[150px]">
                <Sparkline
                  data={sparkBuckets}
                  width={150}
                  height={44}
                  variant="area"
                />
              </div>
            )}
          </div>
        </div>

        {/* 3. One-sentence plain-language summary (2-line cap). */}
        {!loading && (summaryParts.length > 0 || runsToday > 0 || needsYouCount > 0) && (
          <p className="mt-6 max-w-[560px] line-clamp-2 text-[15px] leading-relaxed text-[var(--text-muted)]">
            {summaryParts.map((part, i) => (
              <span key={i}>
                {i === 0 ? part : <>{i === summaryParts.length - 1 ? " and " : ", "}{part}</>}
              </span>
            ))}
            {summaryParts.length > 0 ? ". " : ""}
            {runsToday > 0 && (
              <>
                <b className="font-semibold text-[var(--text-primary)]">
                  {runsToday} {runsTodayLabel(runsToday)}
                </b>{" "}
                ran today
                {needsYouCount > 0 ? "; " : "."}
              </>
            )}
            {needsYouCount > 0 && (
              <>
                {runsToday > 0
                  ? `${needsYouCount === 1 ? "one" : needsYouCount} now `
                  : `${needsYouCount === 1 ? "One worker" : `${needsYouCount} workers`} now `}
                <Link
                  href="#needs-you"
                  className="font-medium text-[var(--accent)] hover:underline"
                >
                  {needsYouCount === 1 ? "needs your input" : "need your input"}
                </Link>
                .
              </>
            )}
          </p>
        )}

        {/* 4. "needs you" list (lowercase hairline label). */}
        <NeedsYou attention={data?.needs_attention ?? []} loading={loading} />

        {/* 5. Quiet hairline "Recent work" strip — kills the "too empty" risk. */}
        <RecentWork runs={data?.recent_runs ?? []} loading={loading} />
      </div>
    </div>
  );
}
