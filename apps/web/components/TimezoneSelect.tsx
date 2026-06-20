"use client";

// ---------------------------------------------------------------------------
// TimezoneSelect — searchable IANA timezone combobox.
//
// the operator (2026-06-20): the schedule trigger's Timezone was a free-text
// field ("type Europe/Berlin and hope"). This replaces it with a validated,
// searchable dropdown over the runtime's IANA timezone list. It mirrors the
// proven in-repo combobox pattern (WorkerToolsEditor "Add tool"): a trigger
// button toggling an absolutely-positioned panel with a search input and a
// filtered role="option" list. The committed value is always a real IANA zone.
// ---------------------------------------------------------------------------

import { useId, useMemo, useRef, useState, useEffect } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { listTimezones } from "@/lib/timezones";

interface TimezoneSelectProps {
  value: string;
  onChange: (tz: string) => void;
}

export function TimezoneSelect({ value, onChange }: TimezoneSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const zones = useMemo(() => listTimezones(), []);
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return zones;
    return zones.filter((z) => z.toLowerCase().includes(q));
  }, [zones, query]);

  // Close on outside click / Escape, matching native select behaviour.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center justify-between rounded-[var(--radius-ui)] bg-card px-3 text-xs text-foreground transition-colors hover:bg-muted/50 [border:var(--bd-card)]" // ds-allow-border
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value || "Select timezone"}
        </span>
        <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Timezones"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-hidden rounded-[var(--radius-ui)] bg-card p-1 shadow-[var(--shadow-pop)] [border:var(--bd-card)]" // ds-allow-border
        >
          <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              aria-label="Search timezones"
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              placeholder="Search timezone..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="max-h-56 overflow-auto pt-1">
            {candidates.length === 0 ? (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">No timezone found.</p>
            ) : (
              candidates.map((tz) => {
                const selected = tz === value;
                return (
                  <button
                    key={tz}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      onChange(tz);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[var(--radius-ui)] px-2.5 py-1.5 text-left text-xs transition-colors",
                      selected
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Check className={cn("h-3.5 w-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{tz}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
