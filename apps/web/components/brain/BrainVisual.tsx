"use client";

/**
 * BrainVisual — ported from the workeros-cloud landing reference visual.
 * Shows a central "Company Brain" node with radiating folder cards and a
 * "used by workers" side. Adapted for the engine: no framer-motion (not
 * available), uses real ContextSummary data, shows real file-type chips.
 * (#1094)
 */

import {
  Brain,
  Check,
} from "lucide-react";
import type { ContextSummary } from "@/lib/types";
import {
  BRAIN_FILE_META,
  inferBrainFileType,
} from "@/lib/brain/file-type-icon";

const KNOWS = [
  "Knows what good looks like",
  "Knows your tone",
  "Knows what needs approval",
  "Knows where to pull data",
];

function FolderChip({ folder, index }: { folder: ContextSummary; index: number }) {
  const type = inferBrainFileType(folder.name, folder.category);
  const meta = BRAIN_FILE_META[type];
  const Icon = meta.Icon;
  return (
    <div
      className="inline-flex h-7 items-center gap-1.5 rounded-[9px] border px-1.5 pr-2 text-[12px] transition-colors hover:border-foreground/20"
      style={{
        borderColor: "var(--border)",
        background: "var(--card)",
        color: "var(--foreground)",
        opacity: 0.85,
        animationDelay: `${index * 0.18}s`,
      }}
    >
      <span
        aria-hidden="true"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]"
        style={{
          background: `color-mix(in srgb, ${meta.tint} 12%, transparent)`,
          color: meta.tint,
        }}
      >
        <Icon className="h-3 w-3" strokeWidth={2} />
      </span>
      <span className="max-w-[100px] truncate font-medium">{folder.name}</span>
      <span
        aria-hidden="true"
        className="ml-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-wider"
        style={{ color: meta.tint }}
      >
        {meta.ext}
      </span>
    </div>
  );
}

/** Soft connecting line between the panels. */
function Connector() {
  return (
    <span
      aria-hidden="true"
      className="mx-auto my-1 h-6 w-px shrink-0 lg:my-0 lg:h-px lg:w-10"
      style={{
        background: "linear-gradient(to bottom, transparent, var(--border), transparent)",
      }}
    />
  );
}

interface BrainVisualProps {
  folders: ContextSummary[];
}

