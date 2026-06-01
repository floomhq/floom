"use client";

import type React from "react";
import Papa from "papaparse";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import type { OutputField } from "@/lib/types";
import { stripCitationTokens } from "@/lib/strip-citations";

function parseCSV(text: string): string[][] {
  const result = Papa.parse<string[]>(text.trim(), {
    skipEmptyLines: true,
  });
  return result.data as string[][];
}

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function DownloadButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
      onClick={onClick}
      title={`Download as ${label}`}
    >
      <Download className="w-3 h-3" />
      {label}
    </Button>
  );
}

function OutputCSV({ value, filename }: { value: string; filename: string }) {
  const rows = parseCSV(String(value));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Empty CSV</p>;
  const [header, ...body] = rows;
  return (
    <div className="space-y-2">
      <div className="overflow-auto max-h-[400px] rounded-[var(--radius-card)] border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {header.map((h, i) => (
                <TableHead key={i} className="text-xs font-medium">{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {body.map((row, ri) => (
              <TableRow key={ri}>
                {row.map((cell, ci) => (
                  <TableCell key={ci} className="text-xs">{cell}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <DownloadButton
        label=".csv"
        onClick={() => downloadBlob(String(value), filename, "text/csv")}
      />
    </div>
  );
}

function OutputJSON({ value, filename }: { value: unknown; filename: string }) {
  let formatted: string;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    formatted = JSON.stringify(parsed as Record<string, unknown>, null, 2);
  } catch {
    formatted = String(value);
  }
  return (
    <div className="space-y-2">
      <pre className="text-xs bg-muted p-3 rounded-[var(--radius-button)] overflow-auto font-mono leading-relaxed whitespace-pre-wrap">
        {formatted}
      </pre>
      <DownloadButton
        label=".json"
        onClick={() => downloadBlob(formatted, filename, "application/json")}
      />
    </div>
  );
}

interface MarkdownChildProps {
  children?: React.ReactNode;
}

interface MarkdownCodeProps extends MarkdownChildProps {
  inline?: boolean;
}

interface MarkdownAnchorProps extends MarkdownChildProps {
  href?: string;
}

const markdownComponents = {
  h1: ({ children }: MarkdownChildProps) => <h1 className="text-xl font-semibold mt-4 mb-2">{children}</h1>,
  h2: ({ children }: MarkdownChildProps) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
  h3: ({ children }: MarkdownChildProps) => <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>,
  p: ({ children }: MarkdownChildProps) => <p className="text-sm mb-3 leading-relaxed">{children}</p>,
  ul: ({ children }: MarkdownChildProps) => <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>,
  ol: ({ children }: MarkdownChildProps) => <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>,
  li: ({ children }: MarkdownChildProps) => <li className="text-sm">{children}</li>,
  code: ({ inline, children }: MarkdownCodeProps) =>
    inline ? (
      <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono">{children}</code>
    ) : (
      <pre className="bg-muted p-3 rounded-[var(--radius-button)] overflow-auto text-xs font-mono mb-3 whitespace-pre-wrap">
        <code>{children}</code>
      </pre>
    ),
  blockquote: ({ children }: MarkdownChildProps) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground my-3">{children}</blockquote>
  ),
  strong: ({ children }: MarkdownChildProps) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }: MarkdownAnchorProps) => (
    <a href={href} className="text-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground" target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

export function OutputRenderer({
  field,
  runId,
}: {
  field: OutputField;
  runId?: string;
}) {
  const { type, value, label, name } = field;
  const safeRunId = runId || "run";
  const baseFilename = `${safeRunId}-${name}`;

  if (value == null || value === "") {
    return (
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">{label || name}</p>
        <p className="text-sm text-muted-foreground">No output.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">{label || name}</p>
      {type === "markdown" ? (
        (() => {
          // G5 rescore4 P2: strip OpenAI web_search citation markers
          // (citeturn0search9 …) before rendering AND before download.
          const clean = stripCitationTokens(String(value));
          return (
            <div className="space-y-2">
              <div className="prose prose-sm max-w-none text-foreground bg-muted/30 p-4 rounded-[var(--radius-button)] border border-border">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents as Parameters<typeof ReactMarkdown>[0]["components"]}>
                  {clean}
                </ReactMarkdown>
              </div>
              <DownloadButton
                label=".md"
                onClick={() => downloadBlob(clean, `${baseFilename}.md`, "text/markdown")}
              />
            </div>
          );
        })()
      ) : type === "json" ? (
        <OutputJSON value={value} filename={`${baseFilename}.json`} />
      ) : type === "csv" ? (
        <OutputCSV value={String(value)} filename={`${baseFilename}.csv`} />
      ) : type === "file" ? (
        <div className="bg-muted p-3 rounded-[var(--radius-button)] text-sm text-muted-foreground">
          <span className="font-mono text-xs">{String(value)}</span>
        </div>
      ) : (
        (() => {
          // G5 rescore4 P2: strip citation markers from plain-text output too.
          const clean = stripCitationTokens(String(value));
          return (
            <div className="space-y-2">
              <div className="bg-muted p-3 rounded-[var(--radius-button)] text-sm whitespace-pre-wrap font-mono leading-relaxed">
                {clean}
              </div>
              <DownloadButton
                label=".txt"
                onClick={() => downloadBlob(clean, `${baseFilename}.txt`, "text/plain")}
              />
            </div>
          );
        })()
      )}
    </div>
  );
}
