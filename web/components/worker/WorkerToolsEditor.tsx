"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { WorkerConnectionSpec } from "@/lib/types";
import {
  connectionSpecApp,
  connectionSpecAllowedTools,
  setComposioAllowlist,
  addConnection,
  removeConnection,
} from "@/lib/worker-manifest";

interface WorkerToolsEditorProps {
  connections: WorkerConnectionSpec[];
  editable: boolean;
  busy?: boolean;
  /** Emits the next connections list; parent persists to worker.yml. */
  onChange: (next: WorkerConnectionSpec[]) => void;
}

/**
 * Controlled Tools editor (SPEC §11): connection list with Add tool, per-tool
 * allowlist (empty = full access — never emits [], see lib/worker-manifest),
 * and Remove. Pure value→onChange.
 */
export function WorkerToolsEditor({ connections, editable, busy, onChange }: WorkerToolsEditorProps) {
  const [adding, setAdding] = useState("");

  return (
    <div>
      <div className="c-ltable">
        {connections.map((spec, i) => {
          const app = connectionSpecApp(spec) ?? `tool-${i}`;
          const tools = connectionSpecAllowedTools(spec);
          return (
            <div key={app} className="c-lrow" style={{ gridTemplateColumns: "1fr auto", gap: 12 }}>
              <div className="c-lprimary" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                <div className="c-lp-tx">
                  <div className="nm" style={{ textTransform: "capitalize" }}>
                    {app}
                  </div>
                  <div className="sub">{tools ? `${tools.length} tool(s) allowed` : "All tools"}</div>
                </div>
                {editable && (
                  <input
                    key={(tools ?? []).join(",")}
                    className="c-srch"
                    aria-label={`${app} allowed tools`}
                    style={{ maxWidth: 360, padding: "6px 10px" }}
                    defaultValue={(tools ?? []).join(", ")}
                    placeholder="All tools (comma-separated to restrict)"
                    disabled={busy}
                    onBlur={(e) => {
                      const list = e.target.value
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean);
                      onChange(setComposioAllowlist(connections, app, list.length ? list : null));
                    }}
                  />
                )}
              </div>
              {editable && (
                <button
                  type="button"
                  aria-label={`Remove ${app}`}
                  className="x"
                  disabled={busy}
                  onClick={() => onChange(removeConnection(connections, app))}
                >
                  <X size={15} />
                </button>
              )}
            </div>
          );
        })}
        {connections.length === 0 && (
          <div style={{ color: "var(--muted-foreground)", padding: 14 }}>No tools connected.</div>
        )}
      </div>

      {editable && (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input
            className="c-srch"
            aria-label="Add tool"
            style={{ maxWidth: 280 }}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="App slug (e.g. github)"
            disabled={busy}
          />
          <button
            type="button"
            className="c-addbtn"
            disabled={busy || !adding.trim()}
            onClick={() => {
              const next = addConnection(connections, adding);
              setAdding("");
              if (next !== connections) onChange(next);
            }}
          >
            <Plus size={14} /> Add tool
          </button>
        </div>
      )}
    </div>
  );
}
