"use client";

// Cloud overlay of the engine's WorkersClient.
// Diff against app/workers/WorkersClient.engine.tsx to see cloud-only additions:
//   - CloudWorkerSummary extends WorkerSummary with visibility
//   - CardFooterLine renders a "Shared" badge when visibility === 'shared'

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Box, ChevronRight, ChevronDown, Folder, Globe, Lock, Plus, Search, Shield, Star, Archive, LayoutGrid, Clock,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouter, useSearchParams } from "next/navigation";
import type { WorkerSummary } from "@/lib/types";
import { formatRelativeTime } from "@/components/connections/connection-data";
import { WorkerIconPills } from "@/components/WorkerIconPills";
import { StatusPill } from "@/components/collection/StatusPill";
import { workerStatusPill } from "@/lib/workers/derive";

// Cloud-only: extend WorkerSummary with workspace visibility (adds "shared") + owner.
// Use Omit to replace the engine's narrower literal union with the cloud's broader type.
type CloudWorkerSummary = Omit<WorkerSummary, "visibility"> & {
  visibility?: string;
  owner_id?: string;
};

type AdminWorkerStub = { id: string; name: string; visibility: string; owner_id: string; owner_email: string };

const API_PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";
const WS_KEY = "workeros.activeWorkspaceId";
function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(WS_KEY);
  return v && v !== "local-default" ? v : null;
}
function wsHeaders(): Headers {
  const h = new Headers({ "Content-Type": "application/json" });
  const id = getActiveWorkspaceId();
  if (id) h.set("x-workeros-workspace", id);
  return h;
}

const LS_KEY_FAVORITES = "workeros:favorites";

const SYSTEM_WORKER_ID_FALLBACK = new Set(["worker-author"]);

function isSystemWorker(w: WorkerSummary): boolean {
  return w.system === true || SYSTEM_WORKER_ID_FALLBACK.has(w.id);
}

type WorkersTab = "all" | "starred" | "recent" | "archived" | "admin";
const TAB_KEYS: WorkersTab[] = ["all", "starred", "recent", "archived", "admin"];
function isValidTab(value: string | null): value is WorkersTab {
  return value !== null && TAB_KEYS.includes(value as WorkersTab);
}

function getFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY_FAVORITES);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>) {
  try {
    localStorage.setItem(LS_KEY_FAVORITES, JSON.stringify(Array.from(favs)));
  } catch {}
}

