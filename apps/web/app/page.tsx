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
  XCircle,
} from "lucide-react";

import { api } from "@/lib/api";
import type { SystemOverview } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";

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
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
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

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <svg
      viewBox={`0 0 ${data.length * 4} 24`}
      preserveAspectRatio="none"
      className="h-6 w-24 text-emerald-500"
      aria-hidden
    >
      {data.map((v, i) => {
        const h = Math.max(1, (v / max) * 22);
        return (
          <rect
            key={i}
            x={i * 4}
            y={24 - h}
            width={3}
            height={h}
            fill="currentColor"
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}

function StatusGlyph({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === "completed" || s === "success" || s === "succeeded") {
    return <CheckCircle2 className="size-4 text-emerald-600" />;
  }
  if (s === "failed" || s === "error") {
    return <XCircle className="size-4 text-red-600" />;
  }
  return <Clock className="size-4 text-blue-600 animate-pulse" />;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatDuration(ms: number): string {
  if (!ms) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}min`;
  return `in ${Math.round(ms / 3_600_000)}h`;
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
        <Button asChild size="sm">
          <Link href="/workers/new">
            <Plus className="size-4" />
            New worker
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Runs 24h"
          value={stats?.runs_24h ?? 0}
          icon={Clock}
          loading={loading}
          trend={stats ? <Sparkline data={stats.runs_24h_sparkline} /> : null}
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
        <div className="space-y-2">
          {attention.map((item, idx) => (
            <Alert key={`${item.type}-${idx}`} variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle className="text-sm">
                {item.type === "failure_cluster"
                  ? "Worker keeps failing"
                  : item.type === "connection_expired"
                  ? "Connection expired"
                  : item.type === "connection_expiring"
                  ? "Connection expiring"
                  : "Needs attention"}
              </AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{item.message}</span>
                <Button asChild variant="ghost" size="sm">
                  <Link href={item.action_url}>
                    Open
                    <ArrowUpRight className="size-3.5" />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Recent runs</CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/runs">
                See all
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
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
                    className="flex items-center justify-between gap-3 py-3 hover:bg-accent rounded-md px-2 -mx-2 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <StatusGlyph status={r.status} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{r.worker_name}</p>
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
                      className="flex items-start justify-between gap-3 hover:bg-accent rounded-md px-2 -mx-2 py-1.5 transition-colors"
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
