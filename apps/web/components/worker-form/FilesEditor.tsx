"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Code2, AlignLeft, Download, ExternalLink, File, FilePlus, FolderOpen, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Editor from "react-simple-code-editor";
import { load as parseYaml } from "js-yaml";
import "highlight.js/styles/github.css";
import type { WorkerFile } from "@/lib/types";
import { humanizeCron } from "@/lib/humanize-cron";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock } from "@/components/file-viewer/code-block";
import { sanitizeHref } from "@/lib/safe-url";

// ---------------------------------------------------------------------------
// Language detection helpers
// ---------------------------------------------------------------------------

function detectLanguage(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md") || path.endsWith(".txt")) return "markdown";
  if (path.endsWith(".html") || path.endsWith(".htm")) return "html";
  if (path.endsWith(".csv") || path.endsWith(".tsv")) return "csv";
  if (path.endsWith(".sh")) return "bash";
  return "plaintext";
}

function sourceFileKind(path: string, language?: string) {
  const lower = path.toLowerCase();
  const detected = language || detectLanguage(lower);
  if (lower === "worker.yml" || lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (detected === "markdown" || lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (detected === "html" || lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (detected === "csv" || lower.endsWith(".csv") || lower.endsWith(".tsv")) return "table";
  if (lower.endsWith(".xlsx")) return "spreadsheet";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return "image";
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(lower)) return "video";
  return "code";
}

// A file has a *genuine* rendered-vs-source distinction worth a second tab.
// Preview semantics per kind:
//   - markdown -> formatted prose document
//   - html     -> sandboxed iframe
//   - table    -> parsed grid
//   - code     -> plain wrapped text (Preview) vs syntax-highlighted (Raw)
// Generic .yaml/.yml get a single view — their "Preview" would be identical
// to the syntax-highlighted source (the confusing dual-tab the operator flagged).
// worker.yml is special-cased separately (structured summary), handled by
// `hasWorkerYamlSummary`.
function supportsRenderedPreview(path: string, binary?: boolean): boolean {
  if (binary) return false;
  return ["markdown", "html", "table", "code"].includes(sourceFileKind(path));
}

// worker.yml gets a structured "Summary" rendering distinct from its raw YAML
// source — the one YAML file with a real rendered view.
function hasWorkerYamlSummary(path: string, binary?: boolean): boolean {
  return !binary && path === "worker.yml";
}

function sourceFileDownloadName(path: string): string {
  return path.split("/").filter(Boolean).pop() || "worker-source-file";
}

function openSourceContent(path: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function downloadSourceContent(path: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = sourceFileDownloadName(path);
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// ---------------------------------------------------------------------------
// Lazy syntax highlight (edit mode)
// ---------------------------------------------------------------------------

async function highlightCode(code: string, language: string): Promise<string> {
  try {
    const hljsCore = await import("highlight.js/lib/core");
    const hljs = hljsCore.default;
    if (language === "python") {
      const py = await import("highlight.js/lib/languages/python");
      if (!hljs.getLanguage("python")) hljs.registerLanguage("python", py.default);
    } else if (language === "yaml") {
      const yaml = await import("highlight.js/lib/languages/yaml");
      if (!hljs.getLanguage("yaml")) hljs.registerLanguage("yaml", yaml.default);
    } else if (language === "json") {
      const json = await import("highlight.js/lib/languages/json");
      if (!hljs.getLanguage("json")) hljs.registerLanguage("json", json.default);
    } else if (language === "bash") {
      const bash = await import("highlight.js/lib/languages/bash");
      if (!hljs.getLanguage("bash")) hljs.registerLanguage("bash", bash.default);
    }
    if (hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  } catch {
    return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

// ---------------------------------------------------------------------------
// Synchronous YAML syntax highlighter
// (react-simple-code-editor calls highlight() on every keystroke — async
//  approaches silently break because they can't trigger a re-render)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function span(color: string, s: string, extra = ""): string {
  return `<span style="color:${color}${extra}">${s}</span>`;
}

// Colors chosen to be legible on both the light (var(--bg-2)) and dark
// (#1a1a1a) editor backgrounds used by FilesEditor.
const YC = {
  key:     "hsl(210 80% 55%)",   // blue: keys
  colon:   "hsl(220 10% 55%)",   // muted: colon separator
  string:  "hsl(142 55% 42%)",   // green: quoted strings
  number:  "hsl(200 70% 48%)",   // cyan-blue: numbers
  bool:    "hsl(270 55% 62%)",   // purple: true/false/null
  comment: "hsl(220 10% 58%)",   // grey: comments
  dash:    "hsl(220 10% 55%)",   // muted: list dash
  anchor:  "hsl(340 60% 58%)",   // pink: YAML anchors and tags
};

function colorYamlValue(raw: string): string {
  const t = raw.trim();
  if (!t) return esc(raw);
  if (/^["']/.test(t))                            return span(YC.string, esc(raw));
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t))  return span(YC.number, esc(raw));
  if (/^(true|false|yes|no|null|~)$/i.test(t))    return span(YC.bool,   esc(raw));
  if (/^[&*!]/.test(t))                           return span(YC.anchor, esc(raw));
  return esc(raw);
}

function highlightYaml(code: string): string {
  return code.split("\n").map((line) => {
    // Comment lines
    if (/^\s*#/.test(line)) {
      return span(YC.comment, esc(line), ";font-style:italic");
    }

    // key: value  (optionally preceded by "- " for inline list)
    const kv = line.match(/^(\s*(?:-\s+)?)([\w._-]+)(\s*:\s*)(.*)?$/);
    if (kv) {
      const [, indent, key, sep, value = ""] = kv;
      return (
        esc(indent) +
        span(YC.key, esc(key)) +
        span(YC.colon, esc(sep)) +
        colorYamlValue(value)
      );
    }

    // bare list item  "- value"
    const li = line.match(/^(\s*-\s+)(.*)?$/);
    if (li) {
      return span(YC.dash, esc(li[1])) + colorYamlValue(li[2] ?? "");
    }

    return esc(line);
  }).join("\n");
}

// For non-YAML files keep the async hljs approach (caches on second render,
// acceptable for rarely-edited Python/shell helper files).
const _hlCache = new Map<string, string>();

// Hook variant for the editable <Editor>. react-simple-code-editor calls
// `highlight(value)` on every keystroke and expects a synchronous return; the
// async hljs path returns escaped plain text on first paint
// and never re-renders when the real highlight resolves, so .py files showed
// no colour and (combined with the now-fixed white-space bug) looked broken.
// This hook resolves the async highlight ONCE per (language, code) and forces a
// re-render via state when it lands. YAML stays fully synchronous.
function useEditorHighlighter(code: string, language: string) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (language === "yaml") return;
    const key = `${language}:${code}`;
    if (_hlCache.has(key)) return;
    let alive = true;
    void highlightCode(code, language).then((html) => {
      _hlCache.set(key, html);
      if (alive) setTick((t) => t + 1);
    });
    return () => {
      alive = false;
    };
  }, [code, language]);

  if (language === "yaml") return highlightYaml;
  return (value: string): string => {
    const key = `${language}:${value}`;
    return _hlCache.get(key) ?? esc(value);
  };
}

// Editable code pane for the worker Source dialog. Extracted into its own
// component so `useEditorHighlighter` runs unconditionally (rules-of-hooks).
// The `.fe-codeeditor` class forces white-space:pre + horizontal scroll on the
// library's inner <pre>/<textarea> (which it styles inline as pre-wrap), fixing
// the one-character-per-line collapse inside the narrow dialog column.
function CodeEditorPane({
  path,
  content,
  language,
  onChange,
}: {
  path: string;
  content: string;
  language: string;
  onChange: (code: string) => void;
}) {
  const highlight = useEditorHighlighter(content, language);
  return (
    <Editor
      className="fe-codeeditor"
      value={content}
      onValueChange={onChange}
      highlight={highlight}
      padding={12}
      tabSize={2}
      insertSpaces
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        minHeight: 640,
        background: "transparent",
        color: "var(--foreground)",
        outline: "none",
        lineHeight: "1.75",
      }}
      preClassName="fe-codeeditor-pre"
      textareaClassName="focus:outline-none fe-codeeditor-textarea"
      data-file-path={path}
    />
  );
}

// ---------------------------------------------------------------------------
// View-mode syntax highlight (read-only)
// ---------------------------------------------------------------------------

// View-mode read-only code. Delegates to the canonical shared CodeBlock so the
// rounded surface, highlight palette, and dark/light backgrounds match the
// Brain file viewer exactly. `path` lets CodeBlock fall back to path-based
// language detection; `language` (hljs id) overrides it when the backend
// supplies one.
function SyntaxHighlightedCode({
  content,
  language,
  path = "file.txt",
}: {
  content: string;
  language?: string;
  path?: string;
}) {
  return (
    <div className="max-h-[600px] overflow-auto">
      <CodeBlock text={content} filePath={path} language={language} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilesEditor — view mode (read-only, for detail page Code tab)
// ---------------------------------------------------------------------------

interface FilesEditorViewProps {
  mode: "view";
  files: WorkerFile[];
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
}

interface FilesEditorEditEntry {
  path: string;
  content: string;
  binary?: boolean;
  language?: string;
  size?: number;
}

interface FilesEditorEditProps {
  mode: "edit";
  files: FilesEditorEditEntry[];
  selectedPath?: string;
  onSelect?: (path: string) => void;
  onChange: (updated: FilesEditorEditEntry[]) => void;
  onSelectedPathChange?: (path: string) => void;
  /** Rendered in the right pane when worker.yml is selected and preview mode is active */
  renderYamlPreview?: ReactNode;
}

type FilesEditorProps = FilesEditorViewProps | FilesEditorEditProps;
type SourceMode = "raw" | "preview" | "form";

export function FilesEditor(props: FilesEditorProps) {
  if (props.mode === "view") {
    return <FilesEditorView {...props} />;
  }
  return <FilesEditorEdit {...props} />;
}

function defaultSourceMode(path: string, _hasForm: boolean, binary?: boolean): SourceMode {
  if (binary) return "raw";
  if (hasWorkerYamlSummary(path, binary)) return "preview";
  if (supportsRenderedPreview(path)) return "preview";
  return "raw";
}

function sourceModeLabel(mode: SourceMode): string {
  if (mode === "raw") return "Raw";
  if (mode === "form") return "Form";
  // All rendered views use "Preview" — consistent with Brain file viewer.
  return "Preview";
}

function sourceModeIcon(mode: SourceMode) {
  if (mode === "raw") return <Code2 className="w-3 h-3" />;
  return <AlignLeft className="w-3 h-3" />;
}

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

function FilesEditorView({ files, selectedPath, onSelect }: FilesEditorViewProps) {
  const selected = files.find((f) => f.path === selectedPath) || null;

  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">No files found for this worker.</p>;
  }

  // S29t (score walk): file rail was w-52 (208px) wrapping path names; right
  // pane wrapped in a Card with a duplicated path header. Now: wider rail
  // (256px), no Card wrapper, path shown once as a quiet header above content.
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:gap-6 lg:items-start max-w-5xl">
      {/* FIX 2 (the operator 2026-05-29): the file rail must stay visible while a
          long file (e.g. a big run.py) scrolls. Sticky to the viewport with a
          top offset that clears the sticky mobile header (h-14 ≈ 56px); on
          desktop there is no top header over <main>, so it simply pins 72px
          from the top while the document scrolls. self-start lets the sticky
          element detach from the flex stretch.
          Mobile (< lg): full-width rail, no sticky (stacks above the code pane). */}
      <div className="w-full lg:w-64 shrink-0 lg:self-start lg:sticky lg:top-[4.5rem] [border:var(--bd-card)] rounded-[var(--radius-card)] overflow-hidden">
        <div className="px-3 py-2 [border-bottom:var(--bd-div)]">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" />
            Files
          </p>
        </div>
        <div className="p-1.5 space-y-0.5">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onSelect?.(f.path)}
              className={`w-full text-left px-2.5 py-1.5 text-xs font-mono truncate flex items-center gap-1.5 transition-colors rounded-[var(--radius-button)] ${
                f.path === selectedPath
                  ? "bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              title={f.path}
            >
              <File className="w-3 h-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{f.path}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        {selected ? (
          <div className="[border:var(--bd-card)] rounded-[var(--radius-card)] overflow-hidden">
            <div className="py-2 px-4 [border-bottom:var(--bd-div)]">
              <p className="text-xs font-mono text-muted-foreground">{selected.path}</p>
            </div>
            <ReadOnlyFileContent file={selected} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Select a file to view.</p>
        )}
      </div>
    </div>
  );
}

function ReadOnlyFileContent({ file }: { file: WorkerFile }) {
  if (file.binary) {
    return (
      <UnsupportedSourcePreview
        title="Binary source file"
        detail="This worker source listing does not include inline bytes for binary files, so this file cannot be rendered here."
        path={file.path}
      />
    );
  }

  const content = file.content || "";
  const lang = file.language || detectLanguage(file.path);

  // worker.yml and other rendered kinds (markdown / html / table): Preview + Raw.
  // All source files with a rendered view use the same two-tab pattern — "Summary"
  // was removed (the operator: "same as brain, fully aligned, consistent").
  if (hasWorkerYamlSummary(file.path, file.binary) || supportsRenderedPreview(file.path, file.binary)) {
    return (
      <Tabs defaultValue="preview" className="bg-muted/20">
        <div className="flex items-center justify-end gap-3 [border-bottom:var(--bd-div)] px-4 py-2">
          <TabsList>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="raw">Raw</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="preview" className="m-0">
          <RenderedFilePreview path={file.path} content={content} language={lang} />
        </TabsContent>
        <TabsContent value="raw" className="m-0">
          <SourcePreviewToolbar path={file.path} content={content} label="Raw" />
          <SyntaxHighlightedCode content={content} path={file.path} language={lang} />
        </TabsContent>
      </Tabs>
    );
  }

  // Remaining cases: .yaml/.yml (not worker.yml) — single syntax-highlighted view.
  return (
    <div>
      <SourcePreviewToolbar path={file.path} content={content} label="Source" />
      <SyntaxHighlightedCode content={content} path={file.path} language={lang} />
    </div>
  );
}

function SourcePreviewToolbar({
  path,
  content,
  label,
}: {
  path: string;
  content: string;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 [border-bottom:var(--bd-div)] bg-card px-4 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-card)] px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => openSourceContent(path, content)}
        >
          <ExternalLink className="size-3.5" />
          Open
        </button>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-card)] px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => downloadSourceContent(path, content)}
        >
          <Download className="size-3.5" />
          Download
        </button>
      </div>
    </div>
  );
}

function UnsupportedSourcePreview({
  title,
  detail,
  path,
}: {
  title: string;
  detail: string;
  path: string;
}) {
  return (
    <div className="flex min-h-[280px] items-center justify-center bg-muted/20 p-6">
      <div className="max-w-lg rounded-[var(--radius-card)] [border:var(--bd-card)] bg-card p-5 text-sm">
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-2 leading-6 text-muted-foreground">{detail}</p>
        <p className="mt-3 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
          {path}
        </p>
      </div>
    </div>
  );
}

function RenderedFilePreview({
  path,
  content,
  language,
}: {
  path: string;
  content: string;
  language: string;
}) {
  const detected = language || detectLanguage(path);

  if (path === "worker.yml") {
    return (
      <div className="max-h-[640px] overflow-auto bg-muted/20 p-4">
        <WorkerYamlPreviewContent content={content} />
      </div>
    );
  }

  if (detected === "markdown") {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none text-foreground bg-muted/30 p-4 overflow-auto max-h-[640px] prose-pre:bg-muted prose-pre:text-foreground prose-code:text-foreground">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // #1043 — neutralize dangerous protocols (javascript:/data:/vbscript:)
            // via the shared safe-url allowlist, same pattern as MarkdownText.
            a: ({ href, children }) => {
              const safe = sanitizeHref(href);
              return (
                <a href={safe} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  if (sourceFileKind(path, detected) === "html") {
    return (
      <iframe
        title={path}
        srcDoc={content}
        sandbox=""
        referrerPolicy="no-referrer"
        className="h-[640px] w-full [border:0] bg-white"
      />
    );
  }

  if (sourceFileKind(path, detected) === "table") {
    return <SourceDelimitedTablePreview content={content} path={path} />;
  }

  if (["spreadsheet", "pdf", "image", "video"].includes(sourceFileKind(path, detected))) {
    return (
      <UnsupportedSourcePreview
        title={`${sourceFileKind(path, detected)} preview unavailable`}
        detail="This worker source payload only includes text content for source files. This renderer needs file bytes or a backend download URL, which is not present in WorkerFile."
        path={path}
      />
    );
  }

  // "code" kind (run.py, .sh, .json, etc.): Preview = comfortable plain-text
  // reading view matching Brain's PlainTextPreview (max-w-3xl column, no
  // syntax colour). Raw tab = syntax-highlighted source.
  if (sourceFileKind(path, detected) === "code") {
    if (!content.trim()) {
      return (
        <div className="p-6">
          <p className="text-sm text-muted-foreground italic">This file is empty.</p>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-3xl px-6 py-6">
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-foreground">
          {content}
        </pre>
      </div>
    );
  }

  return <SyntaxHighlightedCode content={content} path={path} language={detected} />;
}

function SourceDelimitedTablePreview({ content, path }: { content: string; path: string }) {
  const rows = content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(0, 100)
    .map((line) => line.split(path.toLowerCase().endsWith(".tsv") ? "\t" : ",").slice(0, 12));

  if (rows.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No rows found.</p>;
  }

  return (
    <div className="max-h-[640px] overflow-auto bg-card">
      <table className="min-w-full border-collapse text-left text-xs">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? "bg-muted/60 font-medium" : "odd:bg-muted/20"}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="max-w-[240px] [border:var(--bd-card)] px-2.5 py-1.5 align-top">
                  <span className="block truncate" title={cell}>{cell}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkerYamlPreviewContent({ content }: { content: string }) {
  const parsed = parseWorkerYaml(content);
  if (!parsed) {
    return <SyntaxHighlightedCode content={content} path="worker.yml" language="yaml" />;
  }

  const entries = [
    ["ID", parsed.name],
    ["Title", parsed.title],
    ["Trigger", triggerLabel(parsed.trigger)],
    ["Runtime", runtimeLabel(parsed.exec ?? parsed.runtime)],
    ["Inputs", countLabel(parsed.inputs, "input")],
    ["Connections", countLabel(parsed.connections, "connection")],
    ["Brain resources", countLabel(parsed.contexts, "brain resource")],
    ["Secrets", countLabel(parsed.secrets, "secret")],
  ].filter(([, value]) => value);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">{parsed.title || parsed.name || "Untitled worker"}</h3>
        {parsed.description ? (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{parsed.description}</p>
        ) : null}
      </div>
      <dl className="grid gap-px overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)] bg-line text-sm sm:grid-cols-2">
        {entries.map(([label, value]) => (
          <div key={label} className="bg-card px-3 py-2">
            <dt className="text-[11px] font-medium uppercase text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 truncate text-foreground" title={String(value)}>{value}</dd>
          </div>
        ))}
      </dl>
      <YamlList title="Inputs" items={parsed.inputs} getLabel={(item) => itemLabel(item)} />
      <YamlList title="Connections" items={parsed.connections} getLabel={(item) => itemLabel(item)} />
      <YamlList title="Brain resources" items={parsed.contexts} getLabel={(item) => contextItemLabel(item)} />
    </div>
  );
}

type WorkerYaml = Record<string, unknown> & {
  name?: string;
  title?: string;
  description?: string;
  trigger?: unknown;
  exec?: unknown;
  runtime?: unknown;
  inputs?: unknown[];
  connections?: unknown[];
  contexts?: unknown[];
  secrets?: unknown[];
};

function parseWorkerYaml(content: string): WorkerYaml | null {
  try {
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as WorkerYaml;
  } catch {
    return null;
  }
}

function countLabel(value: unknown, singular: string) {
  const count = Array.isArray(value) ? value.length : 0;
  if (count === 0) return "";
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function triggerLabel(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const type = String((value as Record<string, unknown>).type || "manual");
  const cron = (value as Record<string, unknown>).cron;
  const tz = (value as Record<string, unknown>).timezone;
  return cron
    ? `${type} · ${humanizeCron(String(cron), typeof tz === "string" ? tz : "UTC")}`
    : type;
}

function runtimeLabel(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  const raw = value as Record<string, unknown>;
  return [raw.runtime || raw.type, raw.command || raw.entry].filter(Boolean).join(" · ");
}

function itemLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const raw = value as Record<string, unknown>;
  if (raw.name) return String(raw.name);
  if (raw.label) return String(raw.label);
  if (raw.type) return String(raw.type);
  if (raw.mcp && typeof raw.mcp === "object") {
    return String((raw.mcp as Record<string, unknown>).label || "MCP server");
  }
  return JSON.stringify(raw);
}

function contextItemLabel(value: unknown) {
  if (typeof value === "string") return `${value} · Read-only`;
  if (!value || typeof value !== "object") return "";
  const raw = value as Record<string, unknown>;
  const name = raw.name || raw.label || "Unnamed resource";
  const access = raw.writeable === true ? "Read/write" : "Read-only";
  return `${String(name)} · ${access}`;
}

function YamlList({
  title,
  items,
  getLabel,
}: {
  title: string;
  items?: unknown[];
  getLabel: (item: unknown) => string;
}) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium uppercase text-muted-foreground">{title}</h4>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, index) => (
          <span
            key={`${title}-${index}`}
            className="rounded-[var(--radius-button)] [border:var(--bd-card)] bg-card px-2 py-1 text-xs text-foreground"
            title={getLabel(item)}
          >
            {getLabel(item)}
          </span>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function FilesEditorEdit({
  files,
  selectedPath,
  onSelect,
  onChange,
  onSelectedPathChange,
  renderYamlPreview,
}: FilesEditorEditProps) {
  const [addingFile, setAddingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");

  const effectiveSelected = selectedPath ?? files[0]?.path ?? "worker.yml";
  const selectedFile = files.find((f) => f.path === effectiveSelected) || null;
  const selectedHasForm = Boolean(selectedFile && selectedFile.path === "worker.yml" && renderYamlPreview);
  const selectedIsWorkerYaml = Boolean(selectedFile && hasWorkerYamlSummary(selectedFile.path, selectedFile.binary));
  // A second rendered tab is only meaningful for files with a real
  // rendered-vs-source distinction (markdown/html/table) or worker.yml's
  // structured summary. Generic .yaml/.json/.py show a single raw editor.
  const selectedHasPreview = Boolean(
    selectedFile && (supportsRenderedPreview(selectedFile.path, selectedFile.binary) || selectedIsWorkerYaml)
  );

  const [sourceMode, setSourceMode] = useState<SourceMode>(() =>
    defaultSourceMode(effectiveSelected, Boolean(renderYamlPreview))
  );
  useEffect(() => {
    setSourceMode(defaultSourceMode(effectiveSelected, selectedHasForm));
  }, [effectiveSelected, selectedHasForm]);

  function setContent(path: string, content: string) {
    onChange(files.map((f) => (f.path === path ? { ...f, content } : f)));
  }

  function selectPath(path: string) {
    onSelect?.(path);
    onSelectedPathChange?.(path);
  }

  function addFile() {
    const trimmed = newFilePath.trim();
    if (!trimmed) return;
    if (files.some((f) => f.path === trimmed)) {
      toast.error(`File "${trimmed}" already exists`);
      return;
    }
    const updated = [...files, { path: trimmed, content: "" }];
    onChange(updated);
    selectPath(trimmed);
    setNewFilePath("");
    setAddingFile(false);
  }

  function deleteFile(path: string) {
    if (path === "worker.yml") { toast.error("Cannot delete worker.yml"); return; }
    if (!confirm(`Delete "${path}"?`)) return;
    const updated = files.filter((f) => f.path !== path);
    onChange(updated);
    if (effectiveSelected === path) selectPath("worker.yml");
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 items-start">
      <Card size="sm" className="[border:var(--bd-card)] shadow-none bg-card self-start lg:sticky lg:top-3">
        <CardHeader className="px-3 py-2 flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <FolderOpen className="w-3.5 h-3.5" />
            Files
          </CardTitle>
          <button
            type="button"
            onClick={() => setAddingFile((v) => !v)}
            className="-m-1.5 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground sm:-m-1 sm:h-7 sm:w-7"
            title="Add file"
            aria-label="Add file"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
        </CardHeader>
        <CardContent className="p-0 pb-1">
          {addingFile && (
            <div className="px-3 py-2 flex gap-1.5 [border-bottom:var(--bd-div)]">
              <Input
                className="h-6 text-xs font-mono [border:var(--bd-card)] py-0"
                placeholder="lib/helpers.py"
                value={newFilePath}
                onChange={(e) => setNewFilePath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addFile();
                  if (e.key === "Escape") { setAddingFile(false); setNewFilePath(""); }
                }}
                autoFocus
              />
              <Button size="sm" className="h-6 px-2 text-xs" onClick={addFile}>Add</Button>
            </div>
          )}
          <div className="px-1.5 pb-1.5 space-y-0.5">
          {files.map((f) => (
            <div
              key={f.path}
              className={`group flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer transition-colors rounded-[var(--radius-button)] ${
                f.path === effectiveSelected
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              onClick={() => selectPath(f.path)}
            >
              <File className="w-3 h-3 shrink-0 text-muted-foreground" />
              <span className="text-xs font-mono truncate flex-1" title={f.path}>{f.path}</span>
              {/* Touch devices can't hover, so the delete affordance must be
                  visible by default on mobile (opacity-100) and only fade-to-
                  reveal on pointer-hover screens (sm:opacity-0). Tap target is
                  ≥36px on mobile, tightened back to the icon size on desktop. */}
              {f.path !== "worker.yml" && !f.binary && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deleteFile(f.path); }}
                  className="-my-1.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] text-muted-foreground opacity-100 transition-all hover:text-red-500 sm:-my-1 sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100"
                  title={`Delete ${f.path}`}
                  aria-label={`Delete ${f.path}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          </div>
        </CardContent>
      </Card>

      <Card className="[border:var(--bd-card)] shadow-none bg-card">
        <CardHeader className="py-2 px-4 [border-bottom:var(--bd-div)]">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-xs font-medium font-mono text-muted-foreground">
              {selectedFile ? selectedFile.path : "Select a file"}
            </CardTitle>
            {selectedFile && selectedHasPreview && (
              <div className="flex items-center gap-0 rounded-md [border:var(--bd-card)] overflow-hidden shrink-0">
                {(["raw", "preview"] as SourceMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setSourceMode(mode)}
                    className={`flex items-center gap-1 px-2 py-1 text-[11px] transition-colors ${
                      sourceMode === mode
                        ? "bg-muted text-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    {sourceModeIcon(mode)}
                    {sourceModeLabel(mode)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {selectedFile ? (
            sourceMode === "form" && selectedFile.path === "worker.yml" && renderYamlPreview ? (
              <div className="p-4">{renderYamlPreview}</div>
            ) : sourceMode === "preview" ? (
              selectedFile.binary ? (
                <UnsupportedSourcePreview
                  title="Binary source file"
                  detail="This worker source listing does not include inline bytes for binary files, so this file cannot be rendered or edited here."
                  path={selectedFile.path}
                />
              ) : supportsRenderedPreview(selectedFile.path) || hasWorkerYamlSummary(selectedFile.path, selectedFile.binary) ? (
                <RenderedFilePreview
                  path={selectedFile.path}
                  content={selectedFile.content}
                  language={selectedFile.language || detectLanguage(selectedFile.path)}
                />
              ) : (
                <UnsupportedSourcePreview
                  title="Rendered preview unavailable"
                  detail="This source file type does not have a renderer in the worker Source editor. Use Raw, Open, or Download."
                  path={selectedFile.path}
                />
              )
            ) : (
              <>
                {selectedFile.binary ? (
                  <UnsupportedSourcePreview
                    title="Binary source file"
                    detail="This worker source listing does not include inline bytes for binary files, so this file cannot be rendered or edited here."
                    path={selectedFile.path}
                  />
                ) : (
                  <>
                    <SourcePreviewToolbar path={selectedFile.path} content={selectedFile.content} label="Raw" />
                    <div
                      className="rounded-b-[var(--radius-card)] overflow-hidden bg-[var(--bg-2)] dark:bg-[#1a1a1a]"
                      style={{ minHeight: 640 }}
                    >
                      <CodeEditorPane
                        key={selectedFile.path}
                        path={selectedFile.path}
                        content={selectedFile.content}
                        language={selectedFile.language || detectLanguage(selectedFile.path)}
                        onChange={(code) => setContent(selectedFile.path, code)}
                      />
                    </div>
                  </>
                )}
              </>
            )
          ) : (
            <p className="text-sm text-muted-foreground p-3">Select a file to edit.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