export default function WorkersClient({ initialWorkers }: { initialWorkers: WorkerSummary[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [workers, setWorkers] = useState<CloudWorkerSummary[]>(() =>
    initialWorkers.filter((w) => !isSystemWorker(w)) as CloudWorkerSummary[]
  );
  const [archivedWorkers, setArchivedWorkers] = useState<CloudWorkerSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => getFavorites());

  // Shared/Private section collapse state (both expanded by default)
  const [sharedCollapsed, setSharedCollapsed] = useState(false);
  const [privateCollapsed, setPrivateCollapsed] = useState(false);

  // Admin tab state
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminWorkers, setAdminWorkers] = useState<AdminWorkerStub[]>([]);
  const [loadingAdmin, setLoadingAdmin] = useState(false);
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(new Set());

  const initialTab =
    (typeof window !== "undefined" && window.location.hash.replace(/^#/, "")) ||
    searchParams.get("tab");
  const [tab, setTab] = useState<WorkersTab>(isValidTab(initialTab) ? initialTab : "all");
  const folderFilter = searchParams.get("folder");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (initialWorkers.length > 0) {
      setWorkers(initialWorkers.filter((w) => !isSystemWorker(w)) as CloudWorkerSummary[]);
    }
  }, [initialWorkers]);

  useEffect(() => {
    const cameWithoutData = initialWorkers.length === 0;
    if (cameWithoutData) setLoading(true);
    let cancelled = false;
    api.workers
      .list()
      .then((w) => {
        if (!cancelled) setWorkers(w.filter((x) => !isSystemWorker(x)) as CloudWorkerSummary[]);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled && cameWithoutData) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== "archived") return;
    let cancelled = false;
    setLoadingArchived(true);
    api.workers
      .list({ include_archived: true })
      .then((all) => {
        if (!cancelled)
          setArchivedWorkers(all.filter((w) => w.archived && !isSystemWorker(w)) as CloudWorkerSummary[]);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingArchived(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check admin role once on mount
  useEffect(() => {
    let cancelled = false;
    fetch("/app/api/me").then(r => r.json()).then(d => {
      const email = d?.user?.email as string | undefined;
      if (!email || cancelled) return;
      const wsId = getActiveWorkspaceId();
      if (!wsId) return;
      fetch(`${API_PROXY_BASE}/workspaces/${wsId}/members`, { headers: wsHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then((data: { owner?: { email: string }; members?: { email: string; role: string }[] } | null) => {
          if (!data || cancelled) return;
          const isOwner = data.owner?.email === email;
          const isAdminMember = (data.members ?? []).some(m => m.email === email && m.role === "admin");
          if (isOwner || isAdminMember) setIsAdmin(true);
        })
        .catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch admin workers when admin tab is opened
  useEffect(() => {
    if (tab !== "admin" || !isAdmin) return;
    const wsId = getActiveWorkspaceId();
    if (!wsId) return;
    let cancelled = false;
    setLoadingAdmin(true);
    fetch(`${API_PROXY_BASE}/workspaces/${wsId}/workers`, { headers: wsHeaders() })
      .then(r => r.ok ? r.json() : [])
      .then((data: AdminWorkerStub[]) => { if (!cancelled) setAdminWorkers(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingAdmin(false); });
    return () => { cancelled = true; };
  }, [tab, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOwnerExpanded = useCallback((ownerId: string) => {
    setExpandedOwners(prev => {
      const next = new Set(prev);
      if (next.has(ownerId)) next.delete(ownerId); else next.add(ownerId);
      return next;
    });
  }, []);

  // Group admin workers by owner for the admin tab
  const adminWorkersByOwner = useMemo(() => {
    if (tab !== "admin") return [];
    // Admin tab: only private workers from other members
    const privateOnly = adminWorkers.filter(w => w.visibility !== "shared");
    const map = new Map<string, { email: string; workers: AdminWorkerStub[] }>();
    for (const w of privateOnly) {
      if (!map.has(w.owner_id)) map.set(w.owner_id, { email: w.owner_email, workers: [] });
      map.get(w.owner_id)!.workers.push(w);
    }
    return Array.from(map.entries()).map(([ownerId, { email, workers: ows }]) => ({ ownerId, email, workers: ows }));
  }, [adminWorkers, tab]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFavorites(next);
      return next;
    });
  }, []);

  function handleTabChange(value: string) {
    if (!isValidTab(value)) return;
    setTab(value);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    const qs = params.size ? `?${params.toString()}` : "";
    const hash = value === "all" ? "" : `#${value}`;
    router.replace(`/workers${qs}${hash}`, { scroll: false });
  }

  function setFolder(path: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (path) params.set("folder", path);
    else params.delete("folder");
    router.replace(`/workers${params.size ? `?${params.toString()}` : ""}`, {
      scroll: false,
    });
  }

  const subFolders = useMemo(() => {
    const all = flattenFolders(workers);
    if (!folderFilter) {
      const tops = new Set<string>();
      const result: { path: string; label: string; count: number }[] = [];
      for (const f of all) {
        const top = f.path.split("/")[0];
        if (tops.has(top)) continue;
        tops.add(top);
        const count = workers.filter((w) =>
          (w.folder || "").split("/")[0] === top
        ).length;
        result.push({ path: top, label: top, count });
      }
      return result;
    }
    const depth = folderFilter.split("/").length;
    const children = new Map<string, number>();
    for (const w of workers) {
      const parts = (w.folder || "").split("/").filter(Boolean);
      if (parts.length <= depth) continue;
      if (parts.slice(0, depth).join("/") !== folderFilter) continue;
      const child = parts.slice(0, depth + 1).join("/");
      children.set(child, (children.get(child) ?? 0) + 1);
    }
    return Array.from(children.entries()).map(([path, count]) => ({
      path,
      label: path.split("/").slice(-1)[0],
      count,
    }));
  }, [workers, folderFilter]);

  const breadcrumbs = useMemo(() => {
    const parts = (folderFilter || "").split("/").filter(Boolean);
    return parts.map((label, i) => ({
      label,
      path: parts.slice(0, i + 1).join("/"),
    }));
  }, [folderFilter]);

  const searchLower = search.trim().toLowerCase();

  const displayedWorkers = useMemo(() => {
    if (tab === "archived") {
      let pool = archivedWorkers;
      if (searchLower) {
        pool = pool.filter((w) => {
          const blob = [w.name, w.description || "", ...(w.tags || []), w.archive_reason || ""]
            .join(" ")
            .toLowerCase();
          return blob.includes(searchLower);
        });
      }
      return pool;
    }
    let pool = workers;
    if (tab === "starred") {
      pool = pool.filter((w) => favorites.has(w.id));
    } else if (tab === "recent") {
      pool = pool
        .filter((w) => w.recent_stats?.last_run_at)
        .sort((a, b) => {
          const ta = new Date(a.recent_stats!.last_run_at!).getTime();
          const tb = new Date(b.recent_stats!.last_run_at!).getTime();
          return tb - ta;
        })
        .slice(0, 10);
    } else if (folderFilter) {
      pool = pool.filter(
        (w) =>
          w.folder === folderFilter ||
          (w.folder || "").startsWith(`${folderFilter}/`)
      );
    }
    if (searchLower) {
      pool = pool.filter((w) => {
        const blob = [
          w.name,
          w.description || "",
          ...(w.tags || []),
          w.folder || "",
        ]
          .join(" ")
          .toLowerCase();
        return blob.includes(searchLower);
      });
    }
    return pool;
  }, [workers, archivedWorkers, tab, folderFilter, favorites, searchLower]);

  const showFolderNav =
    tab === "all" &&
    !searchLower &&
    (breadcrumbs.length > 0 || subFolders.length > 0);
  const isArchivedTab = tab === "archived";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      const active = document.activeElement;
      const searchEl = document.querySelector<HTMLInputElement>(
        "input[data-workers-search]"
      );
      const searchHasText = search.trim().length > 0;
      const searchFocused = active === searchEl && searchEl !== null;
      if (searchHasText || searchFocused) {
        event.preventDefault();
        setSearch("");
        searchEl?.blur();
        return;
      }
      if (
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }
      if (folderFilter || tab !== "all") {
        event.preventDefault();
        setFolder(null);
        if (tab !== "all") handleTabChange("all");
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, folderFilter, tab]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your AI workers.
          </p>
        </div>
      </div>

      {!loading && workers.length === 0 ? (
        <EmptyWorkersState />
      ) : (
        <div className="space-y-5">
          {/* Hide search + tabs when a filtered tab is empty — nothing to search */}
          {!(["archived", "starred", "recent"].includes(tab) && !loading && !loadingArchived && displayedWorkers.length === 0) && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                data-workers-search
                placeholder="Search workers or tags..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Tabs value={tab} onValueChange={handleTabChange}>
              <TabsList>
                <TabsTrigger value="all" aria-label="All workers" title="All">
                  <LayoutGrid />
                </TabsTrigger>
                <TabsTrigger value="starred" aria-label="Starred workers" title="Starred">
                  <Star />
                </TabsTrigger>
                <TabsTrigger value="recent" aria-label="Recently run workers" title="Recent">
                  <Clock />
                </TabsTrigger>
                <TabsTrigger value="archived" aria-label="Archived workers" title="Archived">
                  <Archive />
                </TabsTrigger>
                {isAdmin && (
                  <TabsTrigger value="admin" aria-label="Admin view — all workspace workers" title="Admin">
                    <Shield />
                  </TabsTrigger>
                )}
              </TabsList>
            </Tabs>
          </div>
          )}

          {showFolderNav && (
            <div className="flex items-center gap-1.5 flex-wrap min-h-7">
              {breadcrumbs.length > 0 ? (
                <span className="flex items-center gap-1 text-sm text-muted-foreground mr-1">
                  <button
                    type="button"
                    onClick={() => setFolder(null)}
                    className="hover:text-foreground transition-colors"
                  >
                    Workers
                  </button>
                  {breadcrumbs.map((bc) => (
                    <span key={bc.path} className="flex items-center gap-1">
                      <ChevronRight className="size-3.5" />
                      <button
                        type="button"
                        onClick={() => setFolder(bc.path)}
                        className="hover:text-foreground transition-colors"
                      >
                        {bc.label}
                      </button>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground mr-1">Folders:</span>
              )}
              {subFolders.map(({ path, label, count }) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => setFolder(path)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-0.5 text-xs font-normal text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition-colors"
                >
                  <Folder className="size-3" />
                  {label}
                  <span className="text-muted-foreground/60">{count}</span>
                </button>
              ))}
            </div>
          )}

          {tab !== "admin" && (() => {
            if (loading || (isArchivedTab && loadingArchived)) {
              return (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {Array.from({ length: 8 }).map((_, i) => <WorkerCardSkeleton key={i} />)}
                </div>
              );
            }
            // Split shared / private only on the "all" tab without folder/search filters
            const splitSections = (tab === "all" || tab === "starred") && !searchLower && !folderFilter;
            if (!splitSections) {
              return (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {displayedWorkers.map((w) => (
                    <WorkerCard key={w.id} worker={w} isFavorite={favorites.has(w.id)} onFavoriteToggle={toggleFavorite} />
                  ))}
                </div>
              );
            }
            const sharedWorkers = displayedWorkers.filter(w => w.visibility === "shared");
            const privateWorkers = displayedWorkers.filter(w => w.visibility !== "shared");
            return (
              <div className="space-y-8">
                {sharedWorkers.length > 0 && (
                  <div className="space-y-3">
                    <button
                      type="button"
                      onClick={() => setSharedCollapsed(c => !c)}
                      className="flex items-center gap-2 group"
                    >
                      <ChevronDown className={`size-3.5 text-muted-foreground transition-transform duration-150 ${sharedCollapsed ? "-rotate-90" : ""}`} />
                      <Globe className="size-3.5 text-muted-foreground" />
                      <h2 className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">Shared</h2>
                      <span className="text-xs text-muted-foreground/60">{sharedWorkers.length}</span>
                    </button>
                    {!sharedCollapsed && (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {sharedWorkers.map((w) => (
                          <WorkerCard key={w.id} worker={w} isFavorite={favorites.has(w.id)} onFavoriteToggle={toggleFavorite} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {privateWorkers.length > 0 && (
                  <div className="space-y-3">
                    <button
                      type="button"
                      onClick={() => setPrivateCollapsed(c => !c)}
                      className="flex items-center gap-2 group"
                    >
                      <ChevronDown className={`size-3.5 text-muted-foreground transition-transform duration-150 ${privateCollapsed ? "-rotate-90" : ""}`} />
                      <Lock className="size-3.5 text-muted-foreground" />
                      <h2 className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">Private</h2>
                      <span className="text-xs text-muted-foreground/60">{privateWorkers.length}</span>
                    </button>
                    {!privateCollapsed && (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {privateWorkers.map((w) => (
                          <WorkerCard key={w.id} worker={w} isFavorite={favorites.has(w.id)} onFavoriteToggle={toggleFavorite} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {!loading && !loadingArchived && tab !== "admin" && displayedWorkers.length === 0 && (() => {
            if (tab === "archived") return (
              <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
                <div className="size-10 rounded-full bg-muted flex items-center justify-center">
                  <Archive className="size-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">No archived workers</p>
                  <p className="text-xs text-muted-foreground mt-1">Workers you archive will appear here.</p>
                </div>
              </div>
            );
            if (tab === "starred") return (
              <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
                <div className="size-10 rounded-full bg-muted flex items-center justify-center">
                  <Star className="size-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">Nothing starred yet</p>
                  <p className="text-xs text-muted-foreground mt-1">Click the star on any worker card to pin it here.</p>
                </div>
              </div>
            );
            if (tab === "recent") return (
              <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
                <div className="size-10 rounded-full bg-muted flex items-center justify-center">
                  <Clock className="size-5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">No workers run yet</p>
                  <p className="text-xs text-muted-foreground mt-1">Recently triggered workers will show up here.</p>
                </div>
              </div>
            );
            return <p className="text-sm text-muted-foreground">{searchLower ? `No workers match "${search}".` : "No workers in this folder."}</p>;
          })()}

          {tab === "admin" && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground mb-4">
                All workspace workers grouped by owner. Expand a member to see their workers.
              </p>
              {loadingAdmin ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-12 rounded-lg border border-border bg-muted/30 animate-pulse" />
                ))
              ) : adminWorkersByOwner.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workers found in this workspace.</p>
              ) : (
                adminWorkersByOwner.map(({ ownerId, email, workers: ownerWorkers }) => {
                  const expanded = expandedOwners.has(ownerId);
                  return (
                    <div key={ownerId} className="rounded-lg border border-border overflow-hidden">
                      <button
                        type="button"
                        onClick={() => toggleOwnerExpanded(ownerId)}
                        className="w-full flex items-center justify-between px-4 py-3 text-sm hover:bg-muted/40 transition-colors text-left"
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <div className="size-6 rounded-full bg-muted text-foreground border border-border grid place-items-center text-[10px] font-medium shrink-0">
                            {email.split("@")[0]?.slice(0, 2).toUpperCase()}
                          </div>
                          <span className="font-medium truncate">{email}</span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {ownerWorkers.length} {ownerWorkers.length === 1 ? "worker" : "workers"}
                          </span>
                        </span>
                        <ChevronDown className={`size-4 text-muted-foreground shrink-0 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`} />
                      </button>
                      {expanded && (
                        <div className="border-t border-border divide-y divide-border/60">
                          {ownerWorkers.map(w => (
                            <Link key={w.id} href={`/workers/${w.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors">
                              <span className="flex-1 text-sm truncate">{w.name}</span>
                              <span className="inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
                                <Lock className="size-2.5" />
                                Private
                              </span>
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface FlatFolder {
  path: string;
  label: string;
  count: number;
}

function flattenFolders(workers: CloudWorkerSummary[]): FlatFolder[] {
  const countByPath = new Map<string, number>();
  for (const worker of workers) {
    if (!worker.folder) continue;
    const parts = worker.folder.split("/").filter(Boolean);
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      countByPath.set(path, (countByPath.get(path) ?? 0) + 1);
    }
  }
  if (countByPath.size === 0) return [];
  const distinctFolders = Array.from(
    new Set(workers.map((w) => w.folder).filter(Boolean) as string[])
  ).sort();
  return distinctFolders.map((path) => ({
    path,
    label: path,
    count: countByPath.get(path) ?? 0,
  }));
}

function EmptyWorkersState() {
  const templates = [
    { id: "research_brief", title: "Research brief", description: "Markdown brief from a topic, audience, and depth.", icon: "📄" },
    { id: "gmail_intake_brief", title: "Gmail triage", description: "Unread Gmail summary with next actions.", icon: "✉️" },
    { id: "csv_enricher", title: "CSV enricher", description: "Spreadsheet enrichment with structured output.", icon: "📊" },
  ];
  const examples = [
    "Summarise my Granola meetings, post action items to HubSpot, daily",
    "Every morning at 9am, send me a digest of my GitHub PRs",
    "When a new HubSpot deal lands, post a summary to Slack #sales",
  ];
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-8 sm:p-12 space-y-8">
        <div className="max-w-xl">
          <div className="inline-flex items-center justify-center size-12 rounded-xl bg-[var(--accent-soft)] mb-4">
            <Box className="size-6 text-[var(--accent)]" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">
            No workers yet. Spin one up.
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            A worker is a small AI agent (or plain script) that runs on a schedule,
            a webhook, or on demand. Describe what you want, or start from one of
            the examples below.
          </p>
        </div>
        <div className="space-y-3">
          <Link href="/workers/new">
            <Button size="default" className="gap-2">
              <Plus className="size-4" />
              Describe a new worker
            </Button>
          </Link>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3">
            Or start from a template
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {templates.map((t) => (
              <Link
                key={t.id}
                href={`/workers/new?template=${t.id}`}
                className="group block rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] hover:bg-[var(--active-nav-bg)] transition-colors p-4"
              >
                <div className="text-2xl mb-2" aria-hidden>{t.icon}</div>
                <p className="text-sm font-medium">{t.title}</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t.description}</p>
              </Link>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3">Example prompts</p>
          <ul className="space-y-1.5">
            {examples.map((ex, i) => (
              <li key={i}>
                <Link
                  href={`/workers/new?prompt=${encodeURIComponent(ex)}`}
                  className="block rounded-[var(--radius-button)] px-3 py-2 text-sm hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  &quot;{ex}&quot;
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

// Mirror the engine's brand-copy transform (WorkersCollection.displayBrandCopy):
// legacy "WorkerOS"/"Workeros" → "Floom" in user-facing description text.
function displayBrandCopy(value?: string | null): string {
  return (value ?? "")
    .replace(new RegExp(`\\bWorker${"OS"}\\b`, "g"), "Floom")
    .replace(new RegExp(`\\bWorker${"os"}\\b`, "g"), "Floom");
}

function WorkerCard({
  worker,
  isFavorite,
  onFavoriteToggle,
}: {
  worker: CloudWorkerSummary;
  isFavorite: boolean;
  onFavoriteToggle: (id: string) => void;
}) {
  const hoverDescription = firstLine(worker.long_description);
  // EXACT engine card (components/collection/CollectionGrid + WorkersCollection card spec):
  // c-gtop holds the name (with private lock); icons live in c-gfoot's c-gtools.
  const description = displayBrandCopy(worker.description);

  return (
    <Link
      href={`/workers/${worker.id}`}
      className="c-gcard group"
      title={hoverDescription || undefined}
    >
      <button
        type="button"
        title={isFavorite ? "Remove from favourites" : "Add to favourites"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onFavoriteToggle(worker.id);
        }}
        className={`star ${isFavorite ? "on" : ""}`}
        aria-pressed={isFavorite}
      >
        <Star size={16} fill={isFavorite ? "currentColor" : "none"} />
      </button>
      <div className="c-gtop">
        <div className="c-gnm">
          {worker.visibility === "private" ? (
            <span className="inline-flex items-baseline gap-1.5">
              {worker.name}
              <Lock className="size-3 text-[var(--muted-foreground)] translate-y-px" />
            </span>
          ) : (
            worker.name
          )}
        </div>
      </div>
      {description != null && <div className="c-gd">{description}</div>}
      <div className="c-gfoot">
        <StatusPill spec={workerStatusPill(worker as unknown as WorkerSummary)} />
        <div className="c-gtools">
          <WorkerIconPills
            worker={{ id: worker.id, name: worker.name, connections: worker.connections }}
            max={3}
          />
        </div>
      </div>
    </Link>
  );
}

function footerStatus(status?: string): { cls: string; label: string } | null {
  switch (status) {
    case "error":
      return { cls: "bg-red-500", label: "Error" };
    case "needs_attention":
      return { cls: "bg-amber-500", label: "Needs attention" };
    case "missing_secret":
      return { cls: "bg-amber-500", label: "Missing secret" };
    default:
      return null;
  }
}

function CardFooterLine({
  stats,
  status,
  visibility,
}: {
  stats?: import("@/lib/types").RecentStats | null;
  status?: string;
  visibility?: string;
}) {
  const attention = footerStatus(status);
  const lastRun = stats?.last_run_at ? formatRelativeTime(stats.last_run_at) : "No runs yet";

  return (
    <>
      <span className="truncate">{lastRun}</span>
      {attention && (
        <span className="flex items-center gap-1.5 shrink-0">
          <span className={`size-1.5 rounded-full ${attention.cls}`} aria-hidden="true" />
          <span>{attention.label}</span>
        </span>
      )}
    </>
  );
}

function firstLine(value?: string): string {
  return (value || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function WorkerCardSkeleton() {
  return (
    <div className="c-gcard pointer-events-none">
      <div className="c-gtop">
        <Skeleton className="h-5 w-20 rounded-[var(--radius-squircle)]" />
      </div>
      <Skeleton className="mt-2 h-4 w-3/4" />
      <Skeleton className="mt-2 h-3 w-full" />
      <Skeleton className="h-3 w-2/3 mt-1" />
      <div className="c-gfoot">
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}