export function BrainVisual({ folders }: BrainVisualProps) {
  // Show up to 9 folders in the left panel; show workers from used_by data
  const displayFolders = folders.slice(0, 9);
  const totalFiles = folders.reduce((n, f) => n + (f.file_count ?? 0), 0);

  // Collect unique worker names from all folders (worker_count is a count, not names)
  // Use folder names as a proxy for what workers can access
  const workerFolders = folders.filter((f) => (f.worker_count ?? 0) > 0).slice(0, 4);

  return (
    <div className="flex flex-col items-stretch gap-1 lg:flex-row lg:items-center lg:gap-1">
      {/* Left panel: folders as file chips */}
      <div
        className="flex-1 rounded-[18px] p-4"
        style={{
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          background: "color-mix(in srgb, var(--muted) 40%, transparent)",
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <div
            className="text-[10.5px] font-medium uppercase tracking-[0.18em]"
            style={{ color: "var(--muted-foreground)" }}
          >
            Contexts
          </div>
          <div className="text-[10.5px]" style={{ color: "var(--muted-foreground)" }}>
            {totalFiles} {totalFiles === 1 ? "file" : "files"}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {displayFolders.length > 0 ? (
            displayFolders.map((f, i) => (
              <FolderChip key={f.name} folder={f} index={i} />
            ))
          ) : (
            // Placeholder chips when no folders exist yet
            (
              [
                { name: "ICP brief",   type: "pdf"  },
                { name: "Pricing",     type: "xlsx" },
                { name: "Tone guide",  type: "md"   },
                { name: "Style guide", type: "url"  },
              ] as { name: string; type: keyof typeof BRAIN_FILE_META }[]
            ).map(({ name, type }) => {
              const meta = BRAIN_FILE_META[type];
              const Icon = meta.Icon;
              return (
                <div
                  key={name}
                  className="inline-flex h-7 items-center gap-1.5 rounded-[9px] border px-1.5 pr-2 text-[12px]"
                  style={{
                    borderColor: "var(--border)",
                    background: "var(--card)",
                    color: "color-mix(in srgb, var(--foreground) 50%, transparent)",
                    opacity: 0.6,
                  }}
                >
                  <span
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]"
                    style={{ background: `color-mix(in srgb, ${meta.tint} 12%, transparent)`, color: meta.tint }}
                  >
                    <Icon className="h-3 w-3" strokeWidth={2} />
                  </span>
                  <span className="font-medium">{name}</span>
                  <span className="ml-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-wider" style={{ color: meta.tint }}>
                    {meta.ext}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <Connector />

      {/* Center: Company Brain focal card */}
      <div className="relative shrink-0 lg:w-[260px]">
        {/* Ambient glow */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-0 size-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl lg:size-[380px]"
          style={{ background: "rgba(62, 111, 224, 0.08)" }}
        />
        {/* Ghost brain illustration */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-0 -translate-x-1/2 -translate-y-1/2"
        >
          <Brain
            strokeWidth={1.2}
            className="size-[320px] lg:size-[420px]"
            style={{ color: "rgba(62, 111, 224, 0.18)" }}
          />
        </div>
        {/* Main card */}
        <div
          className="relative z-10 rounded-[18px] p-5 shadow-md"
          style={{ border: "1px solid var(--border)", background: "var(--card)" }}
        >
          <div className="mb-3 flex items-center justify-between">
            <div
              className="flex items-center gap-1.5 text-[14px] font-semibold"
              style={{ color: "var(--foreground)" }}
            >
              <Brain className="h-4 w-4" strokeWidth={2} style={{ color: "var(--accent)" }} />
              Company Brain
            </div>
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{
                background: "color-mix(in srgb, #22c55e 12%, transparent)",
                color: "#16a34a",
                border: "1px solid color-mix(in srgb, #22c55e 25%, transparent)",
              }}
            >
              Live
            </span>
          </div>
          <ul className="space-y-2">
            {KNOWS.map((k) => (
              <li
                key={k}
                className="flex items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-[12.5px]"
                style={{
                  border: "1px solid var(--border)",
                  background: "color-mix(in srgb, var(--muted) 50%, transparent)",
                }}
              >
                <Check
                  className="h-3.5 w-3.5 shrink-0"
                  strokeWidth={2.5}
                  style={{ color: "var(--accent)" }}
                />
                <span style={{ color: "var(--foreground)" }}>{k}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <Connector />

      {/* Right panel: used by workers */}
      <div
        className="flex-1 rounded-[18px] p-4"
        style={{
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          background: "color-mix(in srgb, var(--muted) 40%, transparent)",
        }}
      >
        <div
          className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.18em]"
          style={{ color: "var(--muted-foreground)" }}
        >
          Used by workers
        </div>
        <div className="space-y-1.5">
          {workerFolders.length > 0 ? (
            <>
              {workerFolders.map((f) => (
                <div
                  key={f.name}
                  className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12.5px]"
                  style={{ border: "1px solid var(--border)", background: "var(--card)" }}
                >
                  <span
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-[10px] font-bold"
                    style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
                  >
                    W
                  </span>
                  <span
                    className="truncate font-medium"
                    style={{ color: "var(--foreground)" }}
                  >
                    {f.worker_count} worker{(f.worker_count ?? 0) !== 1 ? "s" : ""} use {f.name}
                  </span>
                </div>
              ))}
            </>
          ) : (
            // Placeholder worker rows
            ["Client Follow-up Worker", "Monday Report Worker", "Lead Research Worker"].map((w) => (
              <div
                key={w}
                className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12.5px]"
                style={{
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  color: "color-mix(in srgb, var(--foreground) 50%, transparent)",
                  opacity: 0.5,
                }}
              >
                <span
                  className="grid h-5 w-5 shrink-0 place-items-center rounded text-[10px] font-bold"
                  style={{ background: "var(--muted)", color: "var(--muted-foreground)" }}
                >
                  W
                </span>
                <span className="truncate font-medium">{w}</span>
              </div>
            ))
          )}
          {folders.length > 0 && (
            <div className="px-3 pt-1 text-[11.5px]" style={{ color: "var(--muted-foreground)" }}>
              + every worker with brain access
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
