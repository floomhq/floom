"use client";

import { useId, useState } from "react";
import { ChevronDown, Folder, Plus, X } from "lucide-react";
import type { WorkerContextSpec } from "@/lib/types";
import {
  contextSpecName,
  contextSpecWritable,
  setContextWriteable,
  toggleContext,
} from "@/lib/worker-manifest";

interface WorkerBrainEditorProps {
  contexts: WorkerContextSpec[];
  availablePacks: { name: string }[];
  editable: boolean;
  busy?: boolean;
  /** Emits the next contexts list; parent persists to worker.yml. */
  onChange: (next: WorkerContextSpec[]) => void;
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
}: WorkerBrainEditorProps) {
  const [attach, setAttach] = useState("");
  const [open, setOpen] = useState(false);
  const listboxId = useId();
  const attachedNames = new Set(contexts.map(contextSpecName));
  const unattached = availablePacks.filter((p) => !attachedNames.has(p.name));
  const selected = unattached.find((p) => p.name === attach);

  return (
    <div>
      <div className="c-ltable">
        {contexts.map((spec) => {
          const name = contextSpecName(spec);
          const writeable = contextSpecWritable(spec);
          return (
            <div key={name} className="c-lrow" style={{ gridTemplateColumns: "1fr auto auto", gap: 12 }}>
              <div className="c-lprimary">
                <span className="c-logo">
                  <Folder size={15} />
                </span>
                <div className="c-lp-tx">
                  <div className="nm">{name}</div>
                </div>
              </div>
              {editable ? (
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
              {editable && (
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  className="x"
                  disabled={busy}
                  onClick={() => onChange(toggleContext(contexts, name))}
                >
                  <X size={15} />
                </button>
              )}
            </div>
          );
        })}
        {contexts.length === 0 && (
          <div style={{ color: "var(--muted-foreground)", padding: 14 }}>No brain folders attached.</div>
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
                {unattached.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    role="option"
                    aria-selected={p.name === attach}
                    className={`flex w-full items-center gap-2 rounded-[var(--radius-button)] px-2.5 py-2 text-left text-sm ${
                      p.name === attach
                        ? "bg-[var(--bg-2)] text-foreground"
                        : "text-muted-foreground hover:bg-[var(--bg-2)] hover:text-foreground"
                    }`}
                    onClick={() => {
                      setAttach(p.name);
                      setOpen(false);
                    }}
                  >
                    <Folder size={14} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  </button>
                ))}
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
    </div>
  );
}
