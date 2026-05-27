"use client";

import { useEffect, useRef, useState } from "react";
import { File, FilePlus, FolderOpen, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Editor from "react-simple-code-editor";
import "highlight.js/styles/github.css";
import type { WorkerFile } from "@/lib/types";

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

const _hlCache = new Map<string, string>();

function makeHighlighter(language: string) {
  return (code: string): string => {
    const key = `${language}:${code}`;
    if (_hlCache.has(key)) return _hlCache.get(key)!;
    const plain = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    <pre className="text-xs font-mono overflow-auto max-h-[600px] bg-[var(--bg-2)] dark:bg-[#1e1e2e] rounded-b-md whitespace-pre m-0">
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

  return (
    <div className="flex gap-4 items-start max-w-5xl">
      <div className="w-52 shrink-0">
        <Card className="border-border shadow-none bg-card">
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5" />
              Files
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 pb-1">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => onSelect?.(f.path)}
                className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate flex items-center gap-1.5 transition-colors ${
                  f.path === selectedPath
                    ? "bg-muted text-foreground font-semibold"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
                title={f.path}
              >
                <File className="w-3 h-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.path}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="flex-1 min-w-0">
        {selected ? (
          <Card className="border-border shadow-none bg-card">
            <CardHeader className="py-2 px-4 border-b border-border">
              <CardTitle className="text-xs font-medium font-mono text-muted-foreground">{selected.path}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {selected.binary ? (
                <div className="p-4 text-sm text-muted-foreground">Binary file -- cannot display.</div>
              ) : selected.language === "markdown" ? (
                <div className="prose prose-sm max-w-none text-foreground bg-muted/30 p-4 rounded-b-md overflow-auto max-h-[600px]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content || ""}</ReactMarkdown>
                </div>
              ) : (
                <SyntaxHighlightedCode content={selected.content || ""} language={selected.language} />
              )}
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">Select a file to view.</p>
        )}
      </div>
    </div>
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
}: FilesEditorEditProps) {
  const [addingFile, setAddingFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");

  const effectiveSelected = selectedPath ?? files[0]?.path ?? "worker.yml";
  const selectedFile = files.find((f) => f.path === effectiveSelected) || null;

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
      <Card className="border-border shadow-none bg-card">
        <CardHeader className="py-2 px-3 flex flex-row items-center justify-between">
          <CardTitle className="text-xs font-medium text-muted-foreground">Files</CardTitle>
          <button
            type="button"
            onClick={() => setAddingFile((v) => !v)}
            className="text-muted-foreground hover:text-black transition-colors"
            title="Add file"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
        </CardHeader>
        <CardContent className="p-0 pb-1">
          {addingFile && (
            <div className="px-3 py-2 flex gap-1.5 border-b border-[#f4f4f5]">
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
          {files.map((f) => (
            <div
              key={f.path}
              className={`group flex items-center gap-1.5 px-3 py-1.5 cursor-pointer transition-colors ${
                f.path === effectiveSelected
                  ? "bg-muted text-black"
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
        </CardContent>
      </Card>

      <Card className="border-border shadow-none bg-card">
        <CardHeader className="py-2 px-4 border-b border-border">
          <CardTitle className="text-xs font-medium font-mono text-muted-foreground">
            {selectedFile ? selectedFile.path : "Select a file"}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {selectedFile ? (
            <div className="rounded-b-md overflow-hidden" style={{ minHeight: 640 }}>
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
                  fontSize: 12,
                  minHeight: 640,
                  background: "#fff",
                  outline: "none",
                  lineHeight: "1.6",
                }}
                textareaClassName="focus:outline-none"
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground p-3">Select a file to edit.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
