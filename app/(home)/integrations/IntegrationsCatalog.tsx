"use client";

import { useState, useMemo, useCallback } from "react";

type CatalogEntry = {
  slug: string;
  name: string;
  logo: string;
};

// How many cards to show initially before revealing more on scroll/search.
// Search always searches the full catalog; only the *display* is capped.
const INITIAL_VISIBLE = 120;

function IntegrationCard({ entry }: { entry: CatalogEntry }) {
  const [imgError, setImgError] = useState(false);

  const handleError = useCallback(() => {
    setImgError(true);
  }, []);

  return (
    <article className="flex flex-col items-center gap-2 rounded-[8px] bg-card p-4 transition-colors hover:bg-secondary/60">
      <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-background">
        {imgError || !entry.logo ? (
          <span
            className="flex h-6 w-6 items-center justify-center rounded-[4px] bg-secondary text-[10px] font-semibold text-muted-foreground"
            aria-hidden="true"
          >
            {entry.name.charAt(0).toUpperCase()}
          </span>
        ) : (
          <img
            src={entry.logo}
            alt=""
            aria-hidden="true"
            width={24}
            height={24}
            loading="lazy"
            decoding="async"
            onError={handleError}
            className="h-6 w-6 object-contain"
          />
        )}
      </div>
      <p className="w-full truncate text-center text-[12px] font-medium leading-snug tracking-[-0.01em]">
        {entry.name}
      </p>
    </article>
  );
}

export function IntegrationsCatalog({ catalog }: { catalog: CatalogEntry[] }) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q),
    );
  }, [catalog, query]);

  const isSearching = query.trim().length > 0;
  // When searching, show all matches. When browsing, show initial batch.
  const visible =
    isSearching || showAll ? filtered : filtered.slice(0, INITIAL_VISIBLE);
  const hasMore = !isSearching && !showAll && filtered.length > INITIAL_VISIBLE;

  return (
    <div>
      {/* Search + count bar */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-muted-foreground">
          {isSearching ? (
            <>
              <span className="font-semibold text-foreground">{filtered.length}</span>{" "}
              {filtered.length === 1 ? "result" : "results"}
            </>
          ) : (
            <>
              <span className="font-semibold text-foreground">
                {catalog.length.toLocaleString()}+
              </span>{" "}
              integrations
            </>
          )}
        </p>
        <div className="relative w-full sm:w-72">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <path d="M10.5 10.5l3 3" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search integrations…"
            className="h-9 w-full rounded-[8px] border border-border bg-background pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[var(--v3-accent)]"
          />
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <p className="py-12 text-center text-[14px] text-muted-foreground">
          No integrations found for &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
            {visible.map((entry) => (
              <IntegrationCard key={entry.slug} entry={entry} />
            ))}
          </div>

          {hasMore && (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="inline-flex h-10 items-center rounded-[8px] border border-border bg-background px-5 text-[13px] font-medium text-foreground transition hover:bg-secondary/60"
              >
                Show all {catalog.length.toLocaleString()} integrations
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
