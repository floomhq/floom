"use client";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { TemplateCard } from "./TemplateCard";
import { CATEGORIES, TEMPLATES, type Category } from "./data";

const ACCENT = "#3a6ea5";

function CategoryPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center rounded-full border px-3 text-[12.5px] font-medium transition"
      style={
        active
          ? {
              background: ACCENT,
              borderColor: ACCENT,
              color: "var(--paper)",
            }
          : {
              background: "var(--bg-card)",
              borderColor: "var(--border-default)",
              color: "var(--ink-soft)",
            }
      }
    >
      {children}
    </button>
  );
}

export function TemplatesBrowser() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "All">("All");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TEMPLATES.filter((t) => {
      if (category !== "All" && t.category !== category) return false;
      if (q && !(`${t.name} ${t.job}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [query, category]);

  const hasFilters = category !== "All" || query;

  return (
    <div>
      {/* Search + category pills inline */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workers..."
            className="h-11 w-full rounded-[12px] border border-border bg-card pl-9 pr-3 text-[14px] text-foreground shadow-sm outline-none placeholder:text-muted-foreground transition focus:border-[#3a6ea5]/60 focus:shadow-[0_0_0_4px_rgba(58,110,165,0.10)]"
          />
        </div>
        <div className="text-[12.5px] text-muted-foreground">
          {results.length} {results.length === 1 ? "worker" : "workers"}
        </div>
      </div>

      {/* Single row of category chips */}
      <div className="mt-5 flex flex-wrap gap-1.5">
        <CategoryPill active={category === "All"} onClick={() => setCategory("All")}>
          All
        </CategoryPill>
        {CATEGORIES.map((c) => (
          <CategoryPill key={c} active={category === c} onClick={() => setCategory(c)}>
            {c}
          </CategoryPill>
        ))}
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCategory("All");
            }}
            className="ml-auto inline-flex h-8 items-center text-[12px] font-medium text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      {/* Grid */}
      {results.length > 0 ? (
        <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {results.map((t) => (
            <TemplateCard key={t.slug} t={t} />
          ))}
        </div>
      ) : (
        <div className="mt-8 rounded-[18px] border border-border bg-card p-10 text-center">
          <p className="text-[14px] font-medium text-foreground">No workers match those filters.</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Try removing a filter, or describe a custom worker below.
          </p>
        </div>
      )}
    </div>
  );
}
