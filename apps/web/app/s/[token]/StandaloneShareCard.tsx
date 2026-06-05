"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Check, Copy, Download, ExternalLink, FileText, Layers, Package, RotateCcw } from "lucide-react";
import { BrandLogo } from "@/components/connections/BrandLogo";
import type { PublicShareFile, StandaloneShare } from "@/lib/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function entityLabel(type: StandaloneShare["entity_type"]): string {
  if (type === "worker") return "Worker";
  if (type === "brain_file") return "Brain file";
  return "Brain pack";
}

function previewText(share: StandaloneShare): string {
  if (share.entity_type === "worker") {
    const worker = share.worker;
    if (worker?.example_output) return worker.example_output;
    if (worker?.how_it_works) return worker.how_it_works;
    if (worker?.use_cases?.length) return worker.use_cases.join("\n");
    return worker?.description || "This worker is shared as a read-only card.";
  }
  return share.file?.content_text || "Preview is unavailable. Use the file list to inspect available files.";
}

function fileTitle(file?: PublicShareFile | null): string {
  if (!file) return "Preview";
  return file.path;
}

function ShareIcon({ type }: { type: StandaloneShare["entity_type"] }) {
  const Icon = type === "worker" ? Box : type === "brain_pack" ? Package : FileText;
  return <Icon className="size-5" />;
}

