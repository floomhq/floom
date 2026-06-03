"use client";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { TemplateCard } from "./TemplateCard";
import {
  CATEGORIES,
  FILTER_TOOLS,
  FILTER_TRIGGERS,
  TEMPLATES,
  type Approval,
  type Category,
} from "./data";

const APPROVALS: Approval[] = ["Required", "Optional", "Auto-run"];

function Pill({
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
      className={`inline-flex h-8 items-center rounded-full border px-3 text-[12.5px] font-medium transition ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-card text-foreground/80 hover:bg-accent"
      }`}
    >
      {children}
    </button>
  );
}

function FilterGroup({
  label,
  options,
  selected,
  toggle,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  toggle: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <Pill key={o} active={selected.has(o)} onClick={() => toggle(o)}>
            {o}
          </Pill>
        ))}
      </div>
    </div>
  );
}

export function TemplatesBrowser() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "All">("All");
  const [tools, setTools] = useState<Set<string>>(new Set());
  const [triggers, setTriggers] = useState<Set<string>>(new Set());
  const [approvals, setApprovals] = useState<Set<string>>(new Set());

  function toggleIn(setter: React.Dispatch<React.SetStateAction<Set<string>>>) {
    return (v: string) =>
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(v)) next.delete(v);
        else next.add(v);
        return next;
      });
  }

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TEMPLATES.filter((t) => {
      if (category !== "All" && t.category !== category) return false;
      if (q && !(`${t.name} ${t.job}`.toLowerCase().includes(q))) return false;
      if (tools.size && !t.tools.some((x) => tools.has(x))) return false;
      if (triggers.size && !t.triggers.some((x) => triggers.has(x))) return false;
      if (approvals.size && !approvals.has(t.approval)) return false;
      return true;
    });
  }, [query, category, tools, triggers, approvals]);

  const hasFilters = tools.size || triggers.size || approvals.size || category !== "All" || query;

  return (
    <div>
      {/* Search */}
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workers..."
          className="h-11 w-full rounded-[12px] border border-border bg-card pl-9 pr-3 text-[14px] text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus:border-foreground/30"
        />
      </div>

      {/* Category pills */}
      <div className="mt-5 flex flex-wrap gap-1.5">
        <Pill active={category === "All"} onClick={() => setCategory("All")}>
          All
        </Pill>
        {CATEGORIES.map((c) => (
          <Pill key={c} active={category === c} onClick={() => setCategory(c)}>
            {c}
          </Pill>
        ))}
      </div>

      {/* Filter groups */}
      <div className="mt-6 grid gap-5 rounded-[18px] border border-border bg-secondary/40 p-5 md:grid-cols-3">
        <FilterGroup label="Tools" options={FILTER_TOOLS} selected={tools} toggle={toggleIn(setTools)} />
        <FilterGroup label="Trigger" options={FILTER_TRIGGERS} selected={triggers} toggle={toggleIn(setTriggers)} />
        <FilterGroup label="Approval" options={APPROVALS} selected={approvals} toggle={toggleIn(setApprovals)} />
      </div>

      {/* Result count */}
      <div className="mt-8 flex items-center justify-between">
        <div className="text-[12.5px] text-muted-foreground">
          {results.length} {results.length === 1 ? "worker" : "workers"}
        </div>
        {hasFilters && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setCategory("All");
              setTools(new Set());
              setTriggers(new Set());
              setApprovals(new Set());
            }}
            className="text-[12.5px] font-medium text-foreground/70 hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Grid */}
      {results.length > 0 ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {results.map((t) => (
            <TemplateCard key={t.slug} t={t} />
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-[18px] border border-border bg-card p-10 text-center">
          <p className="text-[14px] font-medium text-foreground">No workers match those filters.</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Try removing a filter, or ask Floom for a custom worker.
          </p>
        </div>
      )}
    </div>
  );
}
