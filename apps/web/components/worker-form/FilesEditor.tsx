"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Code2, AlignLeft, File, FilePlus, FolderOpen, Trash2 } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Language detection helpers
// ---------------------------------------------------------------------------

function detectLanguage(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md") || path.endsWith(".txt")) return "markdown";
  if (path.endsWith(".sh")) return "bash";
  return "plaintext";
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
// (#1e1e2e) editor backgrounds used by FilesEditor.
const YC = {
  key:     "hsl(210 80% 55%)",   // blue — keys
  colon:   "hsl(220 10% 55%)",   // muted — : separator
  string:  "hsl(142 55% 42%)",   // green — quoted strings
  number:  "hsl(25  90% 55%)",   // orange — numbers
  bool:    "hsl(270 55% 62%)",   // purple — true/false/null
  comment: "hsl(220 10% 58%)",   // grey — comments
  dash:    "hsl(220 10% 55%)",   // muted — list dash
  anchor:  "hsl(340 60% 58%)",   // pink — YAML anchors & tags
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

function makeHighlighter(language: string) {
  if (language === "yaml") return highlightYaml;
  return (code: string): string => {
    const key = `${language}:${code}`;
    if (_hlCache.has(key)) return _hlCache.get(key)!;
    const plain = esc(code);
    void highlightCode(code, language).then((html) => { _hlCache.set(key, html); });
    return plain;
  };
}

// ---------------------------------------------------------------------------
// View-mode syntax highlight (read-only)
// ---------------------------------------------------------------------------

function SyntaxHighlightedCode({ content, language }: { content: string; language?: string }) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    import("highlight.js/lib/core").then(async (hljsCore) => {
      const hljs = hljsCore.default;
      if (language === "python") {
        const python = await import("highlight.js/lib/languages/python");
        hljs.registerLanguage("python", python.default);
      } else if (language === "yaml") {
        const yaml = await import("highlight.js/lib/languages/yaml");
        hljs.registerLanguage("yaml", yaml.default);
      } else if (language === "json") {
        const json = await import("highlight.js/lib/languages/json");
        hljs.registerLanguage("json", json.default);
      } else if (language === "bash" || language === "shell") {
        const bash = await import("highlight.js/lib/languages/bash");
        hljs.registerLanguage("bash", bash.default);
      }
      if (!cancelled && codeRef.current) hljs.highlightElement(codeRef.current);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [content, language]);

  return (
    <pre
      className="text-xs font-mono overflow-auto max-h-[600px] bg-[var(--bg-2)] dark:bg-[#1e1e2e] whitespace-pre m-0 rounded-b-[var(--radius-card)]"
    >
      <code
        ref={codeRef}
        className={language ? `language-${language}` : ""}
        style={{ background: "transparent", padding: "0.75rem", display: "block" }}
      >
        {content}
      </code>
    </pre>
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

export function FilesEditor(props: FilesEditorProps) {
  if (props.mode === "view") {
    return <FilesEditorView {...props} />;
  }
  return <FilesEditorEdit {...props} />;
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
      {/* FIX 2 (Federico 2026-05-29): the file rail must stay visible while a
          long file (e.g. a big run.py) scrolls. Sticky to the viewport with a
          top offset that clears the sticky mobile header (h-14 ≈ 56px); on
          desktop there is no top header over <main>, so it simply pins 72px
          from the top while the document scrolls. self-start lets the sticky
          element detach from the flex stretch.
          Mobile (< lg): full-width rail, no sticky (stacks above the code pane). */}
      <div className="w-full lg:w-64 shrink-0 lg:self-start lg:sticky lg:top-[4.5rem] border border-line rounded-[var(--radius-card)] overflow-hidden">
        <div className="px-3 py-2 border-b border-line">
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
          <div className="border border-line rounded-[var(--radius-card)] overflow-hidden">
            <div className="py-2 px-4 border-b border-line">
              <p className="text-xs font-mono text-muted-foreground">{selected.path}</p>
            </div>
            {selected.binary ? (
              <div className="p-4 text-sm text-muted-foreground">Binary file -- cannot display.</div>
            ) : selected.language === "markdown" ? (
              <div className="prose prose-sm max-w-none text-foreground bg-muted/30 p-4 overflow-auto max-h-[640px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content || ""}</ReactMarkdown>
              </div>
            ) : selected.language === "yaml" && selected.path.endsWith("worker.yml") ? (
              <WorkerYamlView content={selected.content || ""} />
            ) : (
              <SyntaxHighlightedCode content={selected.content || ""} language={selected.language} />
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Select a file to view.</p>
        )}
      </div>
    </div>
  );
}

function WorkerYamlView({ content }: { content: string }) {
  const parsed = parseWorkerYaml(content);
  if (!parsed) {
    return <SyntaxHighlightedCode content={content} language="yaml" />;
  }

  const entries = [
    ["ID", parsed.name],
    ["Title", parsed.title],
    ["Trigger", triggerLabel(parsed.trigger)],
    ["Runtime", runtimeLabel(parsed.exec ?? parsed.runtime)],
    ["Inputs", countLabel(parsed.inputs, "input")],
    ["Connections", countLabel(parsed.connections, "connection")],
    ["Brain packs", countLabel(parsed.contexts, "brain pack")],
    ["Secrets", countLabel(parsed.secrets, "secret")],
  ].filter(([, value]) => value);

  return (
    <Tabs defaultValue="preview" className="bg-muted/20">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div>
          <p className="text-xs font-medium text-foreground">Worker manifest</p>
          <p className="text-[11px] text-muted-foreground">Readable preview with raw YAML one tab away.</p>
        </div>
        <TabsList>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="preview" className="m-0 max-h-[640px] overflow-auto p-4">
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">{parsed.title || parsed.name || "Untitled worker"}</h3>
            {parsed.description ? (
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{parsed.description}</p>
            ) : null}
          </div>
          <dl className="grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line text-sm sm:grid-cols-2">
            {entries.map(([label, value]) => (
              <div key={label} className="bg-card px-3 py-2">
                <dt className="text-[11px] font-medium uppercase text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 truncate text-foreground" title={String(value)}>{value}</dd>
              </div>
            ))}
          </dl>
          <YamlList title="Inputs" items={parsed.inputs} getLabel={(item) => itemLabel(item)} />
          <YamlList title="Connections" items={parsed.connections} getLabel={(item) => itemLabel(item)} />
          <YamlList title="Brain packs" items={parsed.contexts} getLabel={(item) => itemLabel(item)} />
        </div>
      </TabsContent>
      <TabsContent value="raw" className="m-0">
        <SyntaxHighlightedCode content={content} language="yaml" />
      </TabsContent>
    </Tabs>
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
  return cron ? `${type} · ${cron}` : type;
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
            className="rounded-[var(--radius-button)] border border-line bg-card px-2 py-1 text-xs text-foreground"
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

  // Per-file preview toggle — default to preview for worker.yml and .md files
  const fileSupportsPreview = (path: string) =>
    path === "worker.yml" ? Boolean(renderYamlPreview) : detectLanguage(path) === "markdown";
  const [previewActive, setPreviewActive] = useState(() => fileSupportsPreview(effectiveSelected));
  useEffect(() => {
    setPreviewActive(fileSupportsPreview(effectiveSelected));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSelected]);

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
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 items-start">
      {/* FIX 2 (Federico 2026-05-29): keep the file rail pinned while editing a
          long file. items-start on the grid lets this track sticky; top offset
          clears the sticky mobile header. */}
      <Card className="border-border shadow-none bg-card self-start sticky top-[4.5rem]">
        <CardHeader className="py-2 px-3 flex flex-row items-center justify-between">
          <CardTitle className="text-xs font-medium text-muted-foreground">Files</CardTitle>
          <button
            type="button"
            onClick={() => setAddingFile((v) => !v)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Add file"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
        </CardHeader>
        <CardContent className="p-0 pb-1">
          {addingFile && (
            <div className="px-3 py-2 flex gap-1.5 border-b border-line">
              <Input
                className="h-6 text-xs font-mono border-border py-0"
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
              {f.path !== "worker.yml" && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); deleteFile(f.path); }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all"
                  title={`Delete ${f.path}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border-border shadow-none bg-card">
        <CardHeader className="py-2 px-4 border-b border-border">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-xs font-medium font-mono text-muted-foreground">
              {selectedFile ? selectedFile.path : "Select a file"}
            </CardTitle>
            {selectedFile && fileSupportsPreview(selectedFile.path) && (
              <div className="flex items-center gap-0 rounded-md border border-border overflow-hidden shrink-0">
                <button
                  type="button"
                  onClick={() => setPreviewActive(false)}
                  className={`flex items-center gap-1 px-2 py-1 text-[11px] transition-colors ${
                    !previewActive
                      ? "bg-muted text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  <Code2 className="w-3 h-3" />
                  Code
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewActive(true)}
                  className={`flex items-center gap-1 px-2 py-1 text-[11px] transition-colors ${
                    previewActive
                      ? "bg-muted text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted/40"
                  }`}
                >
                  <AlignLeft className="w-3 h-3" />
                  {selectedFile.path === "worker.yml" ? "Form" : "Preview"}
                </button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {selectedFile ? (
            previewActive && selectedFile.path === "worker.yml" && renderYamlPreview ? (
              <div className="p-4">{renderYamlPreview}</div>
            ) : previewActive && detectLanguage(selectedFile.path) === "markdown" ? (
              <div className="prose prose-sm max-w-none text-foreground bg-muted/30 p-4 overflow-auto max-h-[640px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedFile.content || ""}</ReactMarkdown>
              </div>
            ) : (
              <div
                className="rounded-b-[var(--radius-card)] overflow-hidden bg-[var(--bg-2)] dark:bg-[#1e1e2e]"
                style={{ minHeight: 640 }}
              >
                <Editor
                  key={selectedFile.path}
                  value={selectedFile.content}
                  onValueChange={(code) => setContent(selectedFile.path, code)}
                  highlight={makeHighlighter(detectLanguage(selectedFile.path))}
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
                  textareaClassName="focus:outline-none"
                />
              </div>
            )
          ) : (
            <p className="text-sm text-muted-foreground p-3">Select a file to edit.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
