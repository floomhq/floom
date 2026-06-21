"use client";

// GENERIC output renderer (v6). ONE primitive, reused by the run page, the
// approval surface, and the worker example-result. It renders whatever the
// agent produced by its declared type — markdown→markdown, json→formatted
// JSON, csv→table, file→file ref, anything else→plain text — with NO
// use-case-specific chrome, badges, or "MARKDOWN REPORT"/"Completed" labels.
// the operator's HARD rule: the output area is a neutral viewer.
//
// `OutputRenderer` (the per-field variant with a label header + download
// buttons) delegates its type switch here so there is a single source of truth
// for how each output type renders (DRY).
import type React from "react";
import Papa from "papaparse";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sanitizeOutputText, sanitizeJsonValue } from "@/lib/strip-citations";
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
                {sanitizeOutputText(h)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {body.map((row, ri) => (
            <TableRow key={ri}>
              {row.map((cell, ci) => (
                <TableCell key={ci} className="text-xs">
                  {sanitizeOutputText(cell)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function JsonCode({ value }: { value: unknown }) {
  let formatted: string;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    // Deep-sanitize so internal <REDACTED:...> markers / citation tokens never
    // render in the raw JSON block (#1703).
    formatted = JSON.stringify(sanitizeJsonValue(parsed) as Record<string, unknown>, null, 2);
  } catch {
    formatted = sanitizeOutputText(String(value));
  }
  return (
    <pre className="text-xs bg-muted p-3 rounded-[var(--radius-button)] overflow-auto font-mono leading-relaxed whitespace-pre-wrap">
      {formatted}
    </pre>
  );
}

// A primitive cell value: render scalars inline, nested objects/arrays as a
// compact code chip so a column stays readable instead of spilling raw JSON.
function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function humanizeColumn(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function CellValue({ value }: { value: unknown }) {
  if (value == null || value === "") return <span className="text-muted-foreground">—</span>;
  if (isScalar(value)) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
    return <span className="whitespace-pre-wrap break-words">{sanitizeOutputText(text)}</span>;
  }
  // Nested object/array inside a cell: keep it compact and non-disruptive.
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-muted-foreground">
      {Array.isArray(value) ? `${value.length} item${value.length === 1 ? "" : "s"}` : "{…}"}
    </code>
  );
}

/**
 * Render an array of plain objects (e.g. a candidate shortlist) as a clean
 * table. Columns are the union of the rows' keys in first-seen order, so a
 * heterogeneous list still renders without dropping data.
 */
function ObjectTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  if (columns.length === 0) return <JsonCode value={rows} />;
  return (
    <div className="overflow-auto rounded-[var(--radius-button)] [border:var(--bd-card)]">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col} className="text-xs font-medium whitespace-nowrap">
                {humanizeColumn(col)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, ri) => (
            <TableRow key={ri}>
              {columns.map((col) => (
                <TableCell key={col} className="align-top text-xs">
                  <CellValue value={row[col]} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Render a plain object of scalar values as a labeled key→value list. */
function KeyValueList({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  return (
    <dl className="grid gap-x-4 gap-y-2 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-muted/30 p-3 text-sm sm:grid-cols-[minmax(0,180px)_1fr]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-xs font-medium text-muted-foreground sm:py-0.5">{humanizeColumn(key)}</dt>
          <dd className="min-w-0 sm:py-0.5">
            {isScalar(value) || value == null ? (
              <CellValue value={value} />
            ) : (
              <JsonCode value={value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// Coerce a value that is meant to be structured JSON into a real object/array,
// parsing a JSON string when needed. Returns undefined when it isn't structured.
function asStructured(value: unknown): Record<string, unknown> | unknown[] | undefined {
  let v = value;
  if (typeof v === "string") {
    const t = v.trim();
    if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) {
      return undefined;
    }
    try {
      v = JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return v as Record<string, unknown>;
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Structured JSON viewer. Detects the shape and renders it as the operator
 * would want to read it, falling back to a JSON code block when the shape is
 * genuinely irregular:
 *   - array of objects  → table (the candidate-shortlist case)
 *   - array of scalars  → bullet list
 *   - object of scalars → key/value list
 *   - anything else     → formatted JSON
 */
function JsonView({ value }: { value: unknown }) {
  const structured = asStructured(value);
  if (structured === undefined) return <JsonCode value={value} />;

  if (Array.isArray(structured)) {
    if (structured.length === 0) return <JsonCode value={structured} />;
    if (structured.every((row) => isPlainObject(row))) {
      return <ObjectTable rows={structured as Array<Record<string, unknown>>} />;
    }
    if (structured.every((item) => isScalar(item))) {
      return (
        <ul className="list-disc space-y-1 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-muted/30 p-3 pl-7 text-sm">
          {structured.map((item, i) => (
            <li key={i} className="whitespace-pre-wrap break-words">{sanitizeOutputText(String(item))}</li>
          ))}
        </ul>
      );
    }
    return <JsonCode value={structured} />;
  }

  // Plain object: render scalars as KV; if any value is itself structured the
  // KV list nests a compact code block for that field only.
  return <KeyValueList obj={structured} />;
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
    const clean = sanitizeOutputText(String(value));
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
        <span className="font-mono text-xs">{sanitizeOutputText(String(value))}</span>
      </div>
    );
  }
  // Default: plain text.
  const clean = sanitizeOutputText(String(value));
  return (
    <div className={`bg-muted p-3 rounded-[var(--radius-button)] text-sm whitespace-pre-wrap font-mono leading-relaxed ${className ?? ""}`}>
      {clean}
    </div>
  );
}
