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
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Clock, MousePointerClick, Webhook, Zap } from "lucide-react";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { Avatar } from "@/components/ui/Avatar";
import { GenericOutput } from "@/components/generic-output";
import { SHARE_CARD_BODY_HEIGHT } from "@/components/share/ShareCardShell";
import { sanitizeOutputText } from "@/lib/strip-citations";
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
      lines.push(`- \`${inp.name}\` (${inp.type})${inp.required ? " (required)" : ""}${inp.description ? `: ${inp.description}` : ""}`);
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

export function WorkerShareCard({ worker, authed = false, token }: { worker: PublicWorker; authed?: boolean; token?: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<FileTab>("skill");
  const [importing, setImporting] = useState(false);
  const [importedId, setImportedId] = useState<string | null>(null);

  const { label: triggerLabel, Icon: TriggerIcon } = triggerMeta(worker.trigger_type);
  const tools = (worker.connections ?? []).map(normalizeSlug);
  const hasExample = Boolean((worker.example_output ?? "").trim());

  async function handleImport() {
    if (!token || importing) return;
    setImporting(true);
    try {
      const result = await api.workers.importFromShare(token);
      setImportedId(result.worker_id);
      router.push(`/workers?sel=${encodeURIComponent(result.worker_id)}`);
    } catch {
      setImporting(false);
    }
  }

  // CTA element differs: authed users get an import button; guests go to login.
  const ctaHref = authed ? undefined : "/login";
  const ctaLabel = importedId ? "View worker" : importing ? "Importing..." : "Add to workspace";

  const importButton = authed && token ? (
    <button
      type="button"
      onClick={() => void handleImport()}
      disabled={importing || importedId != null}
      className="inline-flex h-9 items-center rounded-[var(--radius-button)] bg-[var(--primary)] px-4 text-[13px] font-medium text-[var(--primary-text)] hover:opacity-90 disabled:opacity-60"
    >
      {ctaLabel}
    </button>
  ) : (
    <Link
      href={ctaHref ?? "/login"}
      className="inline-flex h-9 items-center rounded-[var(--radius-button)] bg-[var(--primary)] px-4 text-[13px] font-medium text-[var(--primary-text)] no-underline hover:opacity-90"
    >
      {ctaLabel}
    </Link>
  );

  // S8: the standalone worker share is the worker's FILES — its skill file and
  // worker.yml (+ an example output when present). One compact identity line,
  // then the files front-and-center. No flip, no heavy summary card, no boxed
  // chrome: flat, files-first, separated by a soft inset surface.
  return (
    <div className="px-7 pb-5 pt-5">
      {/* Compact identity */}
      <div className="mb-3 flex items-start gap-3">
        <Avatar role="worker" id={worker.id} name={worker.name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold tracking-tight">{worker.name}</h1>
            {worker.is_example && (
              <span className="text-[10px] uppercase tracking-wide text-[var(--ink-faint)]">Example</span>
            )}
          </div>
          {worker.description && (
            <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ink-soft)]">{worker.description}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-soft)]">
            <span className="inline-flex items-center gap-1.5">
              <TriggerIcon className="size-3.5" />
              {triggerLabel}
            </span>
            {tools.map((slug) => (
              <span key={slug} className="inline-flex items-center gap-1.5">
                <BrandLogo icon={slug} className="size-3.5" />
                <span className="capitalize">{slug.replace(/-/g, " ")}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* FILES — the center of the share. Soft inset surface, hairline tab bar. */}
      <div
        className="flex flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--bg-2)]"
        style={{ height: SHARE_CARD_BODY_HEIGHT }}
      >
        {/* Tab bar */}
        <div className="flex shrink-0 [border-bottom:var(--bd-div)]">
          {([
            ["skill", "SKILL.md"],
            ["yaml", "worker.yml"],
            ...(hasExample ? ([["output", "output"]] as const) : []),
          ] as [FileTab, string][]).map(([key, labelText]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-4 py-2.5 font-mono text-xs transition-colors ${
                tab === key
                  ? "bg-[var(--bg-card)] font-medium text-[var(--ink)]"
                  : "text-[var(--ink-soft)] hover:text-[var(--ink)]"
              }`}
            >
              {labelText}
            </button>
          ))}
        </div>

        {/* Active file — white "paper" sheet, scrolls within itself */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-card)]">
          {tab === "skill" && (
            <GenericOutput type="markdown" value={buildSkillMd(worker)} className="px-5 py-4" />
          )}
          {tab === "yaml" && (
            <pre className="overflow-x-auto px-5 py-4 font-mono text-[11px] leading-relaxed text-[var(--ink-soft)]">
              {/* worker.yml is synthesized from public fields; sanitize for
                  consistency so no internal marker can ever render here (#1752). */}
              {sanitizeOutputText(buildWorkerYml(worker))}
            </pre>
          )}
          {tab === "output" && hasExample && (
            <GenericOutput type={exampleType(worker)} value={worker.example_output} className="px-5 py-4" />
          )}
        </div>
      </div>

      {/* CTA */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-[var(--ink-soft)]">
          {authed
            ? "Import this worker into your workspace and connect its tools."
            : "Add this worker to your workspace and connect its tools."}
        </p>
        {importButton}
      </div>
    </div>
  );
}
