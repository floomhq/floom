"use client";

import { useId, useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import type { WorkerConnectionSpec } from "@/lib/types";
import {
  connectionSpecApp,
  connectionSpecAllowedTools,
  setComposioAllowlist,
  addConnection,
  removeConnection,
} from "@/lib/worker-manifest";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { ChipPreviewDialog, type ChipPreviewTarget } from "@/components/worker/ChipPreviewDialog";

export interface ToolAppOption {
  slug: string;
  name: string;
}

interface WorkerToolsEditorProps {
  connections: WorkerConnectionSpec[];
  editable: boolean;
  busy?: boolean;
  /**
   * Apps the user can pick from in the Add-tool combobox (B4): the workspace's
   * existing connections + the integrations catalog. Parent supplies; the
   * editor filters out already-connected apps and type-to-filters the rest.
   */
  availableApps?: ToolAppOption[];
  /**
   * Known tool names for an app, used to render the per-app allowlist as a
   * multiselect of real tools instead of a free-text comma string (B4). Returns
   * an empty array when the catalog is unknown — the editor then falls back to
   * "All tools" with no restrict affordance.
   */
  toolsForApp?: (slug: string) => string[];
  /** Emits the next connections list; parent persists to worker.yml. */
  onChange: (next: WorkerConnectionSpec[]) => void;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/**
 * Controlled Tools editor (SPEC §11 + round-09 B4):
 *  - Add tool = a searchable combobox over EXISTING connections / catalog apps
 *    (type-to-filter, select from filtered) — never a free-text slug input.
 *  - Per-app allowlist = a multiselect of that app's known tools (deferred
 *    commit: onChange fires ONCE on close, only on a real net change — kills the
 *    phantom "Tools updated" toast a no-op blur used to emit).
 *  - empty allowlist = full access (never emits [], see lib/worker-manifest).
 */
export function WorkerToolsEditor({
  connections,
  editable,
  busy,
  availableApps = [],
  toolsForApp,
  onChange,
}: WorkerToolsEditorProps) {
  const [preview, setPreview] = useState<ChipPreviewTarget | null>(null);

  // Add-tool combobox state.
  const [comboOpen, setComboOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const listboxId = useId();

  // Per-app allowlist editor: which app's allowlist is open, plus its pending
  // selection (deferred commit).
  const [allowlistApp, setAllowlistApp] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);

  const connectedKeys = useMemo(
    () => new Set(connections.map((s) => (connectionSpecApp(s) || "").toLowerCase())),
    [connections],
  );

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return availableApps
      .filter((a) => !connectedKeys.has(a.slug.toLowerCase()))
      .filter((a) => !q || a.slug.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
  }, [availableApps, connectedKeys, query]);

  const commitAdd = () => {
    if (!picked) return;
    const next = addConnection(connections, picked);
    setPicked(null);
    setQuery("");
    setComboOpen(false);
    if (next !== connections) onChange(next);
  };

  const openAllowlist = (app: string, current: string[] | null) => {
    setAllowlistApp(app);
    setPending(current ?? []);
  };

  const closeAllowlist = (commit: boolean) => {
    const app = allowlistApp;
    const spec = app
      ? connections.find((s) => (connectionSpecApp(s) || "").toLowerCase() === app.toLowerCase())
      : undefined;
    const original = spec ? connectionSpecAllowedTools(spec) ?? [] : [];
    setAllowlistApp(null);
    // Only emit on a real net change — opening/closing or toggling back to the
    // original set must NOT re-emit (the old onBlur did, firing a phantom toast).
    if (commit && app && !sameSet(pending, original)) {
      onChange(setComposioAllowlist(connections, app, pending.length ? pending : null));
    }
  };

  const togglePending = (tool: string) => {
    setPending((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));
  };

  return (
    <div>
      <div className="c-ltable">
        {connections.map((spec, i) => {
          const app = connectionSpecApp(spec) ?? `tool-${i}`;
          const tools = connectionSpecAllowedTools(spec);
          const known = toolsForApp?.(app) ?? [];
          const canRestrict = editable && known.length > 0;
          const isOpen = allowlistApp?.toLowerCase() === app.toLowerCase();
          return (
            <div key={app} className="c-lrow" style={{ gridTemplateColumns: "1fr auto", gap: 12 }}>
              <div className="c-lprimary" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                <button
                  type="button"
                  className="c-lp-tx"
                  style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", minWidth: 0 }}
                  title={`See ${app} actions`}
                  onClick={() => setPreview({ kind: "integration", app })}
                >
                  <span className="c-logo">
                    <BrandLogo icon={app} className="size-4" />
                  </span>
                  <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span className="nm" style={{ display: "block", textTransform: "capitalize", textDecoration: "underline", textUnderlineOffset: 2, textDecorationColor: "var(--border)" }}>
                      {app}
                    </span>
                    <span className="sub" style={{ display: "block" }}>
                      {tools ? `${tools.length} tool(s) allowed` : "All tools"}
                    </span>
                  </span>
                </button>

                {/* Allowlist: a LABELED multiselect of the app's known tools,
                    not an unlabeled comma string (B4). */}
                {editable && (
                  <div style={{ position: "relative" }}>
                    {canRestrict ? (
                      <button
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded={isOpen}
                        aria-controls={`${listboxId}-${app}`}
                        className="c-srch"
                        style={{ maxWidth: 360, padding: "6px 10px", display: "inline-flex", alignItems: "center", gap: 6 }}
                        disabled={busy}
                        onClick={() => (isOpen ? closeAllowlist(true) : openAllowlist(app, tools))}
                        title={`Restrict which ${app} tools this worker may use`}
                      >
                        <span style={{ textTransform: "capitalize" }}>{`Restrict ${app} tools`}</span>
                        <ChevronDown size={13} className="shrink-0" />
                      </button>
                    ) : (
                      <span className="sub" style={{ fontSize: 12 }}>
                        All tools (catalog unavailable)
                      </span>
                    )}
                    {isOpen && (
                      <div
                        id={`${listboxId}-${app}`}
                        role="listbox"
                        aria-label={`${app} allowed tools`}
                        aria-multiselectable="true"
                        className="absolute left-0 top-full z-20 mt-1 max-h-56 w-[260px] overflow-auto rounded-[var(--radius-card)] bg-[var(--bg-card)] p-1 shadow-[var(--shadow-pop)] [border:var(--bd-card)]"
                      >
                        <p className="px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                          Allowed {app} tools
                        </p>
                        {known.map((t) => {
                          const on = pending.includes(t);
                          return (
                            <button
                              key={t}
                              type="button"
                              role="option"
                              aria-selected={on}
                              className={`flex w-full items-center gap-2 rounded-[var(--radius-button)] px-2.5 py-1.5 text-left text-sm ${
                                on ? "text-foreground" : "text-muted-foreground hover:bg-[var(--bg-2)] hover:text-foreground"
                              }`}
                              onClick={() => togglePending(t)}
                            >
                              <span className="flex size-4 items-center justify-center shrink-0">
                                {on && <Check size={13} />}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{t}</span>
                            </button>
                          );
                        })}
                        <div className="mt-1 flex justify-end px-1 pb-1">
                          <button type="button" className="c-addbtn" onClick={() => closeAllowlist(true)}>
                            Done
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
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
          {/* Add tool = searchable combobox over existing connections / catalog
              apps (B4). Type-to-filter, select from filtered — never free-type. */}
          <div className="relative min-w-[240px] max-w-[300px] flex-1">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={comboOpen}
              aria-controls={listboxId}
              aria-label="Add a tool"
              className="c-srch w-full justify-between text-left"
              style={{ display: "flex", alignItems: "center", gap: 6 }}
              disabled={busy}
              onClick={() => setComboOpen((v) => !v)}
            >
              <span className={picked ? "text-foreground" : "text-muted-foreground"}>
                {picked ? (availableApps.find((a) => a.slug === picked)?.name ?? picked) : "Select a tool to add..."}
              </span>
              <ChevronDown size={14} className="shrink-0" />
            </button>
            {comboOpen && (
              <div
                id={listboxId}
                role="listbox"
                aria-label="Available tools"
                className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-hidden rounded-[var(--radius-card)] bg-[var(--bg-card)] p-1 shadow-[var(--shadow-pop)] [border:var(--bd-card)]"
              >
                <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
                  <Search size={14} className="shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    aria-label="Search tools"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                    placeholder="Search your connections..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <div className="max-h-52 overflow-auto [border-top:var(--bd-div)] pt-1">
                  {candidates.length === 0 ? (
                    <p className="px-2.5 py-3 text-sm text-muted-foreground">
                      {availableApps.length === 0 ? "No connections yet." : "No matching tools."}
                    </p>
                  ) : (
                    candidates.map((a) => (
                      <button
                        key={a.slug}
                        type="button"
                        role="option"
                        aria-selected={a.slug === picked}
                        className={`flex w-full items-center gap-2 rounded-[var(--radius-button)] px-2.5 py-2 text-left text-sm ${
                          a.slug === picked
                            ? "bg-[var(--bg-2)] text-foreground"
                            : "text-muted-foreground hover:bg-[var(--bg-2)] hover:text-foreground"
                        }`}
                        onClick={() => {
                          setPicked(a.slug);
                          setComboOpen(false);
                          setQuery("");
                        }}
                      >
                        <span className="c-logo">
                          <BrandLogo icon={a.slug} className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            className="c-addbtn"
            disabled={busy || !picked}
            onClick={commitAdd}
          >
            <Plus size={14} /> Add tool
          </button>
        </div>
      )}

      <ChipPreviewDialog target={preview} onOpenChange={(o) => !o && setPreview(null)} />
    </div>
  );
}
