"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Plug,
} from "lucide-react";

import { api } from "@/lib/api";
import type { SystemOverview } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { RunStatusGlyph } from "@/components/RunStatus";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import {
  formatDuration,
  formatRelative,
  formatRelativeFuture,
  formatTimeOfDay,
} from "@/lib/formatters";

function StatCard({
  label,
  value,
  trend,
  loading,
}: {
  label: string;
  value: string | number;
  trend?: React.ReactNode;
  loading: boolean;
}) {
  return (
    // S29q: flat KPIs.
    // S29y: dropped the icon entirely. With no card border to anchor it,
    // the right-aligned icon (justify-between) was orphaned at the column
    // edge — Federico called it out ("what is this"). The labels carry
    // their own meaning; the icons were decorative.
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="text-2xl font-semibold">
        {loading ? <Skeleton className="h-8 w-16" /> : value}
      </div>
      {trend ? <div className="text-xs text-muted-foreground">{trend}</div> : null}
    </div>
  );
}

export default function OverviewPage() {
  const [data, setData] = useState<SystemOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await api.system.overview();
        if (!cancelled) setData(result);
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const outcomes = data?.outcomes ?? [];
  const completedThisWeek = outcomes.reduce((total, item) => total + item.count, 0);
  const fallbackOutcomes = [
    { label: "Leads researched", value: 0, trend: "Ready when a worker completes" },
    { label: "Follow-ups drafted", value: 0, trend: "Ready when a worker completes" },
    { label: "Invoices processed", value: 0, trend: "Ready when a worker completes" },
  ];
  const outcomeTiles = [
    {
      label: "What got done this week",
      value: completedThisWeek,
      trend: "Completed in the last 7 days",
    },
    ...outcomes.map((item) => ({
      label: item.label,
      value: item.count,
      trend: item.worker_name,
    })),
  ];
  const tiles = [
    ...outcomeTiles,
    ...fallbackOutcomes.slice(0, Math.max(0, 4 - outcomeTiles.length)),
  ].slice(0, 4);
  const recent = data?.recent_runs ?? [];
  const scheduled = data?.scheduled_today ?? [];
  const attention = data?.needs_attention ?? [];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Work done</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Outcomes completed by your AI workers, plus what needs attention next.
          </p>
        </div>
        {/* S29p: dropped duplicate "+ New worker" header CTA — the sidebar
            already has the saturated primary. ChatGPT principle 11: one
            primary action per screen. */}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {tiles.map((tile) => (
          <StatCard
            key={tile.label}
            label={tile.label}
            value={tile.value}
            loading={loading}
            trend={tile.trend}
          />
        ))}
      </div>

      {attention.length > 0 && (
        // S29q: kept as the one bordered block on home (audit P-3: reserve
        // Card for genuine alarm state). Heading style matches sister
        // sections though — no CardTitle.
        <section className="border border-line p-4 space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Needs attention</h2>
          <div>
            {(() => {
              const expired = attention.filter(
                (a) => a.type === "connection_expired" || a.type === "connection_expiring",
              );
              const failures = attention.filter((a) => a.type === "failure_cluster");
              return (
                <div className="divide-y">
                  {/* PR S19 (I-7 + I-10): collapse N connection issues into one
                      informational row; reserve destructive variant for actual
                      worker failures. Per-connection details linked below. */}
                  {expired.length > 0 && (
                    <Link
                      href="/connections"
                      className="flex items-center justify-between gap-3 py-3 px-2 -mx-2 rounded-md hover:bg-muted transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <Plug className="size-4 text-amber-600" />
                        <div>
                          <p className="text-sm font-medium">
                            {expired.length}{" "}
                            {expired.length === 1 ? "connection needs" : "connections need"}{" "}
                            re-authorization
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {expired
                              .map((c) => c.provider_display_name || c.connection_id?.slice(0, 8))
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
                      href={item.action_url}
                      className="flex items-center justify-between gap-3 py-3 px-2 -mx-2 rounded-md hover:bg-muted transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <AlertTriangle className="size-4 text-red-600" />
                        <div>
                          <p className="text-sm font-medium">Worker keeps failing</p>
                          <p className="text-xs text-muted-foreground">{item.message}</p>
                        </div>
                      </div>
                      <ArrowUpRight className="size-4 text-muted-foreground" />
                    </Link>
                  ))}
                </div>
              );
            })()}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* S29q: dropped Card wrapper. Section heading + content sit flat
            on the page background; matches Overview tab rhythm. */}
        <section className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Recent runs</h2>
            <Link href="/runs" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              See all
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
          <div>
            {loading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No runs yet. Run a worker to see it here.
              </p>
            ) : (
              <div className="divide-y">
                {recent.map((r) => (
                  <Link
                    key={r.run_id}
                    href={`/runs/${r.run_id}`}
                    className="flex items-center justify-between gap-3 py-3 hover:bg-muted rounded-md px-2 -mx-2 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <WorkerAvatar seed={r.worker_id || r.worker_name} name={r.worker_name} size="size-8" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium">{r.worker_name}</p>
                          <RunStatusGlyph status={r.status} className="size-3.5" />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatRelative(r.started_at)} · {formatDuration(r.duration_ms)} ·{" "}
                          {r.trigger_source}
                        </p>
                      </div>
                    </div>
                    <ArrowUpRight className="size-4 text-muted-foreground shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Scheduled today</h2>
          <div>
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : scheduled.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing scheduled today.
              </p>
            ) : (
              <ul className="space-y-3">
                {scheduled.map((item) => (
                  <li key={`${item.worker_id}-${item.next_fire_at}`}>
                    <Link
                      href={`/workers/${item.worker_id}`}
                      className="flex items-start justify-between gap-3 hover:bg-muted rounded-md px-2 -mx-2 py-1.5 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.worker_name}</p>
                        <p className="text-xs text-muted-foreground">{item.trigger_label}</p>
                      </div>
                      <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                        {formatTimeOfDay(item.next_fire_at)}
                      </Badge>
                    </Link>
                    <p className="ml-2 text-xs text-muted-foreground">
                      {formatRelativeFuture(item.next_fire_at)}
                    </p>
                    <Separator className="mt-3" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
