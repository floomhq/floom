"use client";

// v6 Worker share card. ONE fixed-height card that flips: the FRONT face is the
// employee summary (name, one-line what-it-does, trigger, tools as real brand
// logos, example/last result via the GENERIC renderer); the BACK face is a TOP
// TAB BAR that swaps file content in a single pane (no scroll-through). A pinned
// "Add to workspace" CTA sits at the bottom of both faces.
//
// The data is the strict allow-list `PublicWorker` (no source, no secrets). The
// back-face "files" are therefore SYNTHESIZED from the public fields
// (SKILL.md from the description/use-cases/how-it-works, worker.yml from the
// trigger + tools + contexts) plus an Output tab that renders the example
// result through the same GenericOutput primitive used on the run page. The old
// `npx ... add <token>` install artifact is intentionally dropped.
import { useState } from "react";
import Link from "next/link";
import { Clock, FileText, MousePointerClick, Webhook, Zap } from "lucide-react";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import { GenericOutput } from "@/components/generic-output";
import { SHARE_CARD_BODY_HEIGHT } from "@/components/share/ShareCardShell";
import type { PublicWorker } from "@/lib/types";

const SLUG_ALIASES: Record<string, string> = {
  googlecalendar: "google-calendar",
  googledrive: "google-drive",
  googledocs: "google-docs",
  googlesheets: "google-sheets",
  googlemeet: "google-meet",
};
function normalizeSlug(slug: string): string {
  const lower = slug.toLowerCase();
  return SLUG_ALIASES[lower] ?? lower;
}

function triggerMeta(type: string): { label: string; Icon: typeof Clock } {
  switch (type) {
    case "schedule":
      return { label: "Runs on a schedule", Icon: Clock };
    case "webhook":
      return { label: "Runs on a webhook", Icon: Webhook };
    case "composio":
      return { label: "Runs on an event", Icon: Zap };
    default:
      return { label: "Runs on demand", Icon: MousePointerClick };
  }
}

function exampleType(worker: PublicWorker): string {
  // Infer the example-result type from the declared outputs (first output's
  // type), falling back to markdown/text. Keeps the GenericOutput call honest.
  const first = worker.outputs?.[0]?.type;
  if (first === "json" || first === "csv" || first === "markdown" || first === "text" || first === "file") return first;
  const ex = (worker.example_output ?? "").trim();
  if (ex.startsWith("{") || ex.startsWith("[")) return "json";
  return "markdown";
}

