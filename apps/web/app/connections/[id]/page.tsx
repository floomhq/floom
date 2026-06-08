"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Zap, Trash2, RefreshCw, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RunStatusBadge } from "@/components/RunStatus";
import { BrandLogo } from "@/components/connections/BrandLogo";
import {
  getSupportedApp,
  getConnectionAccountLabel,
  getConnectionScopes,
  type ConnectionRecord,
} from "@/components/connections/connection-data";
import { api } from "@/lib/api";
import { formatAbsolute, formatDuration } from "@/lib/formatters";
import type { ConnectionItem, ConnectionTestResult, RunSummary } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function StatusPill({ status }: { status: string }) {
  if (status === "active") {
    return (
      <span className="inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--positive)_24%,var(--line))] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] px-2.5 py-1 text-xs font-medium text-[var(--positive)]">
        Active
      </span>
    );
  }
  const label =
    status === "expired" ? "Expired" : status === "failed" ? "Failed" : status === "initiated" ? "Connecting" : "Inactive";
  return (
    <span className="inline-flex items-center rounded-full border border-[color-mix(in_srgb,var(--negative)_24%,var(--line))] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] px-2.5 py-1 text-xs font-medium text-[var(--negative)]">
      {label}
    </span>
  );
}

export default function ConnectionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [connection, setConnection] = useState<ConnectionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activity, setActivity] = useState<RunSummary[]>([]);
  const [emailPeek, setEmailPeek] = useState<Array<{ subject: string; from_name: string; from_email: string; date: string }>>([]);

  useEffect(() => {
    void (async () => {
      try {
        const all = await api.connections.list();
        const found = all.find((c) => c.id === id);
        if (!found) {
          setError("Connection not found.");
        } else {
          setConnection(found as ConnectionRecord);
          // Try to hydrate account info
          try {
            const account = await api.connections.accountInfo(id);
            if (account) {
              setConnection((prev) =>
                prev ? { ...prev, email: account.email, scopes: account.scopes ?? prev.scopes } : prev
              );
            }
          } catch {
            // non-fatal
          }
          // Load activity log (best-effort)
          try {
            const runs = await api.connections.activity(id);
            setActivity(runs);
          } catch {
            // non-fatal
          }
          // Load email peek for gmail connections (best-effort, privacy-conscious)
          try {
            const peek = await api.connections.peek(id);
            if (peek.emails.length > 0) setEmailPeek(peek.emails);
          } catch {
            // non-fatal
          }
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load connection");
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.connections.test(id);
      setTestResult(result);
      if (result.status === "valid") {
        toast.success("Connection is valid");
      } else if (result.status === "expired") {
        toast.warning("Connection expired — reconnect to restore access");
      } else {
        toast.error(`Test failed: ${result.reason}`);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const updated = await api.connections.status(id);
      setConnection(updated as ConnectionRecord);
      toast.success("Status refreshed");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.connections.delete(id);
      toast.success("Connection disconnected");
      router.push("/connections");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6 space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  if (error || !connection) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => router.push("/connections")}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--ink-soft)] hover:text-[var(--ink)] transition-colors"
        >
          <ArrowLeft className="size-4" />
          Connections
        </button>
        <p className="text-sm text-[var(--negative)]">{error ?? "Connection not found."}</p>
      </div>
    );
  }

  const app = connection.kind === "mcp"
    ? { displayName: connection.mcp_label || connection.app_name, icon: "" }
    : getSupportedApp(connection.app_name);

  const accountLabel = connection.kind === "mcp"
    ? (connection.mcp_url || "MCP server")
    : getConnectionAccountLabel(connection);

  const scopes = connection.kind === "mcp"
    ? (connection.mcp_allowed_tools ?? [])
    : getConnectionScopes(connection);

  const isBroken =
    connection.status === "expired" ||
    connection.status === "failed";

  return (
    <>
      <div className="space-y-6">
        {/* Back link */}
        <button
          type="button"
          onClick={() => router.push("/connections")}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--ink-soft)] hover:text-[var(--ink)] transition-colors"
        >
          <ArrowLeft className="size-4" />
          Connections
        </button>

        {/* Header card */}
        <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              {app.icon && (
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--bg-app)]">
                  <BrandLogo icon={app.icon} className="size-5" />
                </div>
              )}
              <div>
                <h1 className="text-xl font-semibold text-[var(--ink)]">{app.displayName}</h1>
                <p className="mt-0.5 text-sm text-[var(--ink-soft)]">{accountLabel}</p>
              </div>
            </div>
            <StatusPill status={connection.status} />
          </div>

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--border-default)] pt-5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={testing}
            >
              <Zap className="size-3.5" />
              {testing ? "Testing..." : "Test connection"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Refreshing..." : "Refresh status"}
            </Button>
            {isBroken && connection.kind !== "mcp" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  window.location.href = `/connections/connect/${encodeURIComponent(connection.app_name)}?return_to=${encodeURIComponent(`/connections/${id}`)}`;
                }}
              >
                <RefreshCw className="size-3.5" />
                Reconnect
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-[var(--negative)] hover:bg-[color-mix(in_srgb,var(--negative)_8%,transparent)] hover:text-[var(--negative)]"
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
            >
              <Trash2 className="size-3.5" />
              Disconnect
            </Button>
          </div>

          {/* Test result */}
          {testResult && (
            <div
              className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
                testResult.status === "valid"
                  ? "border-[color-mix(in_srgb,var(--positive)_24%,var(--line))] bg-[color-mix(in_srgb,var(--positive)_8%,transparent)] text-[var(--positive)]"
                  : "border-[color-mix(in_srgb,var(--negative)_24%,var(--line))] bg-[color-mix(in_srgb,var(--negative)_8%,transparent)] text-[var(--negative)]"
              }`}
            >
              {testResult.status === "valid"
                ? "Connection is valid and working."
                : `${testResult.status === "expired" ? "Connection expired." : "Test failed."} ${testResult.reason || ""}`}
            </div>
          )}
        </div>

        {/* Scopes / Tools */}
        {scopes.length > 0 && (
          <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
            <h2 className="text-sm font-medium text-[var(--ink)] mb-3">
              {connection.kind === "mcp" ? "Allowed tools" : "Granted scopes"}
              <span className="ml-2 text-[var(--ink-soft)] font-normal">({scopes.length})</span>
            </h2>
            <ul className="space-y-1">
              {scopes.map((scope) => (
                <li key={scope} className="font-mono text-xs text-[var(--ink-soft)] bg-[var(--bg-app)] rounded px-2 py-1 inline-block mr-1 mb-1">
                  {scope}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Connection info */}
        <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
          <h2 className="text-sm font-medium text-[var(--ink)] mb-4">Connection details</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex gap-3">
              <dt className="w-32 shrink-0 text-[var(--ink-soft)]">ID</dt>
              <dd className="font-mono text-xs text-[var(--ink)] break-all">{connection.id}</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Status</dt>
              <dd className="text-[var(--ink)]">{connection.status}</dd>
            </div>
            {connection.last_checked_at && (
              <div className="flex gap-3">
                <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Last checked</dt>
                <dd className="text-[var(--ink)]">
                  {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(connection.last_checked_at))}
                </dd>
              </div>
            )}
            {connection.last_check_status && (
              <div className="flex gap-3">
                <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Last check result</dt>
                <dd className="text-[var(--ink)]">{connection.last_check_status}</dd>
              </div>
            )}
            <div className="flex gap-3">
              <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Created</dt>
              <dd className="text-[var(--ink)]">
                {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(connection.created_at))}
              </dd>
            </div>
          </dl>
        </div>

        {/* Recent emails trust peek — gmail only, shown only when data is available */}
        {emailPeek.length > 0 && (
          <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
            <h2 className="flex items-center gap-2 text-sm font-medium text-[var(--ink)] mb-4">
              <Mail className="size-3.5 text-[var(--ink-soft)]" aria-hidden="true" />
              Recent emails
              <span className="text-[var(--ink-soft)] font-normal">(trust signal — live from your account)</span>
            </h2>
            <ul className="divide-y divide-[var(--border-default)]">
              {emailPeek.map((email, i) => (
                <li key={i} className="py-2.5 first:pt-0 last:pb-0">
                  <p className="text-sm text-[var(--ink)] truncate">{email.subject || "(no subject)"}</p>
                  <p className="mt-0.5 text-xs text-[var(--ink-soft)] truncate">
                    {email.from_name
                      ? `${email.from_name} <${email.from_email}>`
                      : email.from_email}
                    {email.date && (
                      <span className="ml-2 text-[var(--ink-faint)]">
                        {(() => {
                          try {
                            return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(email.date));
                          } catch {
                            return email.date;
                          }
                        })()}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Activity log */}
        <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
          <h2 className="text-sm font-medium text-[var(--ink)] mb-4">
            Activity
            {activity.length > 0 && (
              <span className="ml-2 text-[var(--ink-soft)] font-normal">({activity.length} recent runs)</span>
            )}
          </h2>
          {activity.length === 0 ? (
            <p className="text-sm text-[var(--ink-soft)]">
              No runs yet for workers using this connection.
            </p>
          ) : (
            <div className="divide-y divide-[var(--border-default)]">
              {activity.map((run) => (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 hover:bg-[var(--bg-app)] -mx-2 px-2 rounded transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <RunStatusBadge status={run.status} />
                    <span className="font-mono text-xs text-[var(--ink-soft)] truncate">{run.id}</span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs text-[var(--ink-soft)]">
                    {run.duration_ms != null && (
                      <span>{formatDuration(run.duration_ms)}</span>
                    )}
                    {run.created_at && (
                      <span>{formatAbsolute(run.created_at)}</span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Disconnect confirmation */}
      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Disconnect {app.displayName}?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {accountLabel
              ? `${accountLabel} will lose access. Workers using this connection will stop working.`
              : "Workers using this connection will stop working."}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? "Disconnecting..." : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
