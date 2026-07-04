"use client";

// Public worker share card: overview first, with source/setup available as
// secondary panes for agents and technical users.
import { useState } from "react";
import type { ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, setActiveWorkspaceId } from "@/lib/api";
import { Check, Clipboard, Clock, Copy, Download, MousePointerClick, Settings2, Terminal, Webhook, Zap } from "lucide-react";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { Avatar } from "@/components/ui/Avatar";
import { SHARE_CARD_BODY_HEIGHT } from "@/components/share/ShareCardShell";
import { useWorkspaceHref } from "@/lib/useWorkspaceHref";
import { sanitizeOutputText } from "@/lib/strip-citations";
import type { PublicShareFile, PublicWorker } from "@/lib/types";

type IconComponent = ComponentType<{ className?: string }>;

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

function triggerMeta(type: string): { label: string; Icon: IconComponent } {
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
  const lines: string[] = [`name: ${worker.name}`, "trigger:", `  type: ${worker.trigger_type}`];
  if (worker.runtime) lines.push(`runtime: ${worker.runtime}`);
  if (tools.length > 0) {
    lines.push("tools:");
    for (const tool of tools) lines.push(`  - ${tool}`);
  }
  if (worker.outputs.length > 0) {
    lines.push("outputs:");
    for (const output of worker.outputs) lines.push(`  - ${output.name}: ${output.type}`);
  }
  return lines.join("\n");
}

type FileTab = "overview" | "source" | "setup";

function sourceText(file: PublicShareFile): string {
  return file.content ?? file.content_text ?? "";
}

function displayPath(file: PublicShareFile): string {
  return file.path || "file";
}

function findFile(files: PublicShareFile[], names: string[]): PublicShareFile | null {
  return files.find((file) => names.includes(displayPath(file))) ?? null;
}

function sourceBundle(files: PublicShareFile[], worker: PublicWorker): string {
  if (files.length > 0) {
    return files
      .map((file) => `# ${displayPath(file)}\n\n${sourceText(file)}`)
      .join("\n\n---\n\n")
      .trim();
  }
  return buildSkillMd(worker);
}

function downloadText(filename: string, content: string) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function shareLoginHref(token?: string): string {
  if (!token) return "/login";
  const sharePath = `/s/${encodeURIComponent(token)}`;
  return `/login?next=${encodeURIComponent(sharePath)}`;
}

