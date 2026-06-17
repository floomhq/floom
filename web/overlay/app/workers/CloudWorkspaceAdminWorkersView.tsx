"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type AdminWorker = {
  id: string;
  name: string;
  visibility: string;
  owner_id: string;
  owner_email: string;
};

const API_PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";
const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";

function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  const value = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  return value && value !== "local-default" ? value : null;
}

function workspaceHeaders(): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const workspaceId = getActiveWorkspaceId();
  if (workspaceId) headers.set("x-workeros-workspace", workspaceId);
  return headers;
}

export function CloudWorkspaceAdminWorkersView() {
  const [workers, setWorkers] = useState<AdminWorker[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(new Set());

  useEffect(() => {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`${API_PROXY_BASE}/workspaces/${workspaceId}/workers`, {
      headers: workspaceHeaders(),
    })
      .then((response) => (response.ok ? response.json() : []))
      .then((data: AdminWorker[]) => {
        if (!cancelled) setWorkers(data);
      })
      .catch(() => {
        if (!cancelled) setWorkers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const workersByOwner = useMemo(() => {
    const map = new Map<string, { email: string; workers: AdminWorker[] }>();
    for (const worker of workers.filter((worker) => worker.visibility !== "shared")) {
      if (!map.has(worker.owner_id)) {
        map.set(worker.owner_id, { email: worker.owner_email, workers: [] });
      }
      map.get(worker.owner_id)?.workers.push(worker);
    }
    return Array.from(map.entries()).map(([ownerId, group]) => ({ ownerId, ...group }));
  }, [workers]);

  function toggleOwner(ownerId: string) {
    setExpandedOwners((current) => {
      const next = new Set(current);
      if (next.has(ownerId)) next.delete(ownerId);
      else next.add(ownerId);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-80" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Workspace admin</h2>
        <p className="text-sm text-muted-foreground">
          Private workers grouped by owner for the active workspace.
        </p>
      </div>

      {workersByOwner.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] p-4 text-sm text-muted-foreground">
          No private member workers found.
        </div>
      ) : (
        <div className="space-y-2">
          {workersByOwner.map((group) => {
            const expanded = expandedOwners.has(group.ownerId);
            return (
              <section
                key={group.ownerId}
                className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-soft)]"
              >
                <button
                  type="button"
                  onClick={() => toggleOwner(group.ownerId)}
                  className="flex w-full items-center gap-3 bg-[var(--bg-2)] px-4 py-3 text-left text-sm hover:bg-[var(--active-nav-bg)]"
                >
                  {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{group.email}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.workers.length} worker{group.workers.length === 1 ? "" : "s"}
                  </span>
                </button>
                {expanded ? (
                  <div className="divide-y divide-[var(--border-soft)]">
                    {group.workers.map((worker) => (
                      <div key={worker.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                        <Lock className="size-4 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/workers?sel=${encodeURIComponent(worker.id)}`}
                            className="truncate font-medium hover:underline"
                          >
                            {worker.name}
                          </Link>
                          <p className="truncate text-xs text-muted-foreground">{worker.id}</p>
                        </div>
                        <Link
                          href={`/workers?sel=${encodeURIComponent(worker.id)}`}
                          className={buttonVariants({ size: "sm", variant: "secondary" })}
                        >
                          Open
                        </Link>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
