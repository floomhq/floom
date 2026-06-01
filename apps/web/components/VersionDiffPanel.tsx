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
  versionNumber: number;
  versionFiles: VersionFile[];
  currentFiles: VersionFile[];
  isRestoring: boolean;
  onRestore: () => void;
}

function LineDiff({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const changes = diffLines(oldContent, newContent);

  if (changes.every((c) => !c.added && !c.removed)) {
    return (
      <p className="px-4 py-6 text-center text-xs text-muted-foreground italic">
        No changes — this file is identical to the current version.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs font-mono">
        <tbody>
          {changes.map((change, ci) => {
            const lines = change.value.replace(/\n$/, "").split("\n");
            return lines.map((line, li) => {
              const key = `${ci}-${li}`;
              if (change.added) {
                return (
                  <tr key={key} className="bg-[#0d2b0d] dark:bg-[#0d2b0d]">
                    <td className="w-6 select-none pl-3 pr-2 text-green-600 dark:text-green-500">+</td>
                    <td className="whitespace-pre pr-4 text-green-300">{line}</td>
                  </tr>
                );
              }
              if (change.removed) {
                return (
                  <tr key={key} className="bg-[#2b0d0d] dark:bg-[#2b0d0d]">
                    <td className="w-6 select-none pl-3 pr-2 text-red-600 dark:text-red-500">-</td>
                    <td className="whitespace-pre pr-4 text-red-300">{line}</td>
                  </tr>
                );
              }
              return (
                <tr key={key} className="text-muted-foreground">
                  <td className="w-6 select-none pl-3 pr-2"> </td>
                  <td className="whitespace-pre pr-4">{line}</td>
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
      <table className="w-full border-collapse text-xs font-mono">
        <tbody>
          {content.replace(/\n$/, "").split("\n").map((line, i) => (
            <tr key={i} className="text-muted-foreground hover:bg-muted/30">
              <td className="w-10 select-none pl-3 pr-4 text-right text-[10px] opacity-40">{i + 1}</td>
              <td className="whitespace-pre pr-4">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VersionDiffPanel({ versionNumber, versionFiles, currentFiles, isRestoring, onRestore }: Props) {
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
    <div className="border-t border-[var(--border-default)] bg-[var(--bg-subtle,hsl(var(--muted)/0.3))]">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-default)] px-3 py-2">
        {/* File tabs */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {filePaths.map((p) => {
            const inVersion = versionFiles.some((f) => f.path === p);
            const inCurrent = currentFiles.some((f) => f.path === p);
            const label = inVersion && !inCurrent ? `${p} (deleted)` : !inVersion && inCurrent ? `${p} (added)` : p;
            return (
              <button
                key={p}
                onClick={() => setActiveFile(p)}
                className={`shrink-0 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  activeFile === p
                    ? "bg-[var(--bg-card)] text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Mode toggle */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] p-0.5">
          <button
            onClick={() => setMode("diff")}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              mode === "diff" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitCompare className="size-3" />
            Diff
          </button>
          <button
            onClick={() => setMode("full")}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              mode === "full" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <FileText className="size-3" />
            Full file
          </button>
        </div>
      </div>

      {/* Diff / full file content */}
      <div className="max-h-96 overflow-y-auto py-2">
        {mode === "diff" ? (
          <LineDiff oldContent={oldContent} newContent={newContent} />
        ) : (
          <FullFileView content={newContent || "(empty)"} />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-[var(--border-default)] px-4 py-2.5">
        <p className="text-xs text-muted-foreground">
          Restoring will overwrite the current files with v{versionNumber}.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          disabled={isRestoring}
          onClick={onRestore}
        >
          {isRestoring ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
          {isRestoring ? "Restoring…" : `Restore to v${versionNumber}`}
        </Button>
      </div>
    </div>
  );
}
