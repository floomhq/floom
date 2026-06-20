"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  Box,
  Brain,
  CheckCircle,
  Clock,
  KeyRound,
  Plug,
  Settings,
  Plus,
  RefreshCcw,
  Trash2,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { api } from "@/lib/api";
import { rankWorkersForCommandPalette } from "@/lib/command-palette";
import { useWorkers } from "@/lib/query/hooks";
import type { WorkerSummary } from "@/lib/types";

const NAV = [
  { href: "/overview", label: "Overview", icon: Activity, keywords: "home dashboard" },
  { href: "/workers", label: "Workers", icon: Box, keywords: "list jobs" },
  { href: "/runs", label: "Runs", icon: Clock, keywords: "history executions" },
  { href: "/library", label: "Brain", icon: Brain, keywords: "library context folders files knowledge resources" },
  { href: "/approvals", label: "Approvals", icon: CheckCircle, keywords: "review pending actions" },
  { href: "/connections/secrets", label: "Secrets", icon: KeyRound, keywords: "env tokens" },
  { href: "/connections", label: "Connections", icon: Plug, keywords: "integrations connections oauth apps" },
  { href: "/settings", label: "Settings", icon: Settings, keywords: "config danger appearance" },
];

const commandContext: { open: (() => void) | null } = { open: null };

export function openCommandPalette() {
  commandContext.open?.();
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Source workers from the shared cache (TanStack Query) instead of an
  // independent fetch — so the palette has the worker list instantly and a slow
  // or failed backend call never leaves it empty (which made search return
  // "No results" even for an exact worker name).
  const workersQuery = useWorkers();
  const workers: WorkerSummary[] = useMemo(() => workersQuery.data ?? [], [workersQuery.data]);
  const visibleWorkers = useMemo(
    () => rankWorkersForCommandPalette(workers, query),
    [workers, query],
  );
  const router = useRouter();

  useEffect(() => {
    commandContext.open = () => setOpen(true);
    return () => {
      commandContext.open = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const runReload = useCallback(async () => {
    setOpen(false);
    try {
      await api.workers.reload();
      await workersQuery.refetch();
    } catch {
      // ignore
    }
  }, [workersQuery]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search or run a command..."
        autoFocus
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Navigation">
          {NAV.map((item) => (
            <CommandItem
              key={item.href}
              value={`nav ${item.label} ${item.keywords}`}
              onSelect={() => go(item.href)}
            >
              <item.icon />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>

        {visibleWorkers.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Workers">
              {visibleWorkers.map((worker) => (
                <CommandItem
                  key={worker.id}
                  value={`worker ${worker.name} ${worker.id} ${worker.description ?? ""}`}
                  onSelect={() => go(`/workers?sel=${encodeURIComponent(worker.id)}`)}
                >
                  <Box />
                  <span className="truncate">{worker.name}</span>
                  {worker.last_run && (
                    <CommandShortcut>{shortStatus(worker.last_run.status)}</CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            value="action new worker create add"
            onSelect={() => go("/?create=1")}
          >
            <Plus />
            New worker
          </CommandItem>
          <CommandItem
            value="action reload workers rescan refresh"
            onSelect={runReload}
          >
            <RefreshCcw />
            Reload workers
          </CommandItem>
          {/* FL10: clearing all runs is destructive, so it must not read as a
              one-click action sitting next to the search bar. It stays
              discoverable via search but is de-emphasized (muted destructive
              text) and routes to the Danger zone, which gates the actual delete
              behind a type-to-confirm step. */}
          <CommandItem
            value="action clear runs danger zone delete"
            onSelect={() => go("/settings?tab=danger")}
            className="text-muted-foreground data-[selected=true]:text-destructive [&_svg]:text-muted-foreground data-[selected=true]:[&_svg]:text-destructive"
          >
            <Trash2 />
            Clear run history…
            <CommandShortcut>Danger zone</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function shortStatus(status: string): string {
  const map: Record<string, string> = {
    completed: "ok",
    failed: "fail",
    running: "run",
    queued: "queued",
  };
  return map[status] ?? status;
}
