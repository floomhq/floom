"use client";

import "highlight.js/styles/github.css";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  File as FileIcon,
  FileCode,
  FileText,
  Film,
  Folder,
  History,
  Image as ImageIcon,
  Link as LinkIcon,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Search,
  Table,
  Trash2,
  X,
} from "lucide-react";
import Papa from "papaparse";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ContextDetail, ContextFileItem, ContextSummary, VersionFileSnapshot, VersionSummary } from "@/lib/types";
import { VersionDiffPanel } from "@/components/VersionDiffPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const TEXT_PREVIEW_LIMIT = 512 * 1024;
const TABLE_PREVIEW_ROWS = 100;
const TABLE_PREVIEW_COLS = 12;
const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
const BRAIN_ROUTE = `${APP_BASE_PATH}/brain`;

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

function displayTypeIcon(displayType: string) {
  if (displayType === "Markdown") return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  if (["YAML", "Python", "JavaScript", "TypeScript", "JSON", "Shell", "SQL"].includes(displayType))
    return <FileCode className="size-4 shrink-0 text-muted-foreground" />;
  if (displayType === "Image") return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (displayType === "CSV" || displayType === "Spreadsheet") return <Table className="size-4 shrink-0 text-muted-foreground" />;
  if (displayType === "PDF") return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  if (displayType === "Video") return <Film className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function visibleMetadataEntries(file: ContextFileItem): [string, string][] {
  return Object.entries(file.metadata ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => [key, String(value)]);
}

function FileTagChips({ file, compact = false }: { file: ContextFileItem; compact?: boolean }) {
  const tags = file.tags ?? [];
  const metadata = visibleMetadataEntries(file);
  if (tags.length === 0 && metadata.length === 0) return null;

  return (
    <div className={`flex flex-wrap items-center gap-1 ${compact ? "mt-1" : "mt-2"}`}>
      {tags.map((tag) => (
        <span
          key={`tag:${tag}`}
          className="inline-flex max-w-full items-center rounded-[var(--radius-pill)] border border-[var(--border-default)] bg-[var(--bg-app)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title={`Tag: ${tag}`}
        >
          <span className="truncate">{tag}</span>
        </span>
      ))}
      {metadata.map(([key, value]) => (
        <span
          key={`meta:${key}`}
          className="inline-flex max-w-full items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-default)] bg-[var(--bg-app)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title={`${key}: ${value}`}
        >
          <span className="truncate">{key}</span>
          <span className="text-foreground/70">:</span>
          <span className="truncate">{value}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File-kind helpers (ported from the old file viewer route).
// ---------------------------------------------------------------------------

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

type FileKind = "markdown" | "code" | "html" | "table" | "spreadsheet" | "image" | "pdf" | "video" | "binary";

function fileKind(file: ContextFileItem): FileKind {
  const mime = file.mime_type.toLowerCase();
  const path = file.path.toLowerCase();
  if (path.endsWith(".md") || path.endsWith(".mdx") || mime === "text/markdown") return "markdown";
  if (path.endsWith(".html") || path.endsWith(".htm") || mime === "text/html") return "html";
  if (path.endsWith(".csv") || path.endsWith(".tsv") || mime === "text/csv" || mime === "text/tab-separated-values") return "table";
  if (path.endsWith(".xlsx") || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "spreadsheet";
  if (mime === "application/pdf" || path.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)$/.test(path)) return "video";
  if (mime.startsWith("image/")) return "image";
  if (isKnownTextFile(file)) return "code";
  return "binary";
}

function fileDisplayType(file: ContextFileItem): string {
  switch (fileKind(file)) {
    case "markdown":
      return "Markdown";
    case "code":
      return file.display_type ?? "Code";
    case "html":
      return "HTML";
    case "table":
      return file.path.toLowerCase().endsWith(".tsv") ? "TSV" : "CSV";
    case "spreadsheet":
      return "Spreadsheet";
    case "image":
      return "Image";
    case "pdf":
      return "PDF";
    case "video":
      return "Video";
    default:
      return file.display_type ?? "File";
  }
}

// ---------------------------------------------------------------------------
// Miller-column entry building. A folder column lists the immediate children
// (folders + files) of one folder level.
// ---------------------------------------------------------------------------

type FolderEntry = { kind: "folder"; name: string; path: string; fileCount: number; size: number };
type FileEntry = { kind: "file"; name: string; file: ContextFileItem };
type Entry = FolderEntry | FileEntry;

function buildEntries(files: ContextFileItem[], currentFolder: string): Entry[] {
  const prefix = currentFolder ? `${currentFolder}/` : "";
  const folders = new Map<string, { fileCount: number; size: number }>();
  const directFiles: FileEntry[] = [];

  for (const file of files) {
    if (currentFolder && !file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      directFiles.push({ kind: "file", name: rest, file });
    } else {
      const folderName = rest.slice(0, slash);
      const agg = folders.get(folderName) ?? { fileCount: 0, size: 0 };
      agg.fileCount += 1;
      agg.size += file.size;
      folders.set(folderName, agg);
    }
  }

  const folderEntries: FolderEntry[] = [...folders.entries()]
    .map(([name, agg]) => ({
      kind: "folder" as const,
      name,
      path: currentFolder ? `${currentFolder}/${name}` : name,
      fileCount: agg.fileCount,
      size: agg.size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  directFiles.sort((a, b) => a.name.localeCompare(b.name));

  return [...folderEntries, ...directFiles];
}

// ---------------------------------------------------------------------------
// Resizable panes (Cursor-IDE style). Two draggable vertical dividers let the
// user set the width of the packs pane and the middle pane; the final pane
// flexes to fill the rest. Widths persist to localStorage and only apply on
// the desktop side-by-side layout (lg+), so the mobile drill-in is untouched.
// ---------------------------------------------------------------------------

const PANE_WIDTHS_KEY = "floom:brain:pane-widths";
const PACKS_MIN = 160;
const PACKS_MAX = 420;
const MID_MIN = 180;
const MID_MAX = 560;
const PACKS_DEFAULT = 300;
const MID_DEFAULT = 280;

type PaneWidths = { packs: number; mid: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadPaneWidths(): PaneWidths {
  if (typeof window === "undefined") return { packs: PACKS_DEFAULT, mid: MID_DEFAULT };
  try {
    const raw = window.localStorage.getItem(PANE_WIDTHS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PaneWidths>;
      return {
        packs: clamp(Number(parsed.packs) || PACKS_DEFAULT, PACKS_MIN, PACKS_MAX),
        mid: clamp(Number(parsed.mid) || MID_DEFAULT, MID_MIN, MID_MAX),
      };
    }
  } catch {
    /* ignore malformed storage */
  }
  return { packs: PACKS_DEFAULT, mid: MID_DEFAULT };
}

// True on the desktop side-by-side layout (Tailwind lg breakpoint). Inline pane
// widths are only honoured here; below lg each pane is full-width and drill-in.
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

// A thin draggable divider. onResize receives the pointer's horizontal delta in
// px since the drag started; the parent clamps + commits the new width.
function ResizableDivider({
  ariaLabel,
  onResizeStart,
  onResize,
  onResizeEnd,
}: {
  ariaLabel: string;
  onResizeStart: () => void;
  onResize: (deltaX: number) => void;
  onResizeEnd: () => void;
}) {
  const startX = useRef(0);
  const dragging = useRef(false);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    startX.current = e.clientX;
    dragging.current = true;
    onResizeStart();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    onResize(e.clientX - startX.current);
  }
  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    onResizeEnd();
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="relative z-20 hidden lg:block w-px shrink-0 cursor-col-resize bg-[var(--border-default)] transition-colors hover:bg-[var(--primary)]/40 before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-['']"
    />
  );
}

// ===========================================================================

export default function ContextsPageShell() {
  return (
    <Suspense>
      <ContextsPage />
    </Suspense>
  );
}

function ContextsPage() {
  const searchParams = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Core state ---------------------------------------------------------
  const [contexts, setContexts] = useState<ContextSummary[]>([]);
  const [selectedName, setSelectedName] = useState<string>(() => searchParams.get("pack") ?? "");
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // folderPath: the miller-column drill path inside the selected pack.
  // [] = pack root; ["SOP"] = inside SOP; ["SOP","2026"] = nested.
  const [folderPath, setFolderPath] = useState<string[]>(() => {
    const p = searchParams.get("path");
    return p ? p.split("/").filter(Boolean) : [];
  });
  // selectedFile: the full path of the open file, or null when no file is open.
  const [selectedFile, setSelectedFile] = useState<string | null>(() => searchParams.get("file"));

  // File content pane state.
  const [fileText, setFileText] = useState("");
  const [loadingText, setLoadingText] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionsKey, setVersionsKey] = useState(0);

  const [search, setSearch] = useState("");
  const [newContextName, setNewContextName] = useState("");
  const [showNewContext, setShowNewContext] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // ---- Resizable panes (desktop only) -------------------------------------
  const isDesktop = useIsDesktop();
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => loadPaneWidths());
  // Width captured at the moment a divider drag starts, so the delta is applied
  // to a stable base instead of compounding across pointermove events.
  const resizeBase = useRef<PaneWidths>(paneWidths);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(paneWidths));
    } catch {
      /* storage unavailable / quota */
    }
  }, [paneWidths]);

  const beginResize = useCallback(() => {
    resizeBase.current = paneWidths;
  }, [paneWidths]);

  const resizePacks = useCallback((deltaX: number) => {
    setPaneWidths((prev) => ({ ...prev, packs: clamp(resizeBase.current.packs + deltaX, PACKS_MIN, PACKS_MAX) }));
  }, []);

  const resizeMid = useCallback((deltaX: number) => {
    setPaneWidths((prev) => ({ ...prev, mid: clamp(resizeBase.current.mid + deltaX, MID_MIN, MID_MAX) }));
  }, []);

  const noop = useCallback(() => {}, []);

  // On mobile only one pane shows at a time. Initialise from the URL so a
  // deep-link (?pack=&file=) lands on the right pane instead of stranding the
  // user on the pack list with the file pane absent from the DOM.
  const [mobilePane, setMobilePane] = useState<"packs" | "files" | "file">(() => {
    if (searchParams.get("file")) return "file";
    if (searchParams.get("pack")) return "files";
    return "packs";
  });

  // ---- Shallow URL sync (no Next navigation / remount) --------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (selectedName) params.set("pack", selectedName);
    if (folderPath.length) params.set("path", folderPath.join("/"));
    if (selectedFile) params.set("file", selectedFile);
    const qs = params.toString();
    const next = `${BRAIN_ROUTE}${qs ? `?${qs}` : ""}`;
    if (window.location.pathname + window.location.search !== next) {
      window.history.replaceState(window.history.state, "", next);
    }
  }, [selectedName, folderPath, selectedFile]);

  // ---- Data loading -------------------------------------------------------
  const loadContexts = useCallback(async (nextSelected?: string) => {
    const items = await api.contexts.list();
    setContexts(items);
    setSelectedName((current) => {
      const firstOperator = items.find((c) => !c.system)?.name;
      const fallback = firstOperator || items[0]?.name || "";
      const selected = nextSelected !== undefined ? nextSelected : (current || fallback);
      if (selected) {
        api.contexts.get(selected).then(setDetail).catch(() => setDetail(null));
      } else {
        setDetail(null);
      }
      return selected;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const isTransientFetchError = (error: unknown) =>
      error instanceof TypeError ||
      (error instanceof Error && /failed to fetch|load failed|network/i.test(error.message));

    (async () => {
      try {
        await loadContexts();
      } catch (error: unknown) {
        if (isTransientFetchError(error)) {
          try {
            await new Promise((r) => setTimeout(r, 600));
            if (cancelled) return;
            await loadContexts();
          } catch {
            if (!cancelled) toast.error("Couldn't reach the server. Check your connection and retry.");
          }
        } else if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "Failed to load knowledge packs");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [loadContexts]);

  // ---- File text loading (keyed on stable primitives) ---------------------
  const fileObj = useMemo(
    () => (selectedFile ? detail?.files.find((f) => f.path === selectedFile) ?? null : null),
    [detail, selectedFile]
  );
  const kind = fileObj ? fileKind(fileObj) : null;
  const fileUrl = fileObj ? api.contexts.fileUrl(selectedName, fileObj.path) : "";
  const loadableTextPath =
    fileObj && isKnownTextFile(fileObj) && fileObj.size <= TEXT_PREVIEW_LIMIT ? fileObj.path : null;

  useEffect(() => {
    setEditing(false);
    setFileText("");
    if (!loadableTextPath || !selectedName) return;
    let cancelled = false;
    setLoadingText(true);
    api.contexts.readTextFile(selectedName, loadableTextPath)
      .then((value) => { if (!cancelled) setFileText(value); })
      .catch((err: unknown) => { if (!cancelled) toast.error(err instanceof Error ? err.message : "Failed to load file"); })
      .finally(() => { if (!cancelled) setLoadingText(false); });
    return () => { cancelled = true; };
  }, [selectedName, loadableTextPath]);

  // ---- Derived view data --------------------------------------------------
  const filteredContexts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contexts;
    return contexts.filter((c) => c.name.toLowerCase().includes(q));
  }, [contexts, search]);

  const operatorPacks = useMemo(() => filteredContexts.filter((c) => !c.system), [filteredContexts]);
  const systemPacks = useMemo(() => filteredContexts.filter((c) => c.system), [filteredContexts]);

  // Miller columns: one entry list per folder level, [root, level1, ...].
  const folderColumns = useMemo(() => {
    if (!detail) return [] as { folder: string; entries: Entry[] }[];
    const cols: { folder: string; entries: Entry[] }[] = [];
    cols.push({ folder: "", entries: buildEntries(detail.files, "") });
    for (let i = 0; i < folderPath.length; i++) {
      const folder = folderPath.slice(0, i + 1).join("/");
      cols.push({ folder, entries: buildEntries(detail.files, folder) });
    }
    return cols;
  }, [detail, folderPath]);

  const fileOpen = Boolean(selectedFile && fileObj);
  const readOnly = Boolean(detail?.read_only);

  // ---- Actions ------------------------------------------------------------
  async function selectContext(name: string) {
    setSelectedName(name);
    setFolderPath([]);
    setSelectedFile(null);
    setVersionsOpen(false);
    setMobilePane("files");
    try {
      setDetail(await api.contexts.get(name));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to load knowledge pack");
    }
  }

  // Open a folder AT a given column level. levelIndex = the column the click
  // happened in (0 = root column). Drilling truncates deeper levels.
  function openFolder(levelIndex: number, folderPathStr: string) {
    const parts = folderPathStr.split("/").filter(Boolean);
    setFolderPath(parts);
    setSelectedFile(null);
    setVersionsOpen(false);
  }

  function openFile(path: string) {
    setSelectedFile(path);
    setVersionsOpen(false);
    setMobilePane("file");
    // Drill folderPath to the file's parent so the column stack stays coherent
    // (so the parent folder column is visible alongside the file pane).
    const slash = path.lastIndexOf("/");
    setFolderPath(slash === -1 ? [] : path.slice(0, slash).split("/").filter(Boolean));
  }

  function closeFile() {
    setSelectedFile(null);
    setMobilePane("files");
  }

  async function createContext() {
    const name = newContextName.trim();
    if (!name) return;
    try {
      await api.contexts.create(name);
      setNewContextName("");
      setShowNewContext(false);
      await loadContexts(name);
      setFolderPath([]);
      setSelectedFile(null);
      toast.success("Knowledge pack created");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to create knowledge pack");
    }
  }

  async function deleteContext(context: ContextSummary) {
    if (context.read_only) return;
    if (!confirm(`Delete knowledge pack "${context.name}"? This cannot be undone.`)) return;
    try {
      await api.contexts.delete(context.name, true);
      const remaining = contexts.filter((item) => item.name !== context.name);
      setContexts(remaining);
      setFolderPath([]);
      setSelectedFile(null);
      await loadContexts(remaining[0]?.name || "");
      toast.success("Knowledge pack deleted");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to delete knowledge pack");
    }
  }

  async function deleteFile(path: string) {
    if (!selectedName || !confirm(`Delete "${path}"?`)) return;
    try {
      const next = await api.contexts.deleteFile(selectedName, path);
      setDetail(next);
      if (selectedFile === path) setSelectedFile(null);
      await loadContexts(selectedName);
      toast.success("File deleted");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to delete file");
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    if (!selectedName || files.length === 0) return;
    if (readOnly) {
      toast.error("System packs are read-only.");
      return;
    }
    try {
      await api.contexts.upload(selectedName, files, folderPath.length ? folderPath.join("/") : undefined);
      const refreshed = await api.contexts.get(selectedName);
      setDetail(refreshed);
      await loadContexts(selectedName);
      toast.success("File added");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to add file");
    }
  }

  // ---- Drag-and-drop upload ----------------------------------------------
  // The previous wiring set `dragActive` on every `dragover` and cleared it on
  // every `dragleave`. Because dragleave fires when the cursor crosses onto a
  // CHILD element, the highlight flickered and the drop affordance was unclear,
  // making drops feel broken. Track an enter-counter so `dragActive` is stable
  // for the whole pane, and only treat the event as a file drag (ignore text /
  // element drags that can't be uploaded).
  const dragDepth = useRef(0);
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const dropHandlers = readOnly
    ? {}
    : {
        // preventDefault on BOTH dragenter and dragover is REQUIRED, otherwise
        // the browser treats the pane as a non-drop target and the `drop` event
        // never fires. We always preventDefault here and only gate the *visual*
        // dragActive overlay on whether the payload is actually files — some
        // browsers report an empty `types` list mid-drag, so guarding the
        // preventDefault itself (the previous behavior) silently broke drops.
        onDragEnter: (e: React.DragEvent) => {
          e.preventDefault();
          dragDepth.current += 1;
          if (isFileDrag(e)) setDragActive(true);
        },
        onDragOver: (e: React.DragEvent) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (isFileDrag(e) && !dragActive) setDragActive(true);
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragActive(false);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragActive(false);
          if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
        },
      };

  async function saveFile() {
    if (!fileObj) return;
    try {
      await api.contexts.saveTextFile(selectedName, fileObj.path, editText);
      setFileText(editText);
      setEditing(false);
      const refreshed = await api.contexts.get(selectedName);
      setDetail(refreshed);
      setVersionsKey((k) => k + 1);
      toast.success("File saved");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save file");
    }
  }

  // ---- Render -------------------------------------------------------------
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-7 w-48 rounded-[var(--radius-button)]" />
          <Skeleton className="h-4 w-72 rounded-[var(--radius-button)]" />
        </div>
        <div className="flex flex-col lg:flex-row gap-4" style={{ minHeight: 520 }}>
          <Skeleton className="w-full lg:w-[30%] rounded-[var(--radius-card)]" style={{ minHeight: 180 }} />
          <Skeleton className="flex-1 rounded-[var(--radius-card)]" style={{ minHeight: 320 }} />
        </div>
      </div>
    );
  }

  // Desktop pane width comes from the resizable state; on mobile each pane is
  // full-width (drill-in). The packs pane keeps its user-set width in both the
  // default and file-open modes so dragging the divider behaves predictably.
  const packsStyle = isDesktop ? { width: paneWidths.packs } : undefined;
  const midStyle = isDesktop ? { width: paneWidths.mid } : undefined;

  return (
    <div className="flex flex-col gap-5" style={{ height: "calc(100vh - 120px)" }}>
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Brain</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Reusable knowledge packs your workers can read before they act.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setShowNewContext(true)}>
            <Plus className="size-4" />
            New pack
          </Button>
        </div>
      </div>

      {/* New brain-pack inline form */}
      {showNewContext && (
        <div className="shrink-0 flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2">
          <Input
            autoFocus
            value={newContextName}
            onChange={(e) => setNewContextName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createContext();
              if (e.key === "Escape") { setShowNewContext(false); setNewContextName(""); }
            }}
            placeholder="knowledge-base"
            className="h-8 w-56"
          />
          <Button size="sm" onClick={createContext} disabled={!newContextName.trim()}>Create</Button>
          <Button size="sm" variant="ghost" onClick={() => { setShowNewContext(false); setNewContextName(""); }}>
            <X className="size-4" />
          </Button>
        </div>
      )}

      {/* Progressive miller-column panes inside ONE unified container. Desktop:
          side-by-side panes separated by internal dividers (not floating cards),
          compressing as a file opens. Mobile: a single drill-in column. */}
      <div className="flex flex-col lg:flex-row flex-1 min-h-0 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
        {/* ---- Packs pane (resizable on desktop, drag the divider to its
            right). Full-width on mobile drill-in. ---------------------------- */}
        <section
          style={packsStyle}
          className={`flex flex-col w-full lg:w-auto shrink-0 border-b lg:border-b-0 border-[var(--border-default)] ${
            mobilePane === "packs" ? "flex" : "hidden lg:flex"
          }`}
        >
          <div className="flex min-h-[82px] shrink-0 flex-col justify-center border-b border-[var(--border-default)] p-3">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Knowledge packs</p>
            {!fileOpen && (
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search packs..."
                  className="h-7 pl-8 text-sm"
                />
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {filteredContexts.length === 0 && (
              <div className="p-4 text-center">
                <p className="text-sm text-muted-foreground">No matches.</p>
              </div>
            )}

            {operatorPacks.length > 0 ? (
              <div className="divide-y divide-[var(--border-default)]">
                {operatorPacks.map((ctx) => (
                  <PackRow
                    key={ctx.name}
                    ctx={ctx}
                    compact={fileOpen}
                    selected={ctx.name === selectedName}
                    onSelect={() => void selectContext(ctx.name)}
                    onDelete={() => void deleteContext(ctx)}
                  />
                ))}
              </div>
            ) : (
              !search.trim() && (
                <div className="p-4">
                  <button
                    type="button"
                    onClick={() => setShowNewContext(true)}
                    className="w-full rounded-[var(--radius-button)] border border-dashed border-[var(--border-default)] px-3 py-4 text-left hover:bg-muted/40 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Plus className="size-4" />
                      New knowledge pack
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Company facts, ICP, and brand voice your workers read before they act.
                    </span>
                  </button>
                </div>
              )
            )}

            {systemPacks.length > 0 && (
              <div>
                <p className="px-3 pt-4 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  System
                </p>
                <div className="divide-y divide-[var(--border-default)]">
                  {systemPacks.map((ctx) => (
                    <PackRow
                      key={ctx.name}
                      ctx={ctx}
                      compact={fileOpen}
                      selected={ctx.name === selectedName}
                      onSelect={() => void selectContext(ctx.name)}
                      onDelete={() => void deleteContext(ctx)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Divider between the packs pane and the detail/middle pane. */}
        <ResizableDivider
          ariaLabel="Resize knowledge packs pane"
          onResizeStart={beginResize}
          onResize={resizePacks}
          onResizeEnd={noop}
        />

        {/* ---- Pack detail / miller folder columns ------------------------ */}
        {!selectedName ? (
          <section className="flex-1 overflow-hidden flex items-center justify-center p-8">
            <div className="max-w-md text-center space-y-4">
              <div className="space-y-1.5">
                <h2 className="text-base font-semibold">Give your workers knowledge</h2>
                <p className="text-sm text-muted-foreground">
                  A knowledge pack is a small set of files your workers read before they act:
                  company facts, your ICP, product details, and brand voice. Attach a pack to a
                  worker and it uses that brain pack on every run.
                </p>
              </div>
              <Button onClick={() => setShowNewContext(true)}>
                <Plus className="size-4" />
                New knowledge pack
              </Button>
            </div>
          </section>
        ) : !detail ? (
          <section className="flex-1 overflow-hidden flex items-center justify-center">
            <Skeleton className="h-10 w-48 rounded-[var(--radius-button)]" />
          </section>
        ) : versionsOpen && fileObj ? (
          <BrainFileVersionsPane
            key={`${selectedName}:${fileObj.path}:${versionsKey}`}
            packName={selectedName}
            selectedFile={fileObj}
            currentFileContent={isKnownTextFile(fileObj) ? fileText : ""}
            readOnly={readOnly}
            onClose={() => setVersionsOpen(false)}
            onRestored={(restoredContent) => {
              setFileText(restoredContent);
              setVersionsOpen(false);
              setVersionsKey((k) => k + 1);
              void api.contexts.get(selectedName).then(setDetail).catch(() => {});
              void loadContexts(selectedName);
            }}
          />
        ) : !fileOpen ? (
          /* DEFAULT: 70% pack-detail with the file/folder tree + metadata.
             Folder drill happens via miller columns inside this pane. */
          <PackDetailPane
            detail={detail}
            folderColumns={folderColumns}
            folderPath={folderPath}
            dragActive={dragActive}
            readOnly={readOnly}
            mobileVisible={mobilePane === "files"}
            onBackMobile={() => setMobilePane("packs")}
            onOpenFolder={openFolder}
            onOpenFile={openFile}
            onDeleteFile={deleteFile}
            onAddFile={() => fileInputRef.current?.click()}
            dropHandlers={dropHandlers}
          />
        ) : (
          /* FILE OPEN: resizable folder columns + flexing file content. */
          <>
            <section
              style={midStyle}
              className={`flex overflow-hidden w-full lg:w-auto shrink-0 border-b lg:border-b-0 border-[var(--border-default)] ${
                mobilePane === "files" ? "flex" : "hidden lg:flex"
              }`}
            >
              <FolderColumns
                detail={detail}
                folderColumns={folderColumns}
                folderPath={folderPath}
                selectedFile={selectedFile}
                compact
                onBackMobile={() => setMobilePane("packs")}
                onOpenFolder={openFolder}
                onOpenFile={openFile}
              />
            </section>

            {/* Divider between the folder columns and the file viewer. */}
            <ResizableDivider
              ariaLabel="Resize files pane"
              onResizeStart={beginResize}
              onResize={resizeMid}
              onResizeEnd={noop}
            />

            <section
              {...dropHandlers}
              className={`relative flex-1 overflow-hidden flex flex-col min-w-0 transition-colors duration-300 ${
                dragActive && !readOnly ? "bg-muted/30" : ""
              } ${mobilePane === "file" ? "flex" : "hidden lg:flex"}`}
            >
              <FilePane
                file={fileObj}
                kind={kind}
                packName={selectedName}
                text={fileText}
                fileUrl={fileUrl}
                loadingText={loadingText}
                editing={editing}
                editText={editText}
                readOnly={readOnly}
                onEdit={() => { setEditText(fileText); setEditing(true); }}
                onCancelEdit={() => setEditing(false)}
                onChangeEdit={setEditText}
                onSave={saveFile}
                onClose={closeFile}
                onBackMobile={() => setMobilePane("files")}
                onOpenVersions={() => {
                  setVersionsOpen(true);
                  setMobilePane("files");
                }}
              />
              {dragActive && !readOnly && (
                <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed border-[var(--primary)] bg-[var(--bg-card)]/80 text-sm font-medium text-[var(--ink)] backdrop-blur-[1px]">
                  Drop files to add them{folderPath.length ? ` to ${folderPath.join("/")}` : ""}
                </div>
              )}
            </section>
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

// ===========================================================================
// Pack row in the left rail.
// ===========================================================================

function PackRow({
  ctx,
  selected,
  compact,
  onSelect,
  onDelete,
}: {
  ctx: ContextSummary;
  selected: boolean;
  compact: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyLink(e: React.MouseEvent) {
    e.stopPropagation();
    const url = `${window.location.origin}${BRAIN_ROUTE}?pack=${encodeURIComponent(ctx.name)}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }}
      className={`group relative flex w-full items-start gap-2.5 px-3 py-3 text-left transition-colors cursor-pointer ${
        selected ? "bg-[var(--active-nav-bg)] border-l-2 border-l-[var(--border-default)]" : "hover:bg-muted/40"
      }`}
      title={compact ? ctx.name : undefined}
    >
      <span className="mt-0.5 text-muted-foreground">{selected ? "●" : "○"}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{ctx.name}</span>
          {!compact && ctx.read_only && (
            <span
              className="inline-flex items-center gap-0.5 rounded-[var(--radius-pill)] border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0"
              title="Read-only system pack"
            >
              <Lock className="size-2.5" />
              Read-only
            </span>
          )}
        </span>
        {!compact && ctx.description && (
          <span className="block truncate text-xs text-muted-foreground mt-0.5">{ctx.description}</span>
        )}
        {!compact && (
          <span className="block text-xs text-muted-foreground mt-0.5">
            {ctx.file_count} {ctx.file_count === 1 ? "file" : "files"} · {ctx.worker_count} {ctx.worker_count === 1 ? "worker" : "workers"}
          </span>
        )}
      </span>
      {!compact && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
          <button type="button" onClick={copyLink} className="p-1 rounded-[var(--radius-button)] hover:bg-muted" title="Copy link to this pack">
            {copied ? <Check className="size-3.5 text-[var(--success)]" /> : <LinkIcon className="size-3.5 text-muted-foreground" />}
          </button>
          {!ctx.read_only && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-1 rounded-[var(--radius-button)] hover:bg-muted"
              title={`Delete ${ctx.name}`}
            >
              <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Pack detail pane (default 2-pane mode): metadata header + miller columns.
// ===========================================================================

function PackDetailPane({
  detail,
  folderColumns,
  folderPath,
  dragActive,
  readOnly,
  mobileVisible,
  onBackMobile,
  onOpenFolder,
  onOpenFile,
  onDeleteFile,
  onAddFile,
  dropHandlers,
}: {
  detail: ContextDetail;
  folderColumns: { folder: string; entries: Entry[] }[];
  folderPath: string[];
  dragActive: boolean;
  readOnly: boolean;
  mobileVisible: boolean;
  onBackMobile: () => void;
  onOpenFolder: (levelIndex: number, folderPath: string) => void;
  onOpenFile: (path: string) => void;
  onDeleteFile: (path: string) => void;
  onAddFile: () => void;
  dropHandlers: Partial<{
    onDragEnter: React.DragEventHandler<HTMLElement>;
    onDragOver: React.DragEventHandler<HTMLElement>;
    onDragLeave: React.DragEventHandler<HTMLElement>;
    onDrop: React.DragEventHandler<HTMLElement>;
  }>;
}) {
  const [packLinkCopied, setPackLinkCopied] = useState(false);

  function copyPackLink() {
    const url = `${window.location.origin}${BRAIN_ROUTE}?pack=${encodeURIComponent(detail.name)}`;
    navigator.clipboard.writeText(url).then(() => {
      setPackLinkCopied(true);
      setTimeout(() => setPackLinkCopied(false), 1500);
    });
  }

  return (
    <section
      {...dropHandlers}
      className={`relative flex-1 overflow-hidden flex-col min-w-0 transition-colors ${
        dragActive && !readOnly ? "bg-muted/30" : ""
      } ${mobileVisible ? "flex" : "hidden lg:flex"}`}
    >
      {/* Pack header / metadata (used-by chips live here) */}
      <div className="min-h-[82px] shrink-0 border-b border-[var(--border-default)] px-5 py-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold min-w-0">
            <button
              type="button"
              onClick={onBackMobile}
              className="lg:hidden p-1 -ml-1 rounded-[var(--radius-button)] hover:bg-muted text-muted-foreground"
              title="Back to packs"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="truncate">{detail.name}</span>
            {readOnly && (
              <span
                className="inline-flex items-center gap-0.5 rounded-[var(--radius-pill)] border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0"
                title="Read-only system pack"
              >
                <Lock className="size-2.5" />
                Read-only
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={copyPackLink}
            className="p-1 rounded-[var(--radius-button)] hover:bg-muted text-muted-foreground transition-colors shrink-0"
            title="Copy link to this pack"
          >
            {packLinkCopied ? <Check className="size-3.5 text-[var(--success)]" /> : <LinkIcon className="size-3.5" />}
          </button>
        </div>
        {readOnly && (
          <p className="mt-2 text-xs text-muted-foreground">
            This is a Floom Workers engine pack. It shapes how workers are generated and is read-only.
          </p>
        )}
        {detail.description ? (
          <p className="text-sm text-muted-foreground mt-0.5">{detail.description}</p>
        ) : (
          <p className="text-xs text-muted-foreground mt-0.5 italic">No description. Add a README.md to this pack.</p>
        )}

        <div className="flex flex-wrap items-center gap-3 mt-3">
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Files</span>
            <span className="text-xs font-medium">{detail.file_count}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5 min-w-0">
            <span className="text-xs text-muted-foreground shrink-0">Used by</span>
            {(detail.used_by ?? []).length === 0 ? (
              <span className="text-xs text-muted-foreground italic">none yet</span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
                {(detail.used_by ?? []).map((ref, i, arr) => (
                  <span key={ref.worker_id} className="inline-flex items-center min-w-0">
                    <Link href={`/workers/${encodeURIComponent(ref.worker_id)}`} className="text-xs font-medium hover:underline truncate">
                      {ref.worker_name}
                    </Link>
                    {i < arr.length - 1 && <span className="text-xs text-muted-foreground ml-1.5">·</span>}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Size</span>
            <span className="text-xs font-medium">{formatBytes(detail.total_size_bytes)}</span>
          </div>
        </div>
      </div>

      {/* Files toolbar */}
      <div className="flex items-center justify-between px-5 py-2.5 border-b border-[var(--border-default)] shrink-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</p>
        {readOnly ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="size-3" />
            Read-only — uploads disabled
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={onAddFile} className="h-7 text-xs gap-1">
            <Plus className="size-3.5" />
            Add file
          </Button>
        )}
      </div>

      {/* Miller columns — one column per folder level, horizontally scrollable */}
      {detail.files.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="rounded-[var(--radius-button)] border border-dashed border-[var(--border-default)] p-6 text-center">
            {readOnly ? (
              <p className="text-sm text-muted-foreground">This system pack has no files.</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">This pack is empty. Add a file to get started.</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={onAddFile}>
                  <Plus className="size-4" />
                  Add file
                </Button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-x-auto min-h-0">
          {folderColumns.map((col, level) => (
            <FolderColumn
              key={col.folder || "__root__"}
              level={level}
              entries={col.entries}
              isLast={level === folderColumns.length - 1}
              activeChildFolder={folderPath[level] ? folderColumns[level + 1]?.folder ?? null : null}
              selectedFile={null}
              readOnly={readOnly}
              onOpenFolder={onOpenFolder}
              onOpenFile={onOpenFile}
              onDeleteFile={onDeleteFile}
            />
          ))}
        </div>
      )}

      {/* Full-pane drop overlay (covers the whole detail pane, including the
          miller columns) so a drop anywhere over a writable pack uploads.
          pointer-events-none lets the underlying drag events keep firing. */}
      {dragActive && !readOnly && (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed border-[var(--primary)] bg-[var(--bg-card)]/80 text-sm font-medium text-[var(--ink)] backdrop-blur-[1px]">
          Drop files to add them{folderPath.length ? ` to ${folderPath.join("/")}` : ""}
        </div>
      )}
    </section>
  );
}

// ===========================================================================
// Folder columns wrapper used in the 3-pane (file-open) mode. Renders the
// miller columns compressed in the 20% middle region.
// ===========================================================================

function FolderColumns({
  detail,
  folderColumns,
  folderPath,
  selectedFile,
  compact,
  onBackMobile,
  onOpenFolder,
  onOpenFile,
}: {
  detail: ContextDetail;
  folderColumns: { folder: string; entries: Entry[] }[];
  folderPath: string[];
  selectedFile: string | null;
  compact: boolean;
  onBackMobile: () => void;
  onOpenFolder: (levelIndex: number, folderPath: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="flex flex-col w-full min-w-0">
      <div className="flex h-[82px] shrink-0 items-center gap-1.5 border-b border-[var(--border-default)] px-3 py-2.5">
        <button
          type="button"
          onClick={onBackMobile}
          className="lg:hidden p-1 -ml-1 rounded-[var(--radius-button)] hover:bg-muted text-muted-foreground"
          title="Back to packs"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="min-w-0">
          <p className="text-xs font-medium truncate">{detail.name}</p>
          <p className="text-xs text-muted-foreground">Files</p>
        </div>
      </div>
      <div className="flex-1 flex overflow-x-auto min-h-0">
        {folderColumns.map((col, level) => (
          <FolderColumn
            key={col.folder || "__root__"}
            level={level}
            entries={col.entries}
            isLast={level === folderColumns.length - 1}
            activeChildFolder={folderPath[level] ? folderColumns[level + 1]?.folder ?? null : null}
            selectedFile={selectedFile}
            readOnly
            compact={compact}
            onOpenFolder={onOpenFolder}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// A single miller column listing entries of one folder level.
// ===========================================================================

function FolderColumn({
  level,
  entries,
  isLast,
  activeChildFolder,
  selectedFile,
  readOnly,
  compact,
  onOpenFolder,
  onOpenFile,
  onDeleteFile,
}: {
  level: number;
  entries: Entry[];
  isLast: boolean;
  activeChildFolder: string | null;
  selectedFile: string | null;
  readOnly: boolean;
  compact?: boolean;
  onOpenFolder: (levelIndex: number, folderPath: string) => void;
  onOpenFile: (path: string) => void;
  onDeleteFile?: (path: string) => void;
}) {
  return (
    <div
      className={`flex flex-col h-full overflow-y-auto shrink-0 ${
        isLast ? "flex-1 min-w-[180px]" : "w-[40%] min-w-[160px] border-r border-[var(--border-default)]"
      }`}
    >
      {entries.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">Empty folder.</p>
      ) : (
        <div className="py-1">
          {entries.map((entry) =>
            entry.kind === "folder" ? (
              <button
                key={`dir:${entry.path}`}
                type="button"
                onClick={() => onOpenFolder(level, entry.path)}
                className={`group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  activeChildFolder === entry.path ? "bg-[var(--active-nav-bg)]" : "hover:bg-muted/40"
                }`}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-mono">{entry.name}</span>
                  {!compact && (
                    <span className="block text-xs text-muted-foreground">
                      {entry.fileCount} {entry.fileCount === 1 ? "file" : "files"} · {formatBytes(entry.size)}
                    </span>
                  )}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            ) : (
              <div
                key={`file:${entry.file.path}`}
                className={`group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors cursor-pointer ${
                  selectedFile === entry.file.path ? "bg-[var(--active-nav-bg)]" : "hover:bg-muted/40"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onOpenFile(entry.file.path)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {displayTypeIcon(fileDisplayType(entry.file))}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-mono">{entry.name}</span>
                    {!compact && (
                      <>
                        <span className="block text-xs text-muted-foreground truncate">
                          {formatBytes(entry.file.size)} · {fileDisplayType(entry.file)}
                        </span>
                        <FileTagChips file={entry.file} compact />
                      </>
                    )}
                  </span>
                </button>
                {!compact && !readOnly && onDeleteFile && (
                  <button
                    type="button"
                    onClick={() => onDeleteFile(entry.file.path)}
                    className="p-1 rounded-[var(--radius-button)] hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    title="Delete file"
                  >
                    <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// File content pane (the 70% right pane). Opens in place — no navigation.
// ===========================================================================

function FilePane({
  file,
  kind,
  packName,
  text,
  fileUrl,
  loadingText,
  editing,
  editText,
  readOnly,
  onEdit,
  onCancelEdit,
  onChangeEdit,
  onSave,
  onClose,
  onBackMobile,
  onOpenVersions,
}: {
  file: ContextFileItem | null;
  kind: FileKind | null;
  packName: string;
  text: string;
  fileUrl: string;
  loadingText: boolean;
  editing: boolean;
  editText: string;
  readOnly: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onChangeEdit: (v: string) => void;
  onSave: () => void;
  onClose: () => void;
  onBackMobile: () => void;
  onOpenVersions: () => void;
}) {
  const [fileLinkCopied, setFileLinkCopied] = useState(false);
  if (!file) return null;

  function copyFileLink() {
    if (!file) return;
    const url = `${window.location.origin}${BRAIN_ROUTE}?pack=${encodeURIComponent(packName)}&file=${encodeURIComponent(file.path)}`;
    navigator.clipboard.writeText(url).then(() => {
      setFileLinkCopied(true);
      setTimeout(() => setFileLinkCopied(false), 1500);
    });
  }

  const canEdit = isKnownTextFile(file) && !readOnly;
  const displayType = fileDisplayType(file);

  return (
    <>
      {/* Breadcrumb + actions */}
      <div className="flex h-[82px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border-default)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={onBackMobile}
              className="lg:hidden p-1 -ml-1 rounded-[var(--radius-button)] hover:bg-muted text-muted-foreground shrink-0"
              title="Back to files"
            >
              <ChevronLeft className="size-4" />
            </button>
            {displayTypeIcon(displayType)}
            <span className="font-mono text-sm font-medium truncate">{file.path.split("/").pop()}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{displayType}</span>
            <span aria-hidden className="opacity-40">·</span>
            <span>{formatBytes(file.size)}</span>
            {file.updated_at && (
              <>
                <span aria-hidden className="opacity-40">·</span>
                <span className="truncate">{formatDate(file.updated_at)}</span>
              </>
            )}
          </div>
          <FileTagChips file={file} compact />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {canEdit && !editing && (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onEdit}>
              <Edit3 className="size-3.5" />
              Edit
            </Button>
          )}
          {editing && (
            <>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onCancelEdit}>
                <X className="size-3.5" />
                Cancel
              </Button>
              <Button size="sm" className="h-7 text-xs gap-1" onClick={onSave}>
                <Save className="size-3.5" />
                Save
              </Button>
            </>
          )}
          {!editing && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              onClick={onOpenVersions}
              title="View this file's earlier revisions"
            >
              <History className="size-3.5" />
              History
            </Button>
          )}
          <button
            type="button"
            onClick={copyFileLink}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-default)] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="Copy link to this file"
          >
            {fileLinkCopied ? <Check className="size-3.5 text-[var(--success)]" /> : <LinkIcon className="size-3.5" />}
          </button>
          <a
            href={fileUrl}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-default)] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            title="Download"
          >
            <Download className="size-3.5" />
          </a>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Close preview" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0">
        {loadingText ? (
          <div className="p-4 space-y-2">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-4 w-full rounded-[var(--radius-button)]" />)}
          </div>
        ) : editing ? (
          <Textarea
            value={editText}
            onChange={(e) => onChangeEdit(e.target.value)}
            className="w-full h-full min-h-[400px] resize-none border-0 rounded-none font-mono text-xs leading-6 outline-none focus-visible:ring-0 focus-visible:ring-offset-0 p-4"
          />
        ) : (
          <FileContent file={file} packName={packName} kind={kind} text={text} fileUrl={fileUrl} />
        )}
      </div>
    </>
  );
}

function FileContent({
  file,
  packName,
  kind,
  text,
  fileUrl,
}: {
  file: ContextFileItem;
  packName: string;
  kind: FileKind | null;
  text: string;
  fileUrl: string;
}) {
  if (!kind) return null;

  const canPreviewLargeFile =
    kind === "image" || kind === "pdf" || kind === "video" || kind === "spreadsheet";
  if (file.size > TEXT_PREVIEW_LIMIT && !canPreviewLargeFile) {
    return (
      <div className="p-4 space-y-3 text-sm">
        <p className="text-muted-foreground">File is too large to preview inline ({formatBytes(file.size)}).</p>
        <a href={fileUrl} className="inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--border-default)] px-3 py-1.5 text-sm hover:bg-muted">
          <Download className="size-4" />
          Download
        </a>
      </div>
    );
  }

  if (kind === "markdown") {
    return (
      <PreviewRawTabs
        preview={
          <div className="mx-auto max-w-3xl px-6 py-6">
            <MarkdownRenderer content={text} />
          </div>
        }
        raw={<RawText text={text} />}
      />
    );
  }

  if (kind === "code") {
    return (
      <PreviewRawTabs
        preview={<CodeBlock text={text} filePath={file.path} />}
        raw={<RawText text={text} />}
      />
    );
  }

  if (kind === "html") {
    return (
      <PreviewRawTabs
        previewClassName="bg-white"
        preview={
          <iframe
            title={file.path}
            srcDoc={text}
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-full min-h-[600px] w-full border-0 bg-white"
          />
        }
        raw={<CodeBlock text={text} filePath={file.path} />}
      />
    );
  }

  if (kind === "table") {
    return (
      <PreviewRawTabs
        preview={<DelimitedTablePreview text={text} path={file.path} />}
        raw={<RawText text={text} />}
      />
    );
  }

  if (kind === "spreadsheet") {
    return <SpreadsheetPreview packName={packName} file={file} />;
  }

  if (kind === "image") {
    return (
      <ContextFileObjectUrl packName={packName} file={file}>
        {(src) => (
          <div className="flex items-center justify-center p-6 min-h-[300px] bg-muted/20">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={file.path} className="max-h-[600px] max-w-full object-contain rounded-[var(--radius-button)]" />
          </div>
        )}
      </ContextFileObjectUrl>
    );
  }

  if (kind === "pdf") {
    return <PdfPreview packName={packName} file={file} fileUrl={fileUrl} />;
  }

  if (kind === "video") {
    return (
      <ContextFileObjectUrl packName={packName} file={file}>
        {(src) => (
          <div className="flex h-full min-h-[420px] items-center justify-center bg-muted/20 p-6">
            <video src={src} controls className="max-h-[650px] max-w-full rounded-[var(--radius-button)] border border-[var(--border-default)] bg-black">
              <a href={fileUrl}>Download video</a>
            </video>
          </div>
        )}
      </ContextFileObjectUrl>
    );
  }

  return (
    <div className="p-4 space-y-3 text-sm">
      <p className="text-muted-foreground">{fileDisplayType(file)} file · {formatBytes(file.size)}</p>
      <a href={fileUrl} className="inline-flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--border-default)] px-3 py-1.5 text-sm hover:bg-muted">
        <Download className="size-4" />
        Download
      </a>
    </div>
  );
}

// Shared Preview/Raw shell for the text-like file kinds (markdown, code, html,
// table). Keeps the tab strip, spacing, and surface identical across kinds
// instead of each viewer re-declaring its own slightly different version.
function PreviewRawTabs({
  preview,
  raw,
  previewClassName = "",
}: {
  preview: ReactNode;
  raw: ReactNode;
  previewClassName?: string;
}) {
  return (
    <Tabs defaultValue="preview" className="flex h-full flex-col">
      <div className="shrink-0 border-b border-[var(--border-default)] px-4 pt-2">
        <TabsList variant="line" className="h-8">
          <TabsTrigger value="preview" className="text-xs">Preview</TabsTrigger>
          <TabsTrigger value="raw" className="text-xs">Raw</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="preview" className={`mt-0 flex-1 overflow-auto p-0 ${previewClassName}`}>
        {preview}
      </TabsContent>
      <TabsContent value="raw" className="mt-0 flex-1 overflow-auto p-0">
        {raw}
      </TabsContent>
    </Tabs>
  );
}

function RawText({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-foreground">{text}</pre>
  );
}

function DelimitedTablePreview({ text, path }: { text: string; path: string }) {
  const parsed = useMemo(() => {
    const delimiter = path.toLowerCase().endsWith(".tsv") ? "\t" : undefined;
    return Papa.parse<string[]>(text, {
      delimiter,
      skipEmptyLines: true,
    }).data;
  }, [path, text]);

  if (parsed.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">No rows found.</p>;
  }

  return <TablePreview rows={parsed} />;
}

function ContextFileObjectUrl({
  packName,
  file,
  children,
}: {
  packName: string;
  file: ContextFileItem;
  children: (src: string) => ReactNode;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fileUrl = api.contexts.fileUrl(packName, file.path);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    setSrc("");
    setError(null);
    api.contexts.fetchFileBlob(packName, file.path)
      .then((blob) => {
        const nextUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        objectUrl = nextUrl;
        setSrc(nextUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Download failed");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [packName, file.path, reloadKey]);

  if (error) {
    return (
      <PreviewUnavailable
        title={`${fileDisplayType(file)} preview unavailable`}
        detail={`The file is listed in this Brain pack, but the file endpoint returned: ${error}. This usually means the file bytes are missing, the selected workspace changed, or the file was deleted after the list loaded.`}
        fileUrl={fileUrl}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }

  if (!src) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-4 w-full rounded-[var(--radius-button)]" />)}
      </div>
    );
  }

  return <>{children(src)}</>;
}

function PdfPreview({
  packName,
  file,
  fileUrl,
}: {
  packName: string;
  file: ContextFileItem;
  fileUrl: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPageCount(null);

    async function renderFirstPage() {
      try {
        const [pdfjs, blob] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          api.contexts.fetchFileBlob(packName, file.path),
        ]);
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/legacy/build/pdf.worker.mjs",
          import.meta.url,
        ).toString();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        const cleanupPdf = async () => {
          const destroy = (pdf as unknown as { destroy?: () => Promise<void> | void }).destroy;
          if (destroy) await destroy.call(pdf);
        };
        if (cancelled) {
          await cleanupPdf();
          return;
        }

        setPageCount(pdf.numPages);
        const page = await pdf.getPage(1);
        if (cancelled) {
          await cleanupPdf();
          return;
        }

        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) throw new Error("Canvas is unavailable.");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        await cleanupPdf();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not render PDF preview.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void renderFirstPage();
    return () => {
      cancelled = true;
    };
  }, [packName, file.path, reloadKey]);

  if (error) {
    return (
      <PreviewUnavailable
        title="PDF preview unavailable"
        detail={`The PDF could not be fetched or rendered inline: ${error}. The file is still available for download.`}
        fileUrl={fileUrl}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-[600px] flex-col bg-muted/20">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-2 text-xs text-muted-foreground">
        <span>{pageCount ? `Page 1 of ${pageCount}` : "Rendering PDF preview"}</span>
        <a
          href={fileUrl}
          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] px-2.5 text-xs hover:bg-muted"
        >
          <Download className="size-3.5" />
          Download
        </a>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {loading && (
          <div className="space-y-2">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-4 w-full rounded-[var(--radius-button)]" />)}
          </div>
        )}
        <canvas
          ref={canvasRef}
          className={`mx-auto max-w-full rounded-[var(--radius-button)] bg-white shadow-[var(--shadow-sm)] ${loading ? "invisible" : ""}`}
        />
      </div>
    </div>
  );
}

function SpreadsheetPreview({ packName, file }: { packName: string; file: ContextFileItem }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fileUrl = api.contexts.fileUrl(packName, file.path);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const [{ default: JSZip }, blob] = await Promise.all([
          import("jszip"),
          api.contexts.fetchFileBlob(packName, file.path),
        ]);
        const zip = await JSZip.loadAsync(await blob.arrayBuffer());
        const sheetName = Object.keys(zip.files)
          .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
          .sort()[0];
        if (!sheetName) throw new Error("Workbook has no visible worksheet XML.");

        const [sheetXml, sharedXml] = await Promise.all([
          zip.file(sheetName)?.async("text"),
          zip.file("xl/sharedStrings.xml")?.async("text"),
        ]);
        if (!sheetXml) throw new Error("Worksheet data is empty.");
        const nextRows = parseXlsxSheet(sheetXml, sharedXml ?? "");
        if (!cancelled) setRows(nextRows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not preview spreadsheet.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [packName, file.path, reloadKey]);

  if (loading) {
    return (
      <div className="p-4 space-y-2">
        {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-4 w-full rounded-[var(--radius-button)]" />)}
      </div>
    );
  }

  if (error) {
    return (
      <PreviewUnavailable
        title="Spreadsheet preview unavailable"
        detail={`The workbook could not be fetched or parsed: ${error}. XLSX files still remain downloadable from this Brain pack.`}
        fileUrl={fileUrl}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }

  return <TablePreview rows={rows} />;
}

function PreviewUnavailable({
  title,
  detail,
  fileUrl,
  onRetry,
}: {
  title: string;
  detail: string;
  fileUrl: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full min-h-[260px] items-center justify-center p-6">
      <div className="max-w-lg rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-5 text-sm shadow-sm">
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-2 leading-6 text-muted-foreground">{detail}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onRetry}>
            <RotateCcw className="size-3.5" />
            Retry
          </Button>
          <a
            href={fileUrl}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] px-3 text-sm hover:bg-muted"
          >
            <Download className="size-3.5" />
            Download
          </a>
        </div>
      </div>
    </div>
  );
}

// Per-file version history. Each brain-pack file is snapshotted independently
// on the backend (asset_type `brain_file`), so this lists the revisions of ONE
// file and restores only THAT file — not the whole pack. Restore writes the
// chosen revision's content back via the normal save path (which records a new
// snapshot), so it is limited to text files (the only kind that carries an
// inline, diffable content body here).
function BrainFileVersionsPane({
  packName,
  selectedFile,
  currentFileContent,
  readOnly,
  onClose,
  onRestored,
}: {
  packName: string;
  selectedFile: ContextFileItem;
  currentFileContent: string;
  readOnly: boolean;
  onClose: () => void;
  onRestored: (restoredContent: string) => void;
}) {
  const selectedFilePath = selectedFile.path;
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedSnapshot, setExpandedSnapshot] = useState<VersionFileSnapshot | null>(null);
  const [loadingExpand, setLoadingExpand] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<VersionSummary | null>(null);

  const canRestore = isKnownTextFile(selectedFile) && !readOnly;

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await api.contexts.listFileVersions(packName, selectedFilePath));
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [packName, selectedFilePath]);

  useEffect(() => { void loadVersions(); }, [loadVersions]);

  async function handleExpand(v: VersionSummary) {
    if (expandedId === v.id) {
      setExpandedId(null);
      setExpandedSnapshot(null);
      return;
    }
    setLoadingExpand(v.id);
    try {
      const detail = await api.contexts.getFileVersion(packName, selectedFilePath, v.id);
      setExpandedSnapshot(detail.file ?? null);
      setExpandedId(v.id);
    } catch {
      toast.error("Failed to load version");
    } finally {
      setLoadingExpand(null);
    }
  }

  async function handleRestore(v: VersionSummary) {
    setPendingRestore(null);
    setRestoring(v.id);
    try {
      const detail = await api.contexts.getFileVersion(packName, selectedFilePath, v.id);
      const snapshot = detail.file;
      if (!snapshot || snapshot.deleted) {
        toast.error("This snapshot recorded the file as deleted and can't be restored inline.");
        return;
      }
      if (snapshot.encoding === "base64") {
        toast.error("Restoring binary file revisions isn't supported yet.");
        return;
      }
      const restoredContent = snapshot.content ?? "";
      await api.contexts.saveTextFile(packName, selectedFilePath, restoredContent);
      onRestored(restoredContent);
      toast.success(`Restored ${selectedFileName} to v${v.version_number}`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoring(null);
    }
  }

  const selectedFileName = selectedFilePath.split("/").pop() ?? selectedFilePath;
  const expandedFiles = expandedSnapshot
    ? [{ path: selectedFilePath, content: expandedSnapshot.content ?? "" }]
    : null;
  const currentFiles = [{ path: selectedFilePath, content: currentFileContent }];

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-[82px] shrink-0 items-center justify-between gap-3 border-b border-[var(--border-default)] px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Version history</h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            <span className="font-mono">{selectedFileName}</span> · earlier revisions of this file
          </p>
        </div>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Close version history" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-5">
        <div className="mb-3 rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Current file</p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{selectedFilePath}</p>
            </div>
            <span className="rounded-[var(--radius-pill)] bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Current
            </span>
          </div>
        </div>
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full rounded-[var(--radius-card)]" />)}
          </div>
        ) : versions.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
            <p className="text-sm font-medium">No earlier revisions of this file yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              A revision is saved here each time this file is edited, replaced, or deleted.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)]">
            {versions.map((v) => (
              <div key={v.id} className="border-b border-[var(--border-default)] last:border-b-0">
                <div
                  className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-muted/40"
                  onClick={() => { void handleExpand(v); }}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">v{v.version_number}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {v.change_source} · {formatDate(v.created_at)}
                    </p>
                  </div>
                  {loadingExpand === v.id
                    ? <Skeleton className="size-4 rounded-full" />
                    : <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${expandedId === v.id ? "rotate-90" : ""}`} />}
                </div>
                {expandedId === v.id && expandedFiles && (
                  <VersionDiffPanel
                    versionNumber={v.version_number}
                    versionFiles={expandedFiles}
                    currentFiles={currentFiles}
                    isRestoring={restoring === v.id}
                    canRestore={canRestore}
                    onRestore={() => setPendingRestore(v)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <Dialog open={Boolean(pendingRestore)} onOpenChange={(open) => { if (!open && !restoring) setPendingRestore(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Restore this file?</DialogTitle>
            <DialogDescription>
              This replaces the current contents of <span className="font-mono">{selectedFileName}</span> with
              v{pendingRestore?.version_number}. Other files in {packName} are untouched, and the current contents
              are saved as a new revision first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRestore(null)} disabled={Boolean(restoring)}>
              Cancel
            </Button>
            <Button
              onClick={() => { if (pendingRestore) void handleRestore(pendingRestore); }}
              disabled={Boolean(restoring)}
            >
              {restoring ? "Restoring..." : `Restore to v${pendingRestore?.version_number ?? ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TablePreview({ rows }: { rows: string[][] }) {
  const visibleRows = rows.slice(0, TABLE_PREVIEW_ROWS);
  const colCount = Math.min(
    TABLE_PREVIEW_COLS,
    Math.max(...visibleRows.map((row) => row.length), 1)
  );

  return (
    <div className="overflow-auto">
      <table className="min-w-full border-collapse text-left text-xs">
        <tbody>
          {visibleRows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? "bg-muted/60 font-medium" : "odd:bg-muted/20"}>
              {Array.from({ length: colCount }).map((_, colIndex) => (
                <td key={colIndex} className="max-w-[260px] border border-[var(--border-default)] px-2.5 py-1.5 align-top">
                  <span className="block truncate" title={row[colIndex] ?? ""}>
                    {row[colIndex] ?? ""}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(rows.length > TABLE_PREVIEW_ROWS || rows.some((row) => row.length > TABLE_PREVIEW_COLS)) && (
        <p className="border-t border-[var(--border-default)] px-3 py-2 text-xs text-muted-foreground">
          Showing first {Math.min(rows.length, TABLE_PREVIEW_ROWS)} rows and {colCount} columns.
        </p>
      )}
    </div>
  );
}

function parseXlsxSheet(sheetXml: string, sharedXml: string): string[][] {
  const parser = new DOMParser();
  const sharedDoc = sharedXml ? parser.parseFromString(sharedXml, "application/xml") : null;
  const sharedStrings = sharedDoc
    ? Array.from(sharedDoc.querySelectorAll("si")).map((node) =>
        Array.from(node.querySelectorAll("t")).map((part) => part.textContent ?? "").join("")
      )
    : [];
  const sheetDoc = parser.parseFromString(sheetXml, "application/xml");
  const rows: string[][] = [];

  for (const row of Array.from(sheetDoc.querySelectorAll("sheetData row")).slice(0, TABLE_PREVIEW_ROWS)) {
    const cells: string[] = [];
    for (const cell of Array.from(row.querySelectorAll("c")).slice(0, TABLE_PREVIEW_COLS)) {
      const ref = cell.getAttribute("r") ?? "";
      const colIndex = Math.min(columnIndexFromCellRef(ref), TABLE_PREVIEW_COLS - 1);
      const type = cell.getAttribute("t");
      const valueNode = cell.querySelector("v");
      let value = valueNode?.textContent ?? "";
      if (type === "s") {
        value = sharedStrings[Number(value)] ?? value;
      } else if (type === "inlineStr") {
        value = Array.from(cell.querySelectorAll("is t")).map((part) => part.textContent ?? "").join("");
      }
      cells[colIndex] = value;
    }
    rows.push(cells);
  }

  return rows;
}

function columnIndexFromCellRef(ref: string): number {
  const letters = (ref.match(/[A-Z]+/i)?.[0] ?? "A").toUpperCase();
  let index = 0;
  for (const char of letters) {
    index = index * 26 + char.charCodeAt(0) - 64;
  }
  return Math.max(index - 1, 0);
}

function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:border prose-pre:border-[var(--border-default)] prose-pre:rounded-[var(--radius-button)] prose-pre:text-foreground prose-pre:[&_code]:text-foreground prose-code:bg-muted prose-code:text-foreground prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono prose-blockquote:border-l prose-blockquote:border-[var(--border-default)] prose-blockquote:not-italic prose-headings:font-semibold prose-headings:tracking-tight">
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