export function StandaloneShareCard({ share, token }: { share: StandaloneShare; token: string }) {
  const [copied, setCopied] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [activePath, setActivePath] = useState(share.file?.path || share.files[0]?.path || "");
  const [shareUrl, setShareUrl] = useState(`/s/${token}`);
  const activeFile = useMemo(
    () => share.files.find((file) => file.path === activePath) || share.file || share.files[0] || null,
    [activePath, share.file, share.files],
  );
  const text = previewText(share);
  const worker = share.worker;
  const files = share.files || [];
  const primaryHref =
    share.entity_type === "worker" && worker?.id
      ? `/workers/${encodeURIComponent(worker.id)}`
      : share.entity_type === "brain_pack"
        ? "/contexts"
        : `/s/${encodeURIComponent(token)}/download`;
  const primaryLabel =
    share.entity_type === "worker"
      ? "Run this worker"
      : share.entity_type === "brain_pack"
        ? "View pack"
        : "Download file";

  useEffect(() => {
    setShareUrl(window.location.href);
  }, []);

  async function copyShareLink() {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <main className="min-h-[calc(100vh-56px)] px-3 py-8 sm:px-5 sm:py-10 grid place-items-center">
      <div className="w-[min(452px,100%)]">
        <section className="relative h-auto min-h-[720px] overflow-hidden rounded-[13px] border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-pop)] sm:h-[760px]">
          {!showFiles ? (
            <div className="flex h-full flex-col">
              <div className="flex items-start gap-3 border-b border-[var(--border-soft)] bg-[var(--bg-2)] px-5 py-4">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--bg-3)] text-[11px] font-semibold text-[var(--ink)]">
                  W
                </span>
                <div className="min-w-0 text-[12.5px] leading-relaxed">
                  <strong className="block font-semibold text-[var(--ink)]">A Workeros operator shared this with you</strong>
                  <span className="text-[var(--ink-mute)]">Shared via Workeros / noindex</span>
                </div>
              </div>

              <div className="flex flex-1 flex-col overflow-y-auto px-6 py-5">
                <div className="mb-4 flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1 font-mono text-[11px] text-[var(--ink-soft)]">
                    <span className="size-1.5 rounded-full bg-[var(--success)]" />
                    Shared via link
                  </span>
                </div>

                <div className="mb-3 grid size-12 place-items-center rounded-[9px] border border-[var(--border-default)] bg-[var(--bg-2)] text-[var(--ink)]">
                  <ShareIcon type={share.entity_type} />
                </div>

                <h1 className="mb-2 text-[26px] font-semibold leading-tight tracking-normal text-[var(--ink)]">
                  {share.title}
                </h1>
                {share.description && (
                  <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--ink-soft)]">
                    {share.description}
                  </p>
                )}

                {worker?.connections && worker.connections.length > 0 && (
                  <div className="mb-4 flex flex-wrap gap-2">
                    {worker.connections.map((slug) => (
                      <span
                        key={slug}
                        className="inline-flex items-center gap-1.5 rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-2)] px-2 py-1 text-[11px] text-[var(--ink-soft)]"
                      >
                        <BrandLogo icon={slug} className="size-3.5" />
                        {slug.replace(/[-_]/g, " ")}
                      </span>
                    ))}
                  </div>
                )}

                {worker && (
                  <div className="mb-4 grid grid-cols-2 gap-2">
                    <div className="rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-2)] px-3 py-2">
                      <div className="font-mono text-[10px] uppercase text-[var(--ink-mute)]">Trigger</div>
                      <div className="mt-0.5 text-[12px] text-[var(--ink)]">{worker.trigger_type}</div>
                    </div>
                    <div className="rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-2)] px-3 py-2">
                      <div className="font-mono text-[10px] uppercase text-[var(--ink-mute)]">Runtime</div>
                      <div className="mt-0.5 text-[12px] text-[var(--ink)]">{worker.runtime || "worker"}</div>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setShowFiles(true)}
                  className="mb-3 flex w-full items-center justify-between gap-3 rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-2)] px-3 py-2.5 text-left font-mono text-[11px] text-[var(--ink)] hover:border-[var(--ink-mute)]"
                >
                  <span>{files.length > 0 ? `Preview ${files.length} item${files.length === 1 ? "" : "s"}` : "Preview details"}</span>
                  <RotateCcw className="size-3.5 text-[var(--ink-mute)]" />
                </button>

                <div className="overflow-hidden rounded-[9px] border border-[var(--border-default)] bg-[var(--bg-2)]">
                  <div className="border-b border-[var(--border-soft)] px-3 py-2 font-mono text-[10.5px] uppercase tracking-wide text-[var(--ink-mute)]">
                    {fileTitle(activeFile)}
                  </div>
                  <pre className="max-h-[142px] overflow-hidden whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[var(--ink-soft)]">
                    {text}
                  </pre>
                </div>

                <div className="mt-5 flex flex-col gap-2">
                  <a
                    href={primaryHref}
                    className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[9px] border border-[var(--primary)] bg-[var(--primary)] px-4 text-sm font-medium text-[var(--primary-text)] shadow-[var(--shadow-btn)]"
                  >
                    {share.entity_type === "brain_file" ? <Download className="size-4" /> : <ExternalLink className="size-4" />}
                    {primaryLabel}
                  </a>
                  <code className="block truncate rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-2)] px-3 py-2.5 font-mono text-[11px] text-[var(--ink-soft)]">
                    {shareUrl}
                  </code>
                  <button
                    type="button"
                    onClick={copyShareLink}
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-[7px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3 font-mono text-[11px] text-[var(--ink-soft)] hover:border-[var(--ink-mute)] hover:text-[var(--ink)]"
                  >
                    {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied ? "Copied" : "Copy share link"}
                  </button>
                  <div className="text-center font-mono text-[10.5px] text-[var(--ink-mute)]">
                    <b className="font-semibold text-[var(--ink-soft)]">No login needed</b>. Anyone with the link can view this page.
                  </div>
                </div>

                <div className="mt-auto flex items-center justify-between pt-5 font-mono text-[11px] text-[var(--ink-mute)]">
                  <span>{entityLabel(share.entity_type)}</span>
                  <button
                    type="button"
                    onClick={() => setShowFiles(true)}
                    className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-[var(--ink)]"
                  >
                    Inspect content
                    <Layers className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-[var(--border-soft)] px-5 py-3.5">
                <span className="font-mono text-[11px] uppercase tracking-wide text-[var(--ink-mute)]">
                  What is inside / {files.length || 1} item{files.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  onClick={() => setShowFiles(false)}
                  className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 font-mono text-[11px] text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-[var(--ink)]"
                >
                  Back
                </button>
              </div>

              {files.length > 0 && (
                <div className="flex gap-0.5 overflow-x-auto border-b border-[var(--border-soft)] px-3 pt-2">
                  {files.map((file) => (
                    <button
                      type="button"
                      key={file.path}
                      onClick={() => setActivePath(file.path)}
                      className={`mb-[-1px] whitespace-nowrap rounded-t-[5px] border-b px-2.5 py-2 font-mono text-[11px] ${
                        activeFile?.path === file.path
                          ? "border-[var(--ink)] bg-[var(--bg-2)] text-[var(--ink)]"
                          : "border-transparent text-[var(--ink-mute)] hover:text-[var(--ink)]"
                      }`}
                    >
                      {file.path}
                      <span className="ml-1 text-[var(--ink-faint)]">{formatBytes(file.size)}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-[var(--bg-2)] px-4 py-4 font-mono text-[11.5px] leading-relaxed text-[var(--ink-soft)]">
                  {activeFile?.content_text || "Preview is unavailable for this file."}
                </pre>
              </div>

              <div className="flex flex-col gap-3 border-t border-[var(--border-soft)] px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="grid size-8 place-items-center rounded-full bg-[var(--bg-3)] text-[11px] font-semibold text-[var(--ink)]">W</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-[var(--ink)]">Workeros</div>
                    <div className="font-mono text-[10.5px] text-[var(--ink-mute)]">Shared content</div>
                  </div>
                </div>
                <div className="rounded-[7px] border border-[color-mix(in_srgb,var(--success)_30%,var(--border-default))] bg-[color-mix(in_srgb,var(--success)_10%,var(--bg-card))] px-3 py-2 text-[11px] leading-relaxed text-[var(--ink-soft)]">
                  <strong className="font-semibold text-[var(--ink)]">Public preview.</strong> Review the visible content before downloading or copying.
                </div>
              </div>
            </div>
          )}
        </section>

        <div className="mx-auto mt-4 flex w-[min(452px,100%)] flex-wrap items-center justify-between gap-3 rounded-[11px] border border-[var(--border-default)] bg-[var(--bg-2)] px-5 py-4">
          <p className="m-0 text-[13px] leading-relaxed text-[var(--ink-soft)]">Like this? Run your own AI workers with Workeros.</p>
          <a
            href="/login"
            className="inline-flex h-8 items-center justify-center rounded-[7px] bg-[var(--primary)] px-3 text-xs font-medium text-[var(--primary-text)]"
          >
            Start workspace
          </a>
        </div>
      </div>
    </main>
  );
}
