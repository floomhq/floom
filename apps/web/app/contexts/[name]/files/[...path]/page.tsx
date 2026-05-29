"use client";

import "highlight.js/styles/github.css";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft,
  Download,
  Edit3,
  File as FileIcon,
  FileCode,
  FileText,
  Image as ImageIcon,
  Save,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ContextDetail, ContextFileItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

const TEXT_PREVIEW_LIMIT = 256 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function isKnownTextFile(file: ContextFileItem): boolean {
  const mime = file.mime_type.toLowerCase();
  const path = file.path.toLowerCase();
  return (
    !file.is_binary &&
    (mime.startsWith("text/") ||
      ["application/javascript", "application/json", "application/toml", "application/typescript", "application/yaml", "application/x-yaml", "application/xml"].includes(mime) ||
      /\.(mdx?|txt|log|env|json|ya?ml|toml|csv|tsv|py|js|jsx|ts|tsx|css|scss|html?|xml|sql|sh|go|rs|rb|php|java|c|cpp|h|hpp|cs)$/.test(path))
  );
}

type FileKind = "markdown" | "code" | "image" | "pdf" | "binary";

function fileKind(file: ContextFileItem): FileKind {
  const mime = file.mime_type.toLowerCase();
  const path = file.path.toLowerCase();
  if (path.endsWith(".md") || path.endsWith(".mdx") || mime === "text/markdown") return "markdown";
  if (mime === "application/pdf" || path.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (isKnownTextFile(file)) return "code";
  return "binary";
}

function displayTypeIcon(displayType: string) {
  if (displayType === "Markdown") return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  if (["YAML", "Python", "JavaScript", "TypeScript", "JSON", "Shell", "SQL"].includes(displayType))
    return <FileCode className="size-4 shrink-0 text-muted-foreground" />;
  if (displayType === "Image") return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

export default function FilePreviewPage() {
  const { name, path: pathParts } = useParams<{ name: string; path: string[] }>();
  const router = useRouter();

  const packName = decodeURIComponent(name);
  const filePath = Array.isArray(pathParts) ? pathParts.map(decodeURIComponent).join("/") : decodeURIComponent(pathParts);

  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>(filePath);
  const [text, setText] = useState<string>("");
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [loadingText, setLoadingText] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  const selectedFile = detail?.files.find((f) => f.path === selectedPath) ?? null;
  const kind = selectedFile ? fileKind(selectedFile) : null;
  const fileUrl = selectedFile ? api.contexts.fileUrl(packName, selectedFile.path) : "";
  const isGitContext = false; // v1: hide history unless git-sourced

  const loadDetail = useCallback(async () => {
    const d = await api.contexts.get(packName);
    setDetail(d);
  }, [packName]);

  useEffect(() => {
    loadDetail()
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Failed to load pack"))
      .finally(() => setLoadingDetail(false));
  }, [loadDetail]);

  // Load file text whenever the selected file changes.
  //
  // P0-2 (2026-05-29): this effect previously depended on the `selectedFile`
  // OBJECT, which `detail?.files.find(...)` rebuilds with a NEW reference on
  // every render. On a direct URL load / refresh / shared "Copy link", `detail`
  // is null on the first paint so `selectedFile` is null and the effect
  // early-returned; once `detail` resolved, the unstable reference caused the
  // body to re-run repeatedly, with `setText("")` racing the resolved fetch and
  // blanking the pane. Keying on STABLE primitives (the resolved path + whether
  // it is a previewable text file) makes the effect fire exactly once per file
  // and load the URL-seeded file on first load.
  const loadableTextPath =
    selectedFile && isKnownTextFile(selectedFile) && selectedFile.size <= TEXT_PREVIEW_LIMIT
      ? selectedFile.path
      : null;

  useEffect(() => {
    setEditing(false);
    setText("");
    if (!loadableTextPath) return;
    let cancelled = false;
    setLoadingText(true);
    api.contexts.readTextFile(packName, loadableTextPath)
      .then((value) => { if (!cancelled) setText(value); })
      .catch((err: unknown) => { if (!cancelled) toast.error(err instanceof Error ? err.message : "Failed to load file"); })
      .finally(() => { if (!cancelled) setLoadingText(false); });
    return () => { cancelled = true; };
  }, [packName, loadableTextPath]);

  // Keep the URL in sync when selectedPath changes — IN PLACE.
  //
  // Federico Image (2026-05-29): clicking a file in the left rail used to call
  // router.replace(), which is a real App Router navigation to a new [...path]
  // segment value. Next remounts the page segment on that change, so
  // `loadingDetail` reset to true and the LEFT "Files" rail flashed its
  // skeleton on every file switch — even though the rail is identical between
  // files. The rail must stay put; only the RIGHT content pane should show a
  // brief load (driven by `loadingText`).
  //
  // Fix (root cause): use history.replaceState to update the address bar
  // without triggering a Next navigation/remount. `selectedPath` (client state)
  // already drives the content pane, and a direct URL load / refresh still
  // works because `useParams()` seeds `selectedPath` on mount.
  useEffect(() => {
    if (selectedPath !== filePath && typeof window !== "undefined") {
      const url = `/contexts/${encodeURIComponent(packName)}/files/${selectedPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      window.history.replaceState(window.history.state, "", url);
    }
  }, [selectedPath, filePath, packName]);

  async function saveFile() {
    if (!selectedFile) return;
    try {
      await api.contexts.saveTextFile(packName, selectedFile.path, editText);
      setText(editText);
      setEditing(false);
      await loadDetail();
      toast.success("File saved");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save file");
    }
  }

  return (
    <div className="flex flex-col gap-0" style={{ height: "calc(100vh - 80px)" }}>
      {/* Breadcrumb + actions bar */}
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border-default)] px-4 py-2.5 shrink-0 bg-[var(--bg-card)]">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <Link href="/contexts" className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
            Contexts
          </Link>
          <span className="text-muted-foreground">/</span>
          <Link href={`/contexts/${encodeURIComponent(packName)}`} className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
            {packName}
          </Link>
          {selectedPath && (() => {
            const parts = selectedPath.split("/");
            return parts.map((part, i) => {
              const isLast = i === parts.length - 1;
              const folderPath = parts.slice(0, i + 1).join("/");
              return (
                <span key={folderPath} className="flex items-center gap-2 min-w-0">
                  <span className="text-muted-foreground shrink-0">/</span>
                  {isLast ? (
                    <span className="font-mono text-xs truncate">{part}</span>
                  ) : (
                    <Link
                      href={`/contexts/${encodeURIComponent(packName)}?path=${encodeURIComponent(folderPath)}`}
                      className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    >
                      {part}
                    </Link>
                  )}
                </span>
              );
            });
          })()}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {selectedFile && isKnownTextFile(selectedFile) && !editing && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => { setEditText(text); setEditing(true); }}>
              <Edit3 className="size-3.5" />
              Edit
            </Button>
          )}
          {editing && (
            <>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setEditing(false)}>
                <X className="size-3.5" />
                Cancel
              </Button>
              <Button size="sm" className="h-7 text-xs gap-1" onClick={saveFile}>
                <Save className="size-3.5" />
                Save
              </Button>
            </>
          )}
          {selectedFile && (
            <a
              href={fileUrl}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border-default)] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title="Download"
            >
              <Download className="size-3.5" />
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            title="Close preview"
            onClick={() => router.push(`/contexts/${encodeURIComponent(packName)}`)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Main 25/75 split */}
      <div className="flex flex-1 min-h-0">
        {/* Left: file list */}
        {loadingDetail ? (
          <div className="w-[25%] min-w-[220px] max-w-[300px] border-r border-[var(--border-default)] p-3">
            <Skeleton className="h-4 w-32 mb-2" />
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full mb-1 rounded" />)}
          </div>
        ) : (
          <aside className="flex flex-col w-[25%] min-w-[220px] max-w-[300px] border-r border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
            <div className="px-3 py-2.5 border-b border-[var(--border-default)] shrink-0">
              <p className="text-xs font-medium text-muted-foreground">{packName}</p>
              <p className="text-xs text-muted-foreground">Files</p>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-[var(--border-default)]">
              {(detail?.files ?? []).map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                    file.path === selectedPath
                      ? "bg-[var(--active-nav-bg)] border-l-2 border-l-[var(--border-default)]"
                      : "hover:bg-muted/40"
                  }`}
                >
                  {displayTypeIcon(file.display_type ?? "File")}
                  <span className="text-xs font-mono truncate flex-1">{file.path}</span>
                </button>
              ))}
              {detail?.files.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">No files</p>
              )}
            </div>
          </aside>
        )}

        {/* Right: file viewer */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {!selectedFile ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Select a file to preview it.
            </div>
          ) : (
            <>
              {/* File header */}
              <div className="border-b border-[var(--border-default)] px-4 py-3 shrink-0">
                <div className="flex items-center gap-2">
                  {displayTypeIcon(selectedFile.display_type ?? "File")}
                  <span className="font-mono text-sm font-medium">{selectedFile.path.split("/").pop()}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {selectedFile.display_type ?? "File"} · {formatBytes(selectedFile.size)}
                  {selectedFile.updated_at && ` · Updated ${formatDate(selectedFile.updated_at)}`}
                </p>
              </div>

              {/* Content */}
              <div className="flex-1 overflow-auto">
                {loadingText ? (
                  <div className="p-4 space-y-2">
                    {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-4 w-full rounded" />)}
                  </div>
                ) : editing ? (
                  <Textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    className="w-full h-full min-h-[400px] resize-none border-0 rounded-none font-mono text-xs leading-6 outline-none focus-visible:ring-0 focus-visible:ring-offset-0 p-4"
                  />
                ) : (
                  <FileContent
                    file={selectedFile}
                    kind={kind}
                    text={text}
                    fileUrl={fileUrl}
                    isGitContext={isGitContext}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FileContent({
  file,
  kind,
  text,
  fileUrl,
  isGitContext,
}: {
  file: ContextFileItem;
  kind: FileKind | null;
  text: string;
  fileUrl: string;
  isGitContext: boolean;
}) {
  if (!kind) return null;

  if (file.size > TEXT_PREVIEW_LIMIT && kind !== "image" && kind !== "pdf") {
    return (
      <div className="p-4 space-y-3 text-sm">
        <p className="text-muted-foreground">File is too large to preview inline ({formatBytes(file.size)}).</p>
        <a href={fileUrl} className="inline-flex items-center gap-2 rounded-md border border-[var(--border-default)] px-3 py-1.5 text-sm hover:bg-muted">
          <Download className="size-4" />
          Download
        </a>
      </div>
    );
  }

  if (kind === "markdown") {
    return (
      <Tabs defaultValue="preview" className="flex flex-col h-full">
        <div className="border-b border-[var(--border-default)] px-4 pt-2 shrink-0">
          <TabsList className="h-8">
            <TabsTrigger value="preview" className="text-xs">Preview</TabsTrigger>
            <TabsTrigger value="raw" className="text-xs">Raw</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="preview" className="flex-1 overflow-auto p-0 mt-0">
          <div className="px-6 py-5">
            <MarkdownRenderer content={text} />
          </div>
        </TabsContent>
        <TabsContent value="raw" className="flex-1 overflow-auto p-0 mt-0">
          <pre className="p-4 font-mono text-xs leading-6 whitespace-pre-wrap break-words">{text}</pre>
        </TabsContent>
      </Tabs>
    );
  }

  if (kind === "code") {
    return (
      <Tabs defaultValue="preview" className="flex flex-col h-full">
        <div className="border-b border-[var(--border-default)] px-4 pt-2 shrink-0">
          <TabsList className="h-8">
            <TabsTrigger value="preview" className="text-xs">Preview</TabsTrigger>
            <TabsTrigger value="raw" className="text-xs">Raw</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="preview" className="flex-1 overflow-auto p-0 mt-0">
          <CodeBlock text={text} filePath={file.path} />
        </TabsContent>
        <TabsContent value="raw" className="flex-1 overflow-auto p-0 mt-0">
          <pre className="p-4 font-mono text-xs leading-6 whitespace-pre-wrap break-words">{text}</pre>
        </TabsContent>
      </Tabs>
    );
  }

  if (kind === "image") {
    return (
      <div className="flex items-center justify-center p-6 min-h-[300px] bg-muted/20">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fileUrl} alt={file.path} className="max-h-[600px] max-w-full object-contain rounded" />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <embed src={fileUrl} type="application/pdf" className="w-full h-full min-h-[600px]" />
    );
  }

  return (
    <div className="p-4 space-y-3 text-sm">
      <p className="text-muted-foreground">{file.display_type ?? "File"} file · {formatBytes(file.size)}</p>
      <a href={fileUrl} className="inline-flex items-center gap-2 rounded-md border border-[var(--border-default)] px-3 py-1.5 text-sm hover:bg-muted">
        <Download className="size-4" />
        Download
      </a>
    </div>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  return (
    /* P2-11 (2026-05-29): prose's default --tw-prose-pre-code / inline-code
       colour rendered as a faint grey on the light bg-muted block, hard to
       read. Force both fenced-code and inline-code text to text-foreground
       (full contrast against bg-muted in both light and dark themes). */
    <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:border prose-pre:border-[var(--border-default)] prose-pre:rounded-md prose-pre:text-foreground prose-pre:[&_code]:text-foreground prose-code:bg-muted prose-code:text-foreground prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono prose-blockquote:border-l prose-blockquote:border-[var(--border-default)] prose-blockquote:not-italic prose-headings:font-semibold prose-headings:tracking-tight">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function CodeBlock({ text, filePath }: { text: string; filePath: string }) {
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const language = detectLanguage(filePath);
    if (language === "text") {
      setHighlighted(null);
      return;
    }

    import("highlight.js/lib/core").then(async (hljsCore) => {
      const hljs = hljsCore.default;
      const loaders: Record<string, () => Promise<{ default: unknown }>> = {
        python: () => import("highlight.js/lib/languages/python"),
        yaml: () => import("highlight.js/lib/languages/yaml"),
        json: () => import("highlight.js/lib/languages/json"),
        bash: () => import("highlight.js/lib/languages/bash"),
        typescript: () => import("highlight.js/lib/languages/typescript"),
        javascript: () => import("highlight.js/lib/languages/javascript"),
        sql: () => import("highlight.js/lib/languages/sql"),
        xml: () => import("highlight.js/lib/languages/xml"),
        css: () => import("highlight.js/lib/languages/css"),
        go: () => import("highlight.js/lib/languages/go"),
        rust: () => import("highlight.js/lib/languages/rust"),
      };

      const loader = loaders[language];
      if (loader && !hljs.getLanguage(language)) {
        const mod = await loader();
        hljs.registerLanguage(language, mod.default as Parameters<typeof hljs.registerLanguage>[1]);
      }

      if (!cancelled && hljs.getLanguage(language)) {
        const result = hljs.highlight(text, { language });
        if (!cancelled) setHighlighted(result.value);
      }
    }).catch(() => { /* fallback to plain */ });

    return () => { cancelled = true; };
  }, [text, filePath]);

  return (
    <pre className="p-4 font-mono text-xs leading-6 overflow-auto bg-[var(--bg-app)]">
      {highlighted ? (
        <code className={`hljs language-${detectLanguage(filePath)}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code>{text}</code>
      )}
    </pre>
  );
}

function detectLanguage(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".sh")) return "bash";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".xml") || path.endsWith(".html") || path.endsWith(".htm")) return "xml";
  if (path.endsWith(".css") || path.endsWith(".scss")) return "css";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rs")) return "rust";
  return "text";
}
