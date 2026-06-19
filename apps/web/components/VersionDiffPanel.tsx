"use client";

import { useState } from "react";
import { diffLines } from "diff";
import { Button } from "@/components/ui/button";
import { RotateCcw, FileText, GitCompare, Loader2 } from "lucide-react";

interface VersionFile {
  path: string;
  content: string;
}

interface Props {
  versionSha: string;
  versionFiles: VersionFile[];
  currentFiles: VersionFile[];
  isRestoring: boolean;
  canRestore?: boolean;
  onRestore: () => void;
}

function LineDiff({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const changes = diffLines(oldContent, newContent);

  if (changes.every((c) => !c.added && !c.removed)) {
    return (
      <p className="px-4 py-8 text-center text-xs text-muted-foreground italic">
        No changes; this file is identical to the current version.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs leading-5">
        <tbody>
          {changes.map((change, ci) => {
            const lines = change.value.replace(/\n$/, "").split("\n");
            return lines.map((line, li) => {
              const key = `${ci}-${li}`;

              if (change.added) {
                return (
                  <tr
                    key={key}
                    className="bg-[color-mix(in_srgb,var(--success)_10%,transparent)] dark:bg-[color-mix(in_srgb,var(--success)_12%,transparent)]"
                  >
                    <td className="w-7 select-none py-px pl-4 pr-2 text-[var(--success)] opacity-80">+</td>
                    <td className="whitespace-pre py-px pr-6 text-foreground">{line}</td>
                  </tr>
                );
              }

              if (change.removed) {
                return (
                  <tr
                    key={key}
                    className="bg-[color-mix(in_srgb,var(--warning)_9%,transparent)] dark:bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]"
                  >
                    <td className="w-7 select-none py-px pl-4 pr-2 text-[var(--warning)]">−</td>
                    <td className="whitespace-pre py-px pr-6 text-foreground">{line}</td>
                  </tr>
                );
              }

              return (
                <tr key={key}>
                  <td className="w-7 select-none py-px pl-4 pr-2 text-transparent"> </td>
                  <td className="whitespace-pre py-px pr-6 text-muted-foreground">{line}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
    </div>
  );
}

function FullFileView({ content }: { content: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs leading-5">
        <tbody>
          {content.replace(/\n$/, "").split("\n").map((line, i) => (
            <tr key={i} className="hover:bg-muted/40">
              <td className="w-10 select-none py-px pl-4 pr-4 text-right text-[10px] tabular-nums text-muted-foreground opacity-40">
                {i + 1}
              </td>
              <td className="whitespace-pre py-px pr-6 text-foreground">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VersionDiffPanel({
  versionSha,
  versionFiles,
  currentFiles,
  isRestoring,
  canRestore = true,
  onRestore,
}: Props) {
  const [activeFile, setActiveFile] = useState(versionFiles[0]?.path ?? "");
  const [mode, setMode] = useState<"diff" | "full">("diff");

  const versionFile = versionFiles.find((f) => f.path === activeFile);
  const currentFile = currentFiles.find((f) => f.path === activeFile);

  const oldContent = currentFile?.content ?? "";
  const newContent = versionFile?.content ?? "";

  const filePaths = Array.from(
    new Set([...versionFiles.map((f) => f.path), ...currentFiles.map((f) => f.path)])
  ).sort();

  return (
    <div className="[border-top:var(--bd-div)] bg-[var(--bg-2)]">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 [border-bottom:var(--bd-div)] px-3 py-1.5">
        {/* File tabs */}
        <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {filePaths.map((p) => {
            const inVersion = versionFiles.some((f) => f.path === p);
            const inCurrent = currentFiles.some((f) => f.path === p);
            const suffix = inVersion && !inCurrent ? " (deleted)" : !inVersion && inCurrent ? " (added)" : "";
            return (
              <button
                key={p}
                onClick={() => setActiveFile(p)}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  activeFile === p
                    ? "bg-[var(--bg-card)] text-foreground shadow-[var(--shadow-sm)]"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p}
                {suffix && <span className="ml-1 opacity-60">{suffix}</span>}
              </button>
            );
          })}
        </div>

        {/* Diff / Full toggle */}
        <div className="flex shrink-0 items-center rounded-md [border:var(--bd-card)] bg-[var(--bg-card)] p-0.5">
          <button
            onClick={() => setMode("diff")}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              mode === "diff"
                ? "bg-[var(--bg-2)] text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitCompare className="size-3" />
            Diff
          </button>
          <button
            onClick={() => setMode("full")}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              mode === "full"
                ? "bg-[var(--bg-2)] text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <FileText className="size-3" />
            Full file
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-h-80 overflow-y-auto bg-[var(--bg-card)] py-2">
        {mode === "diff" ? (
          <LineDiff oldContent={oldContent} newContent={newContent} />
        ) : (
          <FullFileView content={newContent || "(empty)"} />
        )}
      </div>

      {/* Footer */}
      {canRestore && (
        <div className="flex items-center justify-between [border-top:var(--bd-div)] px-4 py-2.5">
          <p className="text-xs text-muted-foreground">
            Restoring replaces this file&apos;s current contents with commit {versionSha}.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            disabled={isRestoring}
            onClick={onRestore}
          >
            {isRestoring ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RotateCcw className="size-3" />
            )}
            {isRestoring ? "Restoring…" : `Restore to ${versionSha}`}
          </Button>
        </div>
      )}
    </div>
  );
}
