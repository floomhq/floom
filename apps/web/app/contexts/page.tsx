"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Download,
  Edit3,
  File as FileIcon,
  FileCode,
  FileText,
  Folder,
  Image as ImageIcon,
  Plus,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ContextDetail, ContextFileItem, ContextSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const TEXT_PREVIEW_LIMIT = 256 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isKnownTextFile(file: ContextFileItem): boolean {
  const mime = file.mime_type.toLowerCase();
  const path = file.path.toLowerCase();
  return (
    !file.is_binary &&
    (
      mime.startsWith("text/") ||
      ["application/javascript", "application/json", "application/toml", "application/typescript", "application/yaml", "application/x-yaml", "application/xml"].includes(mime) ||
      /\.(mdx?|txt|log|env|json|ya?ml|toml|csv|tsv|py|js|jsx|ts|tsx|css|scss|html?|xml|sql|sh|go|rs|rb|php|java|c|cpp|h|hpp|cs)$/.test(path)
    )
  );
}

function isTextEditable(file: ContextFileItem): boolean {
  return isKnownTextFile(file) && file.size <= TEXT_PREVIEW_LIMIT;
}

function fileKind(file: ContextFileItem): "markdown" | "html" | "csv" | "code" | "pdf" | "image" | "binary" {
  const mime = file.mime_type.toLowerCase();
  const path = file.path.toLowerCase();
  if (path.endsWith(".md") || mime === "text/markdown") return "markdown";
  if (/\.(csv|tsv)$/.test(path) || mime === "text/csv" || mime === "text/tab-separated-values") return "csv";
  if (/\.(html|htm)$/.test(path) || mime === "text/html") return "html";
  if (mime === "application/pdf" || path.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (isKnownTextFile(file)) return "code";
  return "binary";
}

function FileKindIcon({ file }: { file: ContextFileItem }) {
  const kind = fileKind(file);
  if (kind === "image") return <ImageIcon className="size-4" />;
  if (kind === "code") return <FileCode className="size-4" />;
  if (kind === "markdown" || kind === "pdf") return <FileText className="size-4" />;
  return <FileIcon className="size-4" />;
}

export default function ContextsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [contexts, setContexts] = useState<ContextSummary[]>([]);
  const [selectedName, setSelectedName] = useState<string>("");
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [newContextName, setNewContextName] = useState("");
  const [newFilePath, setNewFilePath] = useState("");
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const selectedFile = detail?.files.find((file) => file.path === selectedPath) || null;

  const loadContexts = useCallback(async (nextSelected?: string) => {
    const items = await api.contexts.list();
    setContexts(items);
    const selected = nextSelected !== undefined ? nextSelected : (selectedName || items[0]?.name || "");
    setSelectedName(selected);
    if (selected) {
      const loaded = await api.contexts.get(selected);
      setDetail(loaded);
      setSelectedPath((current) => (
        current && loaded.files.some((file) => file.path === current)
          ? current
          : loaded.files[0]?.path || ""
      ));
    } else {
      setDetail(null);
      setSelectedPath("");
    }
  }, [selectedName]);

  useEffect(() => {
    loadContexts()
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Failed to load contexts"))
      .finally(() => setLoading(false));
  }, [loadContexts]);

  useEffect(() => {
    setEditing(false);
    setPreviewText("");
    if (!selectedName || !selectedFile || !isTextEditable(selectedFile)) return;
    setPreviewLoading(true);
    api.contexts.readTextFile(selectedName, selectedFile.path)
      .then(setPreviewText)
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Failed to load file"))
      .finally(() => setPreviewLoading(false));
  }, [selectedName, selectedFile]);

  const filteredContexts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contexts;
    return contexts.filter((context) => context.name.toLowerCase().includes(q));
  }, [contexts, search]);

  async function selectContext(name: string) {
    setSelectedName(name);
    setSelectedPath("");
    setPreviewText("");
    try {
      setDetail(await api.contexts.get(name));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to load context");
    }
  }

  async function createContext() {
    const name = newContextName.trim();
    if (!name) return;
    try {
      await api.contexts.create(name);
      setNewContextName("");
      await loadContexts(name);
      toast.success("Context created");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to create context");
    }
  }

  async function saveFile() {
    if (!selectedName || !selectedFile) return;
    try {
      await api.contexts.saveTextFile(selectedName, selectedFile.path, previewText);
      setEditing(false);
      await loadContexts(selectedName);
      setSelectedPath(selectedFile.path);
      toast.success("File saved");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to save file");
    }
  }

  async function addTextFile() {
    if (!selectedName) return;
    const path = newFilePath.trim();
    if (!path) return;
    try {
      await api.contexts.saveTextFile(selectedName, path, "");
      setNewFilePath("");
      await loadContexts(selectedName);
      setSelectedPath(path);
      setEditing(true);
      toast.success("File created");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to create file");
    }
  }

  async function deleteFile(file: ContextFileItem) {
    if (!selectedName || !confirm(`Delete ${file.path}?`)) return;
    try {
      const next = await api.contexts.deleteFile(selectedName, file.path);
      setDetail(next);
      setSelectedPath(next.files[0]?.path || "");
      await loadContexts(selectedName);
      toast.success("File deleted");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to delete file");
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    if (!selectedName || files.length === 0) return;
    try {
      await api.contexts.upload(selectedName, files);
      await loadContexts(selectedName);
      toast.success("Upload complete");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Upload failed");
    }
  }

  async function deleteContext(context: ContextSummary) {
    if (!confirm(`Delete context ${context.name}?`)) return;
    try {
      await api.contexts.delete(context.name, true);
      const remaining = contexts.filter((item) => item.name !== context.name);
      setContexts(remaining);
      await loadContexts(remaining[0]?.name || "");
      toast.success("Context deleted");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to delete context");
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-56" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_320px_1fr]">
          <Skeleton className="h-[520px] rounded-[var(--radius-button)]" />
          <Skeleton className="h-[520px] rounded-[var(--radius-button)]" />
          <Skeleton className="h-[520px] rounded-[var(--radius-button)]" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contexts</h1>
        </div>
        <div className="flex gap-2">
          <Input
            value={newContextName}
            onChange={(event) => setNewContextName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createContext();
            }}
            placeholder="knowledge-base"
            className="h-9 w-48"
          />
          <Button size="sm" onClick={createContext}>
            <Plus className="size-4" />
            New context
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_320px_1fr]">
        <section className="min-h-[520px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
          <div className="border-b border-[var(--border-default)] p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search contexts..."
                className="h-8 pl-9"
              />
            </div>
          </div>
          <div className="divide-y divide-line">
            {filteredContexts.map((context) => (
              <div
                key={context.name}
                role="button"
                tabIndex={0}
                onClick={() => void selectContext(context.name)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") void selectContext(context.name);
                }}
                className={`group flex w-full items-start gap-2 px-3 py-3 text-left transition-colors ${
                  context.name === selectedName ? "bg-muted text-foreground" : "hover:bg-muted/50"
                }`}
              >
                <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{context.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {context.file_count} files · {formatBytes(context.total_size_bytes)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void deleteContext(context);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.stopPropagation();
                      void deleteContext(context);
                    }
                  }}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  title={`Delete ${context.name}`}
                >
                  <Trash2 className="size-3.5 text-muted-foreground hover:text-red-500" />
                </button>
              </div>
            ))}
            {filteredContexts.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No contexts found.</p>
            )}
          </div>
        </section>

        <section
          className={`min-h-[520px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden ${dragActive ? "bg-[var(--active-nav-bg)]" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            void uploadFiles(event.dataTransfer.files);
          }}
        >
          <div className="flex items-center justify-between border-b border-line p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{detail?.name || "Files"}</p>
              <p className="text-xs text-muted-foreground">
                {detail ? `${formatBytes(detail.total_size_bytes)} · updated ${formatDate(detail.updated_at)}` : "No context selected"}
              </p>
            </div>
            <div className="flex gap-1">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) void uploadFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              <Button
                size="icon"
                variant="outline"
                disabled={!selectedName}
                onClick={() => fileInputRef.current?.click()}
                title="Upload file"
              >
                <Upload className="size-4" />
              </Button>
            </div>
          </div>

          {selectedName && (
            <div className="border-b border-line p-3">
              <div className="flex gap-2">
                <Input
                  value={newFilePath}
                  onChange={(event) => setNewFilePath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void addTextFile();
                  }}
                  placeholder="notes/template.md"
                  className="h-8"
                />
                <Button size="sm" variant="outline" onClick={addTextFile}>
                  <Plus className="size-4" />
                  New file
                </Button>
              </div>
            </div>
          )}

          <div className="divide-y divide-line">
            {(detail?.files || []).map((file) => (
              <div
                key={file.path}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedPath(file.path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setSelectedPath(file.path);
                }}
                className={`group flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors ${
                  file.path === selectedPath ? "bg-muted text-foreground" : "hover:bg-muted/50"
                }`}
              >
                <span className="text-muted-foreground"><FileKindIcon file={file} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">{file.path}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(file.size)} · {file.mime_type}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void deleteFile(file);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.stopPropagation();
                      void deleteFile(file);
                    }
                  }}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  title={`Delete ${file.path}`}
                >
                  <Trash2 className="size-3.5 text-muted-foreground hover:text-red-500" />
                </button>
              </div>
            ))}
            {selectedName && detail?.files.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No files found.</p>
            )}
          </div>
        </section>

        <section className="min-h-[520px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-default)] p-3">
            <div className="min-w-0">
              <p className="truncate font-mono text-sm">{selectedFile?.path || "Select a file"}</p>
              {selectedFile && (
                <p className="text-xs text-muted-foreground">
                  {formatBytes(selectedFile.size)} · {formatDate(selectedFile.updated_at)}
                </p>
              )}
            </div>
            {selectedFile && (
              <div className="flex gap-1">
                {isTextEditable(selectedFile) && !editing && (
                  <Button size="icon" variant="outline" onClick={() => setEditing(true)} title="Edit file">
                    <Edit3 className="size-4" />
                  </Button>
                )}
                {editing && (
                  <>
                    <Button size="icon" variant="outline" onClick={() => setEditing(false)} title="Cancel">
                      <X className="size-4" />
                    </Button>
                    <Button size="icon" onClick={saveFile} title="Save file">
                      <Save className="size-4" />
                    </Button>
                  </>
                )}
                <a
                  href={api.contexts.fileUrl(selectedName, selectedFile.path)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border border-line text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Download file"
                >
                  <Download className="size-4" />
                </a>
              </div>
            )}
          </div>

          <div className="p-4">
            {!selectedFile ? (
              <p className="text-sm text-muted-foreground">No file selected.</p>
            ) : previewLoading ? (
              <Skeleton className="h-64 w-full rounded-[var(--radius-button)]" />
            ) : editing ? (
              <Textarea
                value={previewText}
                onChange={(event) => setPreviewText(event.target.value)}
                className="min-h-[560px] w-full resize-y border border-line bg-background p-3 font-mono text-xs leading-6 outline-none focus:border-foreground"
              />
            ) : (
              <FilePreview file={selectedFile} contextName={selectedName} text={previewText} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function FilePreview({
  contextName,
  file,
  text,
}: {
  contextName: string;
  file: ContextFileItem;
  text: string;
}) {
  const kind = fileKind(file);
  const fileUrl = api.contexts.fileUrl(contextName, file.path);

  if (isKnownTextFile(file) && file.size > TEXT_PREVIEW_LIMIT) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">File too large to preview inline.</p>
        <DownloadLink fileUrl={fileUrl} />
      </div>
    );
  }

  if (kind === "markdown") {
    return (
      <TextPreviewTabs text={text} fileUrl={fileUrl}>
        <div className="prose prose-sm max-w-none text-foreground">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      </TextPreviewTabs>
    );
  }
  if (kind === "html") {
    return (
      <TextPreviewTabs text={text} fileUrl={fileUrl}>
        <iframe
          srcDoc={text}
          sandbox="allow-same-origin"
          className="h-[640px] w-full border border-line bg-white"
          title={file.path}
        />
      </TextPreviewTabs>
    );
  }
  if (kind === "csv") {
    return (
      <TextPreviewTabs text={text} fileUrl={fileUrl}>
        <CsvPreview text={text} delimiter={file.path.toLowerCase().endsWith(".tsv") ? "\t" : ","} />
      </TextPreviewTabs>
    );
  }
  if (kind === "code") {
    return (
      <TextPreviewTabs text={text} fileUrl={fileUrl}>
        <CodeBlock text={text} />
      </TextPreviewTabs>
    );
  }
  if (kind === "pdf") {
    return (
      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="download">Download</TabsTrigger>
        </TabsList>
        <TabsContent value="preview">
          <embed src={fileUrl} type="application/pdf" className="h-[640px] w-full border border-line" />
        </TabsContent>
        <TabsContent value="download">
          <DownloadLink fileUrl={fileUrl} />
        </TabsContent>
      </Tabs>
    );
  }
  if (kind === "image") {
    return (
      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="download">Download</TabsTrigger>
        </TabsList>
        <TabsContent value="preview">
          <div className="flex min-h-[320px] items-center justify-center bg-muted/30 p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl} alt={file.path} className="max-h-[640px] max-w-full object-contain" />
          </div>
        </TabsContent>
        <TabsContent value="download">
          <DownloadLink fileUrl={fileUrl} />
        </TabsContent>
      </Tabs>
    );
  }
  return <BinaryPreview file={file} fileUrl={fileUrl} />;
}

function TextPreviewTabs({
  children,
  fileUrl,
  text,
}: {
  children: React.ReactNode;
  fileUrl: string;
  text: string;
}) {
  return (
    <Tabs defaultValue="preview">
      <TabsList>
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="raw">Raw</TabsTrigger>
        <TabsTrigger value="download">Download</TabsTrigger>
      </TabsList>
      <TabsContent value="preview">{children}</TabsContent>
      <TabsContent value="raw">
        <CodeBlock text={text} />
      </TabsContent>
      <TabsContent value="download">
        <DownloadLink fileUrl={fileUrl} />
      </TabsContent>
    </Tabs>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-[640px] overflow-auto bg-muted/40 p-3 font-mono text-xs leading-6">
      <code>{text}</code>
    </pre>
  );
}

function CsvPreview({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = Papa.parse<string[]>(text.trim(), {
    delimiter,
    skipEmptyLines: true,
  }).data as string[][];

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Empty file.</p>;
  }

  const [header, ...body] = rows;
  return (
    <div className="max-h-[640px] overflow-auto border border-line">
      <Table>
        <TableHeader>
          <TableRow>
            {header.map((cell, index) => (
              <TableHead key={`${cell}-${index}`} className="font-mono text-xs">
                {cell || `Column ${index + 1}`}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {body.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {header.map((_cell, cellIndex) => (
                <TableCell key={cellIndex} className="font-mono text-xs">
                  {row[cellIndex] || ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DownloadLink({ fileUrl }: { fileUrl: string }) {
  return (
    <a
      href={fileUrl}
      className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-button)] border border-line px-3 text-sm font-medium hover:bg-muted"
    >
      <Download className="size-4" />
      Download
    </a>
  );
}

function BinaryPreview({ file, fileUrl }: { file: ContextFileItem; fileUrl: string }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <FileIcon className="size-4" />
        <span>{file.mime_type}</span>
      </div>
      <p className="font-mono text-xs text-muted-foreground">{file.path}</p>
      <DownloadLink fileUrl={fileUrl} />
    </div>
  );
}
