"use client";

/**
 * CreateSourcePills — source/context pills for the worker-create composer.
 *
 * The marketing landing hero shows a rich row of context pills (Company brain ·
 * ICP brief · Pricing · Tone guide · Style guide) under its prompt box, but the
 * in-app `?mode=create` composer had none — the product surface was poorer than
 * the marketing one. This component closes that gap.
 *
 * Pills are two-tier:
 *   1. Your real Brain folders (fetched live) — clicking attaches that folder as
 *      a source the new worker should read.
 *   2. Suggested starter sources (the landing's canonical set) — clicking primes
 *      the composer to mention that source so the assistant wires/creates it.
 *
 * Selecting a pill calls `onPick(label)` which the composer uses to append a
 * short, natural source hint to the prompt — no new submit path, no change to
 * Emily's chat behavior.
 */

import { useEffect, useState } from "react";
import { Brain, FileText, Plus } from "lucide-react";
import { api } from "@/lib/api";

// Canonical starter sources mirrored from the landing hero. Kept here (not
// fetched) because they describe intent, not necessarily existing folders.
const SUGGESTED_SOURCES = [
  "Company brain",
  "ICP brief",
  "Pricing",
  "Tone guide",
  "Style guide",
] as const;

export function CreateSourcePills({ onPick }: { onPick: (source: string) => void }) {
  const [folders, setFolders] = useState<{ name: string }[]>([]);

  useEffect(() => {
    let alive = true;
    api.contexts
      .list()
      .then((rows) => {
        if (alive) setFolders(rows.map((r) => ({ name: r.name })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const folderNames = new Set(folders.map((f) => f.name.toLowerCase()));
  // Suggested sources that aren't already a real folder (avoid duplicates).
  const suggestions = SUGGESTED_SOURCES.filter((s) => !folderNames.has(s.toLowerCase()));

  if (folders.length === 0 && suggestions.length === 0) return null;

  return (
    <div className="w-full max-w-xl">
      <p className="mb-2 text-center text-[11px] uppercase tracking-wide text-muted-foreground">
        Add sources
      </p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {folders.map((f) => (
          <button
            key={`folder:${f.name}`}
            type="button"
            onClick={() => onPick(f.name)}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-[var(--bg-2)] py-1 pl-2 pr-2.5 text-xs text-foreground transition-colors hover:bg-muted"
            title={`Use the ${f.name} brain folder`}
          >
            <Brain className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="leading-none">{f.name}</span>
          </button>
        ))}
        {suggestions.map((s) => (
          <button
            key={`suggest:${s}`}
            type="button"
            onClick={() => onPick(s)}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] [border:var(--bd-card)] bg-muted/40 py-1 pl-2 pr-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={`Add ${s} as a source`}
          >
            <FileText className="size-3.5 shrink-0" />
            <span className="leading-none">{s}</span>
            <Plus className="size-3 shrink-0 opacity-60" />
          </button>
        ))}
      </div>
    </div>
  );
}
