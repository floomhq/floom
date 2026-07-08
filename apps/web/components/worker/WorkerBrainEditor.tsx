"use client";

import { useId, useMemo, useState } from "react";
import { Brain, ChevronDown, ChevronRight, Folder, Plus, X } from "lucide-react";
import type { WorkerContextSpec } from "@/lib/types";
import {
  contextSpecName,
  contextSpecWritable,
  setContextWriteable,
  toggleContext,
} from "@/lib/worker-manifest";
import { ChipPreviewDialog, type ChipPreviewTarget } from "@/components/worker/ChipPreviewDialog";

/**
 * brain_packs (library folders) have NO parent/path column — `name` is a flat
 * `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` string (no "/"), so there is no literal
 * folder hierarchy to render. What DOES exist in practice is a naming
 * convention: packs sharing a "<prefix>-..." lead segment (most commonly the
 * engine's own `memory-<worker-id>` folders) are conceptually one group. This
 * mirrors the grouping already shipped in the full Library view
 * (`isWorkerMemoryPack` / `MemoryPackGroup` in app/contexts/page.tsx) —
 * extracted here as a name-prefix tree so the attach-folder picker groups the
 * same way instead of listing every worker's memory folder flat.
 */
export type PackTreeNode =
  | { kind: "leaf"; pack: { name: string } }
  | { kind: "group"; prefix: string; packs: { name: string }[] };

function packPrefix(name: string): string | null {
  const idx = name.indexOf("-");
  if (idx <= 0 || idx === name.length - 1) return null;
  return name.slice(0, idx);
}

/** Group packs sharing a "<prefix>-*" lead segment (>=2 members); singletons stay flat leaves. */
export function buildPackTree(packs: { name: string }[]): PackTreeNode[] {
  const byPrefix = new Map<string, { name: string }[]>();
  for (const p of packs) {
    const prefix = packPrefix(p.name);
    if (!prefix) continue;
    const list = byPrefix.get(prefix) ?? [];
    list.push(p);
    byPrefix.set(prefix, list);
  }
  const emitted = new Set<string>();
  const nodes: PackTreeNode[] = [];
  for (const p of packs) {
    const prefix = packPrefix(p.name);
    const siblings = prefix ? byPrefix.get(prefix) : undefined;
    if (prefix && siblings && siblings.length >= 2) {
      if (!emitted.has(prefix)) {
        emitted.add(prefix);
        nodes.push({ kind: "group", prefix, packs: siblings });
      }
      continue;
    }
    nodes.push({ kind: "leaf", pack: p });
  }
  return nodes;
}

interface WorkerBrainEditorProps {
  contexts: WorkerContextSpec[];
  availablePacks: { name: string }[];
  editable: boolean;
  busy?: boolean;
  /** Emits the next contexts list; parent persists to worker.yml. */
  onChange: (next: WorkerContextSpec[]) => void;
  /**
   * Per-worker memory folder name. When set and that folder is NOT yet attached,
   * the editor surfaces a one-click "Add memory folder" affordance that creates
   * (if needed) the writeable folder and wires it to this worker's brain — so a
   * worker is connected to its own memory by default ("Used by 0" → this worker).
   */
  memoryFolderName?: string;
  /** Creates the memory folder if missing and attaches it (read & write). */
  onAttachMemory?: () => void | Promise<void>;
  /**
   * True when `memoryFolderName` is the worker's OWN memory context AND memory
   * is enabled. The engine force-pins that context to writeable and re-mounts it
   * on every save (models._normalize_memory_contexts), so a Read/Read-&-write
   * toggle or a detach on it is a silent no-op that still fires a success toast.
   * When set, that one row renders a locked "Read & write" state instead of the
   * misleading interactive controls. Disable the worker's memory to remove it.
   */
  memoryPinned?: boolean;
}

/**
 * Controlled Brain editor (SPEC §11): attached folders with a per-folder
 * Read-only / Read-&-write toggle + Attach/Remove. Pure value→onChange; the
 * yaml/save logic lives in the parent via lib/worker-manifest.
 */
