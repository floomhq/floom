"use client";

import { useQuery, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect, useRef, useCallback } from "react";
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
  Command,
} from "lucide-react";
import { clsx } from "clsx";

export default function GalleryPage() {
  const [query, setQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();

  const automations = useQuery(
    api.automations.list,
    isAuthenticated ? {} : "skip"
  );

  const filtered = automations?.filter((a) => {
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
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-2 pl-3 pr-2 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-400 hover:text-gray-600 hover:border-gray-300 transition-colors w-64"
          >
            <Search size={14} />
            <span className="flex-1 text-left">Search automations...</span>
            <kbd className="flex items-center gap-0.5 px-1.5 py-0.5 bg-gray-100 rounded text-[11px] font-medium text-gray-500 border border-gray-200">
              <Command size={11} />K
            </kbd>
          </button>
        </div>

        {/* Loading */}
        {automations === undefined && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="border border-gray-200 rounded-lg p-4 animate-pulse h-40"
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {filtered !== undefined && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Box size={40} className="text-gray-200 mb-4" />
            {query ? (
              <>
                <p className="text-gray-500 text-sm">
                  No automations match &ldquo;{query}&rdquo;.
                </p>
                <button
                  onClick={() => setQuery("")}
                  className="mt-2 text-sm text-blue-600 hover:underline"
                >
                  Clear search
                </button>
              </>
            ) : (
              <>
                <p className="text-gray-900 font-medium text-sm">
                  No automations in your workspace yet
                </p>
                <p className="text-gray-400 text-xs mt-1 max-w-xs">
                  Deploy your first automation with the Floom CLI, then make it
                  public to share with your team.
                </p>
                <a
                  href="https://github.com/floom"
                  className="mt-3 text-sm text-blue-600 hover:underline"
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
            {filtered.map((automation) => (
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
      {paletteOpen && (
        <CommandPalette
          automations={automations ?? []}
          onClose={() => setPaletteOpen(false)}
          onSelect={(id) => {
            setPaletteOpen(false);
            router.push(`/a/${id}`);
          }}
        />
      )}
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

const runStatusIcon: Record<string, { icon: typeof CheckCircle2; className: string }> = {
  success: { icon: CheckCircle2, className: "text-green-500" },
  error: { icon: XCircle, className: "text-red-500" },
  timeout: { icon: XCircle, className: "text-red-500" },
  running: { icon: Loader2, className: "text-blue-500 animate-spin" },
  pending: { icon: Loader2, className: "text-gray-400" },
};

function formatSchedule(schedule: string | null): string | null {
  if (!schedule) return null;
  // Common cron patterns to human-readable
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
    <div
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(href);
        }
      }}
      className="border border-gray-200 rounded-lg p-4 flex flex-col cursor-pointer hover:border-gray-300 hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      {/* Top row: status + version + schedule */}
      <div className="flex items-center gap-2 mb-2">
        <span className="flex items-center gap-1.5">
          <span
            className={clsx("w-2 h-2 rounded-full", status.color)}
            aria-label={`Status: ${status.label}`}
          />
          <span className="text-xs text-gray-500">{status.label}</span>
        </span>
        <span className="text-xs text-gray-300">v{automation.currentVersion}</span>
        {scheduleLabel && automation.scheduleEnabled !== false && (
          <span className="ml-auto flex items-center gap-1 text-xs text-gray-400">
            <Clock size={11} />
            {scheduleLabel}
          </span>
        )}
      </div>

      {/* Name */}
      <h3 className="font-semibold text-gray-900 text-sm mb-1 leading-tight">
        {automation.name}
      </h3>

      {/* Description */}
      <p className="text-xs text-gray-500 flex-1 line-clamp-2 leading-relaxed">
        {automation.description}
      </p>

      {/* Last run */}
      {automation.lastRunAt && runIcon && (
        <div className="flex items-center gap-1.5 mt-2 text-xs text-gray-400">
          <runIcon.icon size={12} className={runIcon.className} />
          <span>
            Last run {formatRelativeTime(automation.lastRunAt)}
          </span>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
        <span className="text-xs text-gray-400">
          {formatRelativeTime(automation.createdAt)}
        </span>
        <span className="flex items-center gap-1 text-xs font-medium text-blue-600">
          Open
          <ArrowRight size={12} />
        </span>
      </div>
    </div>
  );
}

// --- Command Palette ---

function CommandPalette({
  automations,
  onClose,
  onSelect,
}: {
  automations: Automation[];
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = automations.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q)
    );
  });

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.children[selectedIndex] as HTMLElement;
      selected?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[selectedIndex]) {
          onSelect(results[selectedIndex]._id);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [results, selectedIndex, onSelect, onClose]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search automations"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Modal */}
      <div
        className="relative bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden border border-gray-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <Search size={16} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search automations..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
            aria-label="Search automations"
          />
          <kbd className="px-1.5 py-0.5 bg-gray-100 rounded text-[11px] font-medium text-gray-400 border border-gray-200">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto">
          {results.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-gray-500">
                {automations.length === 0
                  ? "No automations in this workspace yet."
                  : "No matching automations. Try a different search term."}
              </p>
            </div>
          )}
          {results.map((a, i) => {
            const status = statusConfig[a.status];
            return (
              <button
                key={a._id}
                onClick={() => onSelect(a._id)}
                className={clsx(
                  "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                  i === selectedIndex
                    ? "bg-blue-50"
                    : "hover:bg-gray-50"
                )}
              >
                <span
                  className={clsx("w-2 h-2 rounded-full shrink-0", status.color)}
                  aria-label={`Status: ${status.label}`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {a.name}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {a.description}
                  </p>
                </div>
                {a.schedule && a.scheduleEnabled !== false && (
                  <span className="text-xs text-gray-400 shrink-0 flex items-center gap-1">
                    <Clock size={11} />
                    {formatSchedule(a.schedule)}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer hint */}
        {results.length > 0 && (
          <div className="px-4 py-2 border-t border-gray-100 flex items-center gap-4 text-[11px] text-gray-400">
            <span>
              <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 mr-1">↑↓</kbd>
              navigate
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 mr-1">↵</kbd>
              open
            </span>
            <span>
              <kbd className="px-1 py-0.5 bg-gray-100 rounded border border-gray-200 mr-1">esc</kbd>
              close
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
