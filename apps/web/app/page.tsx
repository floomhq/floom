"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Box,
  CheckCircle2,
  Clock,
  Plug,
  Plus,
} from "lucide-react";

import { api } from "@/lib/api";
import type { SystemOverview } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Sparkline } from "@/components/Sparkline";
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
  icon: Icon,
  loading,
}: {
  label: string;
  value: string | number;
  trend?: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">
            {label}
          </p>
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div className="mt-2 text-2xl font-semibold">
          {loading ? <Skeleton className="h-8 w-16" /> : value}
        </div>
        {trend ? <div className="mt-2 text-xs text-muted-foreground">{trend}</div> : null}
      </CardContent>
    </Card>
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

  const stats = data?.stats;
  const recent = data?.recent_runs ?? [];
  const scheduled = data?.scheduled_today ?? [];
  const attention = data?.needs_attention ?? [];

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What ran, what is running, and what is next.
          </p>
        </div>
        <Link href="/workers/new">
          <Button size="sm">
            <Plus className="size-4" />
            New worker
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Runs 24h"
          value={stats?.runs_24h ?? 0}
          icon={Clock}
          loading={loading}
          trend={
            stats ? (
              <Sparkline data={stats.runs_24h_sparkline} width={96} height={24} />
            ) : null
          }
        />
        <StatCard
          label="Success 7d"
          value={stats ? `${Math.round(stats.success_rate_7d * 100)}%` : "0%"}
          icon={CheckCircle2}
          loading={loading}
        />
        <StatCard
          label="Active workers"
          value={stats?.active_workers_count ?? 0}
          icon={Box}
          loading={loading}
        />
        <StatCard
          label="Connections"
          value={
            stats
              ? `${stats.connections_healthy} / ${stats.connections_total}`
              : "0 / 0"
          }
          icon={Plug}
          loading={loading}
        />
      </div>

      {attention.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Needs attention</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
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
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Recent runs</CardTitle>
            <Link href="/runs">
              <Button variant="ghost" size="sm">
                See all
                <ArrowUpRight className="size-3.5" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="pt-0">
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
                    target="_blank"
                    rel="noopener noreferrer"
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Scheduled today</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
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
                      target="_blank"
                      rel="noopener noreferrer"
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