export function WorkerShareCard({
  worker,
  authed = false,
  token,
  files = [],
  sharedBy,
}: {
  worker: PublicWorker;
  authed?: boolean;
  token?: string;
  files?: PublicShareFile[];
  sharedBy?: { label: string; display_name?: string; email?: string } | null;
}) {
  const router = useRouter();
  const workspaceHref = useWorkspaceHref();
  const [tab, setTab] = useState<FileTab>("overview");
  const [importing, setImporting] = useState(false);
  const [importedId, setImportedId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const { label: triggerLabel, Icon: TriggerIcon } = triggerMeta(worker.trigger_type);
  const tools = (worker.connections ?? []).map(normalizeSlug);
  const skillFile = findFile(files, ["SKILL.md"]);
  const workerFile = findFile(files, ["worker.yml", "worker.yaml"]);
  const visibleFiles = files.filter((file) => sourceText(file).trim());
  const shareUrl = typeof window !== "undefined" ? window.location.href : "";
  const installPrompt = `Import this Floom worker template into my workspace and keep it in test mode first: ${shareUrl}`;
  const sharerLabel = sharedBy?.label || "a Floom user";

  async function handleImport() {
    if (!token || importing) return;
    setImporting(true);
    try {
      const result = await api.workers.importFromShare(token);
      setImportedId(result.worker_id);
      // L6: if the response carries the workspace the worker was imported into
      // (cloud-side enrichment), stamp it into localStorage/cookie so the
      // redirect lands in the correct workspace for brand-new users who have
      // no activeWorkspaceId yet.
      if (result.workspace_id) {
        setActiveWorkspaceId(result.workspace_id);
      }
      router.push(workspaceHref(`/workers?sel=${encodeURIComponent(result.worker_id)}`));
    } catch {
      setImporting(false);
    }
  }

  async function copyText(kind: string, value: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1400);
    } catch {
      setCopied(null);
    }
  }

  // CTA element differs: authed users get an import button; guests go to login.
  const ctaHref = authed ? undefined : shareLoginHref(token);
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

  return (
    <div className="min-w-0 px-3 pb-5 pt-5 sm:px-7">
      <div className="mb-4 flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar role="worker" id={worker.id} name={worker.name} size={40} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-[var(--ink-soft)]">
              {sharerLabel} is sharing this worker with you
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-[var(--ink)] sm:text-2xl">{worker.name}</h1>
            {worker.description && (
              <p className="mt-2 max-w-[620px] text-sm leading-6 text-[var(--ink-soft)]">{worker.description}</p>
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2 sm:ml-auto sm:shrink-0">
          <ActionButton
            icon={Copy}
            label={copied === "link" ? "Copied" : "Copy link"}
            onClick={() => void copyText("link", shareUrl)}
          />
          <ActionButton
            icon={Clipboard}
            label={copied === "agent" ? "Copied" : "Copy agent prompt"}
            onClick={() => void copyText("agent", installPrompt)}
          />
        </div>
      </div>

      <div
        className="flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--bg-2)] [border:var(--bd-div)]"
        style={{ height: SHARE_CARD_BODY_HEIGHT }}
      >
        <div className="flex min-w-0 shrink-0 overflow-x-auto [border-bottom:var(--bd-div)] bg-[var(--bg-card)]">
          {([
            ["overview", "Overview"],
            ["source", "Source"],
            ["setup", "Setup"],
          ] as [FileTab, string][]).map(([key, labelText]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`inline-flex h-11 shrink-0 items-center gap-2 px-4 text-sm transition-colors ${
                tab === key
                  ? "bg-[var(--bg-2)] font-medium text-[var(--ink)]"
                  : "text-[var(--ink-soft)] hover:text-[var(--ink)]"
              }`}
            >
              {labelText}
            </button>
          ))}
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--bg-card)]">
          {tab === "overview" && (
            <OverviewPane worker={worker} tools={tools} triggerLabel={triggerLabel} TriggerIcon={TriggerIcon} />
          )}
          {tab === "source" && (
            <SourcePane
              worker={worker}
              files={visibleFiles}
              skillFile={skillFile}
              onCopy={() => void copyText("source", sourceBundle(visibleFiles, worker))}
              onDownload={() => downloadText(`${worker.id || "worker"}-source.txt`, sourceBundle(visibleFiles, worker))}
              copied={copied === "source"}
            />
          )}
          {tab === "setup" && (
            <SetupPane
              worker={worker}
              workerFile={workerFile}
              installPrompt={installPrompt}
              onCopyPrompt={() => void copyText("agent", installPrompt)}
              copiedPrompt={copied === "agent"}
            />
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

function ActionButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: IconComponent;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-button)] bg-[var(--bg-card)] px-3 text-[13px] font-medium text-[var(--ink)] [border:var(--bd-div)] hover:bg-[var(--bg-2)]"
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