export function WorkerBrainEditor({
  contexts,
  availablePacks,
  editable,
  busy,
  onChange,
  memoryFolderName,
  onAttachMemory,
  memoryPinned,
}: WorkerBrainEditorProps) {
  const [attach, setAttach] = useState("");
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  // #1303: read-only preview popup for a clicked brain-folder chip.
  const [preview, setPreview] = useState<ChipPreviewTarget | null>(null);
  const listboxId = useId();
  const attachedNames = new Set(contexts.map(contextSpecName));
  const unattached = availablePacks.filter((p) => !attachedNames.has(p.name));
  const selected = unattached.find((p) => p.name === attach);
  const packTree = useMemo(() => buildPackTree(unattached), [unattached]);
  const toggleGroup = (prefix: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  const memoryAttached = Boolean(memoryFolderName && attachedNames.has(memoryFolderName));
  const showMemoryCta = Boolean(editable && memoryFolderName && onAttachMemory && !memoryAttached);

  return (
    <div>
      {showMemoryCta && (
        // #1254: button shows "Connecting..." + spinner while busy so the user
        // gets immediate visual feedback that the action is in progress.
        <button
          type="button"
          className="mb-3 flex w-full items-center gap-3 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-2)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-3)] disabled:opacity-60"
          disabled={busy}
          onClick={() => void onAttachMemory?.()}
        >
          <span className="c-logo">
            {busy ? (
              <svg
                className="animate-spin"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <Brain size={15} />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">
              {busy ? "Connecting..." : "Connect a memory folder"}
            </span>
            {!busy && (
              <span className="block text-xs text-muted-foreground">
                Give this worker a writeable <span className="font-mono">{memoryFolderName}</span> folder it
                can read and write across runs.
              </span>
            )}
          </span>
          {!busy && <Plus size={15} className="shrink-0 text-muted-foreground" />}
        </button>
      )}
      <div className="c-ltable">
        {contexts.map((spec) => {
          const name = contextSpecName(spec);
          const writeable = contextSpecWritable(spec);
          // The worker's own memory folder is pinned writeable + non-detachable
          // by the engine; show a locked state rather than controls that revert.
          const isPinnedMemory = Boolean(memoryPinned && memoryFolderName && name === memoryFolderName);
          return (
            <div key={name} className="c-lrow" style={{ gridTemplateColumns: "1fr auto auto", gap: 12 }}>
              <button
                type="button"
                className="c-lprimary"
                style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
                title={`Preview ${name}`}
                onClick={() => setPreview({ kind: "brain", name })}
              >
                <span className="c-logo">
                  <Folder size={15} />
                </span>
                <div className="c-lp-tx">
                  <div className="nm" style={{ textDecoration: "underline", textUnderlineOffset: 2, textDecorationColor: "var(--border)" }}>{name}</div>
                </div>
              </button>
              {isPinnedMemory ? (
                <span
                  className="c-vpill"
                  title="This worker's memory is always read & write. Disable the worker's memory to remove it."
                >
                  Read &amp; write
                </span>
              ) : editable ? (
                <div className="c-vtog" role="group" aria-label={`${name} access`}>
                  <button
                    type="button"
                    className={!writeable ? "on" : ""}
                    disabled={busy}
                    onClick={() => onChange(setContextWriteable(contexts, name, false))}
                  >
                    Read
                  </button>
                  <button
                    type="button"
                    className={writeable ? "on" : ""}
                    disabled={busy}
                    onClick={() => onChange(setContextWriteable(contexts, name, true))}
                  >
                    Read &amp; write
                  </button>
                </div>
              ) : (
                <span className="c-vpill">{writeable ? "Read & write" : "Read only"}</span>
              )}
              {editable && !isPinnedMemory ? (
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  className="x"
                  disabled={busy}
                  onClick={() => onChange(toggleContext(contexts, name))}
                >
                  <X size={15} />
                </button>
              ) : (
                isPinnedMemory && <span aria-hidden="true" />
              )}
            </div>
          );
        })}
        {contexts.length === 0 && (
          <div style={{ color: "var(--muted-foreground)", padding: 14 }}>No library folders attached.</div>
        )}
      </div>

      {editable && unattached.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <div className="relative min-w-[220px] max-w-[280px] flex-1">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-controls={listboxId}
              className="c-srch w-full justify-between text-left"
              disabled={busy}
              onClick={() => setOpen((value) => !value)}
            >
              <span className={selected ? "text-foreground" : ""}>{selected?.name ?? "Attach a folder..."}</span>
              <ChevronDown size={14} className="shrink-0" />
            </button>
            {open && (
              <div
                id={listboxId}
                role="listbox"
                aria-label="Attach folder"
                className="absolute left-0 right-0 top-full z-20 mt-1 max-h-52 overflow-auto rounded-[var(--radius-card)] bg-[var(--bg-card)] p-1 shadow-[var(--shadow-pop)] [border:var(--bd-card)]"
              >
                {packTree.map((node) =>
                  node.kind === "leaf" ? (
                    <PackOption
                      key={node.pack.name}
                      name={node.pack.name}
                      selected={node.pack.name === attach}
                      onSelect={() => {
                        setAttach(node.pack.name);
                        setOpen(false);
                      }}
                    />
                  ) : (
                    <div key={node.prefix} role="group" aria-label={`${node.prefix} folders`}>
                      <button
                        type="button"
                        aria-expanded={openGroups.has(node.prefix)}
                        className="flex w-full items-center gap-2 rounded-[var(--radius-button)] px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-[var(--bg-2)] hover:text-foreground"
                        onClick={() => toggleGroup(node.prefix)}
                      >
                        {openGroups.has(node.prefix) ? (
                          <ChevronDown size={14} className="shrink-0" />
                        ) : (
                          <ChevronRight size={14} className="shrink-0" />
                        )}
                        <Folder size={14} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{node.prefix}</span>
                        <span className="shrink-0 text-xs">{node.packs.length}</span>
                      </button>
                      {openGroups.has(node.prefix) && (
                        <div className="ml-2 pl-2 [border-left:var(--bd-div)]">
                          {node.packs.map((p) => (
                            <PackOption
                              key={p.name}
                              name={p.name}
                              selected={p.name === attach}
                              onSelect={() => {
                                setAttach(p.name);
                                setOpen(false);
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="c-addbtn"
            disabled={busy || !attach}
            onClick={() => {
              if (!attach) return;
              onChange(toggleContext(contexts, attach));
              setAttach("");
            }}
          >
            <Plus size={14} /> Attach
          </button>
        </div>
      )}

      <ChipPreviewDialog target={preview} onOpenChange={(o) => !o && setPreview(null)} />
    </div>
  );
}

/** One selectable pack row inside the attach-folder tree (top-level leaf or nested group child). */
function PackOption({
  name,
  selected,
  onSelect,
}: {
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`flex w-full items-center gap-2 rounded-[var(--radius-button)] px-2.5 py-2 text-left text-sm ${
        selected
          ? "bg-[var(--bg-2)] text-foreground"
          : "text-muted-foreground hover:bg-[var(--bg-2)] hover:text-foreground"
      }`}
      onClick={onSelect}
    >
      <Folder size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </button>
  );
}
