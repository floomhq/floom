"use client";

import { useQuery, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Search, Box, ArrowRight } from "lucide-react";

export default function GalleryPage() {
  const [query, setQuery] = useState("");
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();

  const automations = useQuery(
    api.automations.list,
    isAuthenticated ? {} : "skip"
  );

  const filtered = automations?.filter((a) => {
    if (query) {
      const q = query.toLowerCase();
      return a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Nav />

      <div className="max-w-6xl mx-auto w-full px-4 py-6 flex-1">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-lg font-semibold text-gray-900">
            Workspace Automations
          </h1>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search automations..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 w-64"
            />
          </div>
        </div>

        {/* Loading */}
        {automations === undefined && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="border border-gray-200 rounded-card p-4 animate-pulse h-36"
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
                  ✕ Clear search
                </button>
              </>
            ) : (
              <>
                <p className="text-gray-500 text-sm">
                  No automations shared with your workspace yet.
                </p>
                <p className="text-gray-400 text-xs mt-1 max-w-xs">
                  When the automation person deploys one and makes it public,
                  it&apos;ll appear here.
                </p>
                <a
                  href="https://github.com/floom"
                  className="mt-3 text-sm text-blue-600 hover:underline"
                >
                  → Learn how to deploy one
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
                onClick={() => router.push(`/a/${automation._id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type Automation = {
  _id: string;
  name: string;
  description: string;
  currentVersion: number;
  createdAt: number;
};

function AutomationCard({
  automation,
  onClick,
}: {
  automation: Automation;
  onClick: () => void;
}) {
  return (
    <div className="border border-gray-200 rounded-card p-4 flex flex-col hover:border-gray-300 hover:shadow-sm transition-all">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400">
          v{automation.currentVersion}
        </span>
      </div>

      <h3 className="font-semibold text-gray-900 text-sm mb-1 leading-tight">
        {automation.name}
      </h3>

      <p className="text-xs text-gray-500 flex-1 line-clamp-2 leading-relaxed">
        {automation.description}
      </p>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
        <span className="text-xs text-gray-400">
          {formatRelativeTime(automation.createdAt)}
        </span>
        <button
          onClick={onClick}
          className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
        >
          Open
          <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