function OverviewPane({
  worker,
  tools,
  triggerLabel,
  TriggerIcon,
}: {
  worker: PublicWorker;
  tools: string[];
  triggerLabel: string;
  TriggerIcon: IconComponent;
}) {
  return (
    <div className="space-y-5 px-5 py-5">
      {worker.long_description && worker.long_description !== worker.description && (
        <section>
          <h2 className="text-sm font-semibold text-[var(--ink)]">What this worker does</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{worker.long_description}</p>
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <InfoTile label="Run mode" value={triggerLabel} icon={TriggerIcon} />
        <InfoTile label="Runtime" value={worker.runtime || "Worker"} icon={Terminal} />
        <InfoTile label="Tools" value={tools.length ? `${tools.length} connected` : "No tools"} icon={Settings2} />
      </div>

      {tools.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-[var(--ink)]">Tools used</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {tools.map((slug) => (
              <span key={slug} className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-button)] bg-[var(--bg-2)] px-3 text-sm text-[var(--ink)]">
                <BrandLogo icon={slug} className="size-4" />
                <span className="capitalize">{slug.replace(/-/g, " ")}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {worker.use_cases && worker.use_cases.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-[var(--ink)]">Use cases</h2>
          <div className="mt-2 grid gap-2">
            {worker.use_cases.map((item) => (
              <div key={item} className="flex gap-2 rounded-[var(--radius-card)] bg-[var(--bg-2)] px-3 py-2 text-sm leading-6 text-[var(--ink-soft)]">
                <Check className="mt-1 size-3.5 shrink-0 text-[var(--ink)]" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {worker.inputs.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-[var(--ink)]">Inputs</h2>
          <div className="mt-2 grid gap-2">
            {worker.inputs.map((input) => (
              <div key={input.name} className="rounded-[var(--radius-card)] bg-[var(--bg-2)] px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-[var(--radius-button)] bg-[var(--bg-card)] px-2 py-1 font-mono text-xs text-[var(--ink)] [border:var(--bd-div)]">
                    {input.name}
                  </code>
                  <span className="text-xs font-medium text-[var(--ink-soft)]">{input.type}</span>
                  {input.required && <span className="text-xs text-[var(--warning)]">required</span>}
                </div>
                {input.description && (
                  <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">{input.description}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function InfoTile({ label, value, icon: Icon }: { label: string; value: string; icon: IconComponent }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--bg-2)] px-3 py-3">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--ink-soft)]">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="mt-2 text-sm font-medium text-[var(--ink)]">{value}</p>
    </div>
  );
}

function SourcePane({
  worker,
  files,
  skillFile,
  onCopy,
  onDownload,
  copied,
}: {
  worker: PublicWorker;
  files: PublicShareFile[];
  skillFile: PublicShareFile | null;
  onCopy: () => void;
  onDownload: () => void;
  copied: boolean;
}) {
  const primary = skillFile ? sourceText(skillFile) : buildSkillMd(worker);
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 [border-bottom:var(--bd-div)] bg-[var(--bg-card)] px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--ink)]">Source files</h2>
          <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
            {files.length ? `${files.length} shared files` : "Public summary generated from the worker metadata"}
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton icon={Copy} label={copied ? "Copied" : "Copy source"} onClick={onCopy} />
          <ActionButton icon={Download} label="Download" onClick={onDownload} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <pre className="whitespace-pre-wrap break-words rounded-[var(--radius-card)] bg-[var(--bg-2)] p-4 font-mono text-xs leading-5 text-[var(--ink)] [border:var(--bd-div)]">
          {sanitizeOutputText(primary)}
        </pre>
      </div>
    </div>
  );
}

function SetupPane({
  worker,
  workerFile,
  installPrompt,
  onCopyPrompt,
  copiedPrompt,
}: {
  worker: PublicWorker;
  workerFile: PublicShareFile | null;
  installPrompt: string;
  onCopyPrompt: () => void;
  copiedPrompt: boolean;
}) {
  const manifest = workerFile ? sourceText(workerFile) : buildWorkerYml(worker);
  return (
    <div className="space-y-4 px-5 py-5">
      <section className="rounded-[var(--radius-card)] bg-[var(--bg-2)] px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--ink)]">Agent install prompt</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--ink-soft)]">
              Give this to an agent that has access to Floom. It imports the template and keeps the first run in preview mode.
            </p>
          </div>
          <ActionButton icon={Clipboard} label={copiedPrompt ? "Copied" : "Copy prompt"} onClick={onCopyPrompt} />
        </div>
        <pre className="mt-3 whitespace-pre-wrap rounded-[var(--radius-card)] bg-[var(--bg-card)] p-3 font-mono text-xs leading-5 text-[var(--ink)] [border:var(--bd-div)]">
          {installPrompt}
        </pre>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-[var(--ink)]">Worker setup</h2>
        <pre className="mt-2 overflow-x-auto rounded-[var(--radius-card)] bg-[var(--bg-2)] p-4 font-mono text-xs leading-5 text-[var(--ink)] [border:var(--bd-div)]">
          {sanitizeOutputText(manifest)}
        </pre>
      </section>
    </div>
  );
}
