"use client";

import { useState } from "react";
import { Folder, Plus, X } from "lucide-react";
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
  const attachedNames = new Set(contexts.map(contextSpecName));
  const unattached = availablePacks.filter((p) => !attachedNames.has(p.name));

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
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <select
            className="c-srch"
            aria-label="Attach folder"
            style={{ maxWidth: 280 }}
            value={attach}
            onChange={(e) => setAttach(e.target.value)}
          >
            <option value="">Attach a folder…</option>
            {unattached.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
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
