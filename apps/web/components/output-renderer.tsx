"use client";

import Papa from "papaparse";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OutputField } from "@/lib/types";

function parseCSV(text: string): string[][] {
  const result = Papa.parse<string[]>(text.trim(), {
    skipEmptyLines: true,
  });
  return result.data as string[][];
}

function OutputCSV({ value }: { value: string }) {
  const rows = parseCSV(String(value));
  if (rows.length === 0) return <p className="text-sm text-[#999]">Empty CSV</p>;
  const [header, ...body] = rows;
  return (
    <div className="overflow-auto max-h-[400px] rounded border border-[#eaeaea]">
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
  );
}

function OutputJSON({ value }: { value: any }) {
  let formatted: string;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    formatted = JSON.stringify(parsed, null, 2);
  } catch {
    formatted = String(value);
  }
  return (
    <pre className="text-xs bg-[#f4f4f5] p-3 rounded-md overflow-auto font-mono leading-relaxed whitespace-pre-wrap">
      {formatted}
    </pre>
  );
}

const markdownComponents = {
  h1: ({ children }: any) => <h1 className="text-xl font-semibold mt-4 mb-2">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-lg font-semibold mt-3 mb-2">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-base font-semibold mt-2 mb-1">{children}</h3>,
  p: ({ children }: any) => <p className="text-sm mb-3 leading-relaxed">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>,
  li: ({ children }: any) => <li className="text-sm">{children}</li>,
  code: ({ inline, children }: any) =>
    inline ? (
      <code className="bg-[#f4f4f5] px-1 py-0.5 rounded text-xs font-mono">{children}</code>
    ) : (
      <pre className="bg-[#f4f4f5] p-3 rounded-md overflow-auto text-xs font-mono mb-3 whitespace-pre-wrap">
        <code>{children}</code>
      </pre>
    ),
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-[#d4d4d8] pl-3 text-[#666] my-3">{children}</blockquote>
  ),
  strong: ({ children }: any) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }: any) => (
    <a href={href} className="text-blue-600 underline" target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

export function OutputRenderer({ field }: {
  field: OutputField;
}) {
  const { type, value, label, name } = field;

  if (value == null || value === "") {
    return (
      <div>
        <p className="text-xs font-medium text-[#666] uppercase tracking-wide mb-1">{label || name}</p>
        <p className="text-sm text-[#999]">No output.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium text-[#666] uppercase tracking-wide mb-2">{label || name}</p>
      {type === "markdown" ? (
        <div className="prose prose-sm max-w-none text-[#333] bg-[#fafafa] p-4 rounded-md border border-[#eaeaea]">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents as any}>
            {String(value)}
          </ReactMarkdown>
        </div>
      ) : type === "json" ? (
        <OutputJSON value={value} />
      ) : type === "csv" ? (
        <OutputCSV value={String(value)} />
      ) : type === "file" ? (
        <div className="bg-[#f4f4f5] p-3 rounded-md text-sm text-[#666]">
          <span className="font-mono text-xs">{String(value)}</span>
        </div>
      ) : (
        <div className="bg-[#f4f4f5] p-3 rounded-md text-sm whitespace-pre-wrap font-mono leading-relaxed">
          {String(value)}
        </div>
      )}
    </div>
  );
}
