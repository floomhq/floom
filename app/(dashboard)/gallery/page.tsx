"use client";

import { useQuery, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import {
  Search,
  Box,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  Command as CommandIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";

export default function GalleryPage() {
  const [query, setQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();

  const automations = useQuery(
    api.automations.list,
    isAuthenticated ? {} : "skip"
  );

  const filtered = automations?.filter((a: Automation) => {
    if (query) {
      const q = query.toLowerCase();
      return (
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Command+K listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Nav />

      <div className="max-w-6xl mx-auto w-full px-4 py-6 flex-1">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-lg font-semibold text-gray-900">
            Workspace Automations
          </h1>
          <Button
            variant="outline"
            onClick={() => setPaletteOpen(true)}
            className="w-64 justify-start gap-2 text-muted-foreground font-normal"
          >
            <Search size={14} />
            <span className="flex-1 text-left">Search automations...</span>
            <kbd className="flex items-center gap-0.5 px-1.5 py-0.5 bg-muted rounded text-[11px] font-medium text-muted-foreground border border-border">
              <CommandIcon size={11} />K
            </kbd>
          </Button>
        </div>

        {/* Loading */}
        {automations === undefined && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        )}

        {/* Empty state */}
        {filtered !== undefined && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Box size={40} className="text-gray-200 mb-4" />
            {query ? (
              <>
                <p className="text-muted-foreground text-sm">
                  No automations match &ldquo;{query}&rdquo;.
                </p>
                <Button
                  variant="link"
                  onClick={() => setQuery("")}
                  className="mt-2"
                >
                  Clear search
                </Button>
              </>
            ) : (
              <>
                <p className="text-foreground font-medium text-sm">
                  No automations in your workspace yet
                </p>
                <p className="text-muted-foreground text-xs mt-1 max-w-xs">
                  Deploy your first automation with the Floom CLI, then make it
                  public to share with your team.
                </p>
                <a
                  href="https://github.com/floom"
                  className={cn(buttonVariants({ variant: "link" }), "mt-3")}
                >
                  Learn how to deploy
                </a>
              </>
            )}
          </div>
        )}

        {/* Cards grid */}
        {filtered !== undefined && filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((automation: Automation) => (
              <AutomationCard
                key={automation._id}
                automation={automation}
                href={`/a/${automation._id}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Command Palette */}
      <CommandDialog
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        title="Search Automations"
        description="Search for an automation to open"
        className="sm:max-w-lg"
      >
        <Command>
          <CommandInput placeholder="Search automations..." />
          <CommandList className="max-h-80">
            <CommandEmpty>
              <p className="text-muted-foreground">
                {automations?.length === 0
                  ? "No automations in this workspace yet."
                  : "No matching automations."}
              </p>
            </CommandEmpty>
            <CommandGroup>
              {(automations ?? []).map((a: Automation) => {
                const status = statusConfig[a.status];
                return (
                  <CommandItem
                    key={a._id}
                    value={`${a.name}__${a._id}`}
                    keywords={[a.description]}
                    onSelect={() => {
                      setPaletteOpen(false);
                      router.push(`/a/${a._id}`);
                    }}
                    className="py-2.5"
                  >
                    <span
                      className={cn(
                        "size-2 rounded-full shrink-0",
                        status.color
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{a.name}</p>
                      <p className="text-xs text-muted-foreground line-clamp-1">
                        {a.description}
                      </p>
                    </div>
                    {a.schedule && a.scheduleEnabled !== false && (
                      <span className="text-[11px] text-muted-foreground/60 shrink-0 flex items-center gap-1">
                        <Clock size={10} />
                        {formatSchedule(a.schedule)}
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
          <CommandSeparator />
          <div className="flex items-center gap-4 px-3 py-2 text-[11px] text-muted-foreground/60">
            <span>
              <kbd className="px-1 py-0.5 bg-muted rounded border text-[10px] mr-1">↑↓</kbd>
              navigate
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-muted rounded border text-[10px] mr-1">↵</kbd>
              open
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-muted rounded border text-[10px] mr-1">esc</kbd>
              close
            </span>
          </div>
        </Command>
      </CommandDialog>
    </div>
  );
}

// --- Types ---

type Automation = {
  _id: string;
  name: string;
  description: string;
  currentVersion: number;
  createdAt: number;
  status: "active" | "deploying" | "failed";
  schedule: string | null;
  scheduleEnabled?: boolean;
  lastRunStatus: string | null;
  lastRunAt: number | null;
};

// --- Status helpers ---

const statusConfig = {
  active: { color: "bg-green-500", label: "Active" },
  deploying: { color: "bg-yellow-500", label: "Deploying" },
  failed: { color: "bg-red-500", label: "Failed" },
} as const;

const statusBadgeVariant = {
  active: "secondary" as const,
  deploying: "outline" as const,
  failed: "destructive" as const,
};

const runStatusIcon: Record<
  string,
  { icon: typeof CheckCircle2; className: string }
> = {
  success: { icon: CheckCircle2, className: "text-green-500" },
  error: { icon: XCircle, className: "text-red-500" },
  timeout: { icon: XCircle, className: "text-red-500" },
  running: { icon: Loader2, className: "text-blue-500 animate-spin" },
  pending: { icon: Loader2, className: "text-gray-400" },
};

function formatSchedule(schedule: string | null): string | null {
  if (!schedule) return null;
  if (schedule === "* * * * *") return "Every minute";
  if (schedule === "0 * * * *") return "Every hour";
  if (schedule === "0 0 * * *") return "Daily";
  if (schedule === "0 9 * * *") return "Daily at 9am";
  if (schedule === "0 9 * * 1-5") return "Weekdays at 9am";
  if (schedule === "0 0 * * 0") return "Weekly";
  if (schedule === "0 0 1 * *") return "Monthly";
  return schedule;
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// --- AutomationCard ---

function AutomationCard({
  automation,
  href,
}: {
  automation: Automation;
  href: string;
}) {
  const router = useRouter();
  const status = statusConfig[automation.status];
  const scheduleLabel = formatSchedule(automation.schedule);
  const runIcon = automation.lastRunStatus
    ? runStatusIcon[automation.lastRunStatus]
    : null;

  return (
    <Card
      size="sm"
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(href);
        }
      }}
      className="cursor-pointer hover:ring-foreground/20 hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Top row: status + version + schedule */}
      <CardHeader className="flex-row items-center gap-2">
        <Badge
          variant={statusBadgeVariant[automation.status]}
          className="gap-1.5"
        >
          <span
            className={cn("size-2 rounded-full", status.color)}
            aria-label={`Status: ${status.label}`}
          />
          {status.label}
        </Badge>
        <Badge variant="outline" className="text-muted-foreground">
          v{automation.currentVersion}
        </Badge>
        {scheduleLabel && automation.scheduleEnabled !== false && (
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <Clock size={11} />
            {scheduleLabel}
          </span>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-1 flex-1">
        {/* Name */}
        <h3 className="font-semibold text-foreground text-sm leading-tight">
          {automation.name}
        </h3>

        {/* Description */}
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
          {automation.description}
        </p>

        {/* Last run */}
        {automation.lastRunAt && runIcon && (
          <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
            <runIcon.icon size={12} className={runIcon.className} />
            <span>Last run {formatRelativeTime(automation.lastRunAt)}</span>
          </div>
        )}
      </CardContent>

      {/* Footer */}
      <CardFooter className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(automation.createdAt)}
        </span>
        <span className="flex items-center gap-1 text-xs font-medium text-primary">
          Open
          <ArrowRight size={12} />
        </span>
      </CardFooter>
    </Card>
  );
}
