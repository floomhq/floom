"use client";

// GENERIC output renderer (v6). ONE primitive, reused by the run page, the
// approval surface, and the worker example-result. It renders whatever the
// agent produced by its declared type — markdown→markdown, json→formatted
// JSON, csv→table, file→file ref, anything else→plain text — with NO
// use-case-specific chrome, badges, or "MARKDOWN REPORT"/"Completed" labels.
// Federico's HARD rule: the output area is a neutral viewer.
//
// `OutputRenderer` (the per-field variant with a label header + download
// buttons) delegates its type switch here so there is a single source of truth
// for how each output type renders (DRY).
import type React from "react";
import Papa from "papaparse";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { stripCitationTokens } from "@/lib/strip-citations";
import { sanitizeHref } from "@/lib/safe-url";

export type GenericOutputType = "markdown" | "json" | "csv" | "text" | "file" | string;

function parseCSV(text: string): string[][] {
  const result = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  return result.data as string[][];
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
  h1: ({ children }: MarkdownChildProps) => <h1 className="text-lg font-semibold mt-4 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }: MarkdownChildProps) => <h2 className="text-base font-semibold mt-3 mb-2">{children}</h2>,
  h3: ({ children }: MarkdownChildProps) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
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
    <blockquote className="[border-left:var(--bd-div)] pl-3 text-muted-foreground my-3">{children}</blockquote>
  ),
  strong: ({ children }: MarkdownChildProps) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }: MarkdownAnchorProps) => (
    <a
      href={sanitizeHref(href)}
      className="text-foreground underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  table: ({ children }: MarkdownChildProps) => (
    <div className="overflow-x-auto rounded-[var(--radius-button)] [border:var(--bd-card)] my-3">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }: MarkdownChildProps) => (
    <th className="[border-bottom:var(--bd-div)] bg-muted px-2.5 py-1.5 text-left text-xs font-medium">{children}</th>
  ),
  td: ({ children }: MarkdownChildProps) => <td className="[border-bottom:var(--bd-div)] px-2.5 py-1.5">{children}</td>,
};

function CsvTable({ value }: { value: string }) {
  const rows = parseCSV(String(value));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">Empty CSV</p>;
  const [header, ...body] = rows;
  return (
    <div className="overflow-auto rounded-[var(--radius-button)] [border:var(--bd-card)]">
      <Table>
        <TableHeader>
          <TableRow>
            {header.map((h, i) => (
              <TableHead key={i} className="text-xs font-medium">
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {body.map((row, ri) => (
            <TableRow key={ri}>
              {row.map((cell, ci) => (
                <TableCell key={ci} className="text-xs">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  let formatted: string;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    formatted = JSON.stringify(parsed as Record<string, unknown>, null, 2);
  } catch {
    formatted = String(value);
  }
  return (
    <pre className="text-xs bg-muted p-3 rounded-[var(--radius-button)] overflow-auto font-mono leading-relaxed whitespace-pre-wrap">
      {formatted}
    </pre>
  );
}

/**
 * Render a single output value by its declared type. No label, no download
 * button, no badge — just the content in a neutral viewer. Callers that need a
 * label/header/download wrap this (e.g. OutputRenderer).
 */
export function GenericOutput({
  type,
  value,
  className,
}: {
  type: GenericOutputType;
  value: unknown;
  className?: string;
}) {
  if (value == null || value === "") {
    return <p className={className ? className : "text-sm text-muted-foreground"}>No output.</p>;
  }

  if (type === "markdown") {
    const clean = stripCitationTokens(String(value));
    return (
      <div className={`prose prose-sm max-w-none text-foreground ${className ?? ""}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents as Parameters<typeof ReactMarkdown>[0]["components"]}
        >
          {clean}
        </ReactMarkdown>
      </div>
    );
  }
  if (type === "json") {
    return (
      <div className={className}>
        <JsonView value={value} />
      </div>
    );
  }
  if (type === "csv") {
    return (
      <div className={className}>
        <CsvTable value={String(value)} />
      </div>
    );
  }
  if (type === "file") {
    return (
      <div className={`bg-muted p-3 rounded-[var(--radius-button)] text-sm text-muted-foreground ${className ?? ""}`}>
        <span className="font-mono text-xs">{String(value)}</span>
      </div>
    );
  }
  // Default: plain text.
  const clean = stripCitationTokens(String(value));
  return (
    <div className={`bg-muted p-3 rounded-[var(--radius-button)] text-sm whitespace-pre-wrap font-mono leading-relaxed ${className ?? ""}`}>
      {clean}
    </div>
  );
}