function buildSkillMd(worker: PublicWorker): string {
  const lines: string[] = [`# ${worker.name}`, ""];
  if (worker.description) lines.push(worker.description, "");
  if (worker.how_it_works) {
    lines.push("## How it works", "", worker.how_it_works, "");
  }
  if (worker.use_cases && worker.use_cases.length > 0) {
    lines.push("## Use cases", "");
    for (const uc of worker.use_cases) lines.push(`- ${uc}`);
    lines.push("");
  }
  if (worker.inputs.length > 0) {
    lines.push("## Inputs", "");
    for (const inp of worker.inputs) {
      lines.push(`- \`${inp.name}\` (${inp.type})${inp.required ? " — required" : ""}${inp.description ? ` — ${inp.description}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function buildWorkerYml(worker: PublicWorker): string {
  const tools = (worker.connections ?? []).map(normalizeSlug);
  const lines: string[] = [`name: ${worker.name}`, `trigger:`, `  type: ${worker.trigger_type}`];
  if (worker.runtime) lines.push(`runtime: ${worker.runtime}`);
  if (tools.length > 0) {
    lines.push("tools:");
    for (const t of tools) lines.push(`  - ${t}`);
  }
  if (worker.outputs.length > 0) {
    lines.push("outputs:");
    for (const out of worker.outputs) lines.push(`  - ${out.name}: ${out.type}`);
  }
  return lines.join("\n");
}

type FileTab = "skill" | "yaml" | "output";

export function WorkerShareCard({ worker }: { worker: PublicWorker }) {
  const [flipped, setFlipped] = useState(false);
  const [tab, setTab] = useState<FileTab>("skill");

  const { label: triggerLabel, Icon: TriggerIcon } = triggerMeta(worker.trigger_type);
  const tools = (worker.connections ?? []).map(normalizeSlug);
  const hasExample = Boolean((worker.example_output ?? "").trim());

  return (
    <div className="px-7 pb-4">
      <p className="mb-2.5 pt-5 font-mono text-[11px] text-[var(--ink-faint)]">
        Click &ldquo;See files&rdquo; to flip · click a tab to switch file
      </p>
      <div style={{ perspective: 1200, height: SHARE_CARD_BODY_HEIGHT }}>
        <div
          className="relative h-full w-full transition-transform duration-500"
          style={{ transformStyle: "preserve-3d", transform: flipped ? "rotateY(180deg)" : "none" }}
        >
          {/* FRONT */}
          <div
            className="absolute inset-0 flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--card-border)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]"
            style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden" }}
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* Title */}
              <div className="flex items-start gap-4 px-5 py-4">
                <WorkerAvatar seed={worker.id} name={worker.name} size="size-11" />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h1 className="text-lg font-semibold tracking-tight">{worker.name}</h1>
                    {worker.is_example && (
                      <span className="inline-flex items-center rounded-[var(--radius-button)] border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Example
                      </span>
                    )}
                  </div>
                  {worker.description && (
                    <p className="text-sm leading-relaxed text-[var(--ink-soft)]">{worker.description}</p>
                  )}
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-[var(--ink-soft)]">
                    <TriggerIcon className="size-3.5" />
                    <span>{triggerLabel}</span>
                  </div>
                </div>
              </div>

              {/* What it does */}
              {worker.use_cases && worker.use_cases.length > 0 && (
                <div className="border-t border-[var(--border-soft)] px-5 py-4">
                  <p className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-soft)]">
                    What it does
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {worker.use_cases.map((uc) => (
                      <li key={uc} className="flex gap-2.5 text-sm leading-relaxed">
                        <span className="mt-2 size-1 shrink-0 rounded-full bg-[var(--ink-soft)]" aria-hidden />
                        <span>{uc}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Tools */}
              {tools.length > 0 && (
                <div className="border-t border-[var(--border-soft)] px-5 py-4">
                  <p className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-soft)]">Tools</p>
                  <div className="flex flex-wrap gap-2">
                    {tools.map((slug) => (
                      <span
                        key={slug}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--card-glass)] px-2.5 py-1 text-xs"
                      >
                        <BrandLogo icon={slug} className="size-3.5" />
                        <span className="capitalize">{slug.replace(/-/g, " ")}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Example / last result — GENERIC renderer */}
              {hasExample && (
                <div className="border-t border-[var(--border-soft)] px-5 py-4">
                  <p className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-soft)]">
                    Example result
                  </p>
                  <GenericOutput
                    type={exampleType(worker)}
                    value={worker.example_output}
                    className="rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-app)] p-3"
                  />
                </div>
              )}
            </div>

            {/* Pinned CTA */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--border-soft)] bg-[var(--bg-2)] px-5 py-3">
              <p className="text-xs leading-relaxed text-[var(--ink-soft)]">
                Add this worker to your workspace and connect its tools.
              </p>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setFlipped(true)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--line)] bg-[var(--card-glass)] px-3.5 text-[13px] font-medium hover:bg-[var(--bg-2)]"
                >
                  <FileText className="size-3.5" />
                  See files
                </button>
                <Link
                  href="/login"
                  className="inline-flex h-9 items-center rounded-[var(--radius-button)] bg-[var(--primary)] px-4 text-[13px] font-medium text-[var(--primary-text)] no-underline hover:opacity-90"
                >
                  Add to workspace
                </Link>
              </div>
            </div>
          </div>

          {/* BACK */}
          <div
            className="absolute inset-0 flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--card-border)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]"
            style={{ backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
          >
            {/* Back header */}
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-soft)] px-4 py-3">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setFlipped(false)}
                  aria-label="Back to overview"
                  className="inline-flex size-7 items-center justify-center rounded-[var(--radius-button)] border border-[var(--line)] hover:bg-[var(--bg-2)]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                <span className="text-[13px] font-semibold">Worker files</span>
              </div>
              <Link
                href="/login"
                className="inline-flex h-7 items-center rounded-[var(--radius-button)] bg-[var(--primary)] px-3 text-xs font-medium text-[var(--primary-text)] no-underline hover:opacity-90"
              >
                Add to workspace
              </Link>
            </div>

            {/* TOP TAB BAR */}
            <div className="flex shrink-0 border-b border-[var(--line)] bg-[var(--bg-2)]">
              {([
                ["skill", "SKILL.md"],
                ["yaml", "worker.yml"],
                ...(hasExample ? ([["output", "output"]] as const) : []),
              ] as [FileTab, string][]).map(([key, labelText]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`-mb-px border-b-2 px-4 py-2 font-mono text-xs transition-colors ${
                    tab === key
                      ? "border-[var(--ink)] bg-[var(--bg-card)] font-medium text-[var(--ink)]"
                      : "border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]"
                  }`}
                >
                  {labelText}
                </button>
              ))}
            </div>

            {/* FILE PANE — only the active file, scrolls within itself */}
            <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-card)]">
              {tab === "skill" && (
                <FilePane meta="Markdown">
                  <GenericOutput type="markdown" value={buildSkillMd(worker)} className="px-5 py-4" />
                </FilePane>
              )}
              {tab === "yaml" && (
                <FilePane meta="YAML">
                  <pre className="overflow-x-auto px-5 py-4 font-mono text-[11px] leading-relaxed text-[var(--ink-soft)]">
                    {buildWorkerYml(worker)}
                  </pre>
                </FilePane>
              )}
              {tab === "output" && hasExample && (
                <FilePane meta="Example output">
                  <GenericOutput type={exampleType(worker)} value={worker.example_output} className="px-5 py-4" />
                </FilePane>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FilePane({ meta, children }: { meta: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-[var(--border-soft)] bg-[var(--bg-2)] px-4 py-2">
        <FileText className="size-3.5 text-[var(--ink-soft)]" />
        <span className="font-mono text-[11px] text-[var(--ink-soft)]">{meta}</span>
      </div>
      {children}
    </div>
  );
}
