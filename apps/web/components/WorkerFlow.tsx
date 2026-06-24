"use client";

import { useLayoutEffect, useRef, useState } from "react";
import {
  FileText,
  Table,
  Type,
  Globe,
  Hash,
  ToggleLeft,
  List,
  Clock,
} from "lucide-react";
import { type WorkerIconInput } from "@/lib/worker-icon";

// ---------------------------------------------------------------------------
// WorkerFlow — a flat, native node-graph of a worker's pipeline, rendered in
// the worker detail "Flow" group. Replaces the monospace WorkerAsciiDiagram.
//
// Built DETERMINISTICALLY from worker config (NO LLM): declared inputs become
// source nodes, the worker becomes the central processing node (showing a
// `score(...)`-style signature + its connected tools), declared outputs become
// destination nodes. Curved SVG connectors are drawn between MEASURED port
// centers (useLayoutEffect + ResizeObserver) so they stay aligned for any
// number of inputs/outputs (1, 2, 3+) and survive label truncation.
//
// Native design system: flat (no borders, no shadows) — surfaces are bg-2/bg-3
// fills + hairline dividers; the function signature is monospace; accent is not
// used. Same prop contract as WorkerAsciiDiagram so the call site is unchanged.
// ---------------------------------------------------------------------------

type FlowNode = { name?: string; label?: string; type?: string };

export interface WorkerFlowProps {
  workerName: string;
  worker?: WorkerIconInput;
  inputs?: FlowNode[];
  outputs?: FlowNode[];
  connections?: string[];
  triggerType?: string;
  className?: string;
}

// type → lucide glyph element (shared vocabulary with the worker pills).
// Returns a rendered element (not a component) so it can be used inline in
// render without tripping react-hooks/static-components.
function glyphFor(type?: string) {
  const p = { style: { width: 13, height: 13 }, strokeWidth: 1.6 } as const;
  const t = (type || "").toLowerCase();
  if (t.includes("csv") || t.includes("table") || t.includes("sheet")) return <Table {...p} />;
  if (t.includes("json") || t.includes("object") || t.includes("array") || t.includes("list")) return <List {...p} />;
  if (t.includes("url") || t.includes("web") || t.includes("link")) return <Globe {...p} />;
  if (t.includes("number") || t.includes("int") || t.includes("float")) return <Hash {...p} />;
  if (t.includes("bool")) return <ToggleLeft {...p} />;
  if (t.includes("trigger") || t.includes("cron") || t.includes("schedule")) return <Clock {...p} />;
  if (t.includes("file") || t.includes("pdf") || t.includes("doc") || t.includes("md") || t.includes("markdown")) return <FileText {...p} />;
  return <Type {...p} />;
}

function nodeLabel(n: FlowNode): string {
  return (n.label || n.name || "item").trim();
}
function nodeSub(n: FlowNode): string {
  return (n.type || "").trim();
}

const ink = "var(--ink)";
const inkSoft = "var(--ink-soft)";
const muted = "var(--muted-foreground)";
const bg2 = "var(--bg-2)";
const bg3 = "var(--bg-3)";
const bgCard = "var(--bg-card)";
const div = "var(--bd-div)";
const mono = "var(--font-mono)";

type Pt = { x: number; y: number };

export function WorkerFlow({
  workerName,
  inputs,
  outputs,
  connections,
  triggerType,
  className,
}: WorkerFlowProps) {
  // Fallbacks keep 0-input / 0-output workers rendering a clean graph.
  const inNodes: FlowNode[] =
    inputs && inputs.length > 0 ? inputs : [{ label: friendlyTrigger(triggerType), type: "trigger" }];
  const outNodes: FlowNode[] = outputs && outputs.length > 0 ? outputs : [{ label: "Result", type: "text" }];
  const tools = (connections ?? []).map((c) => c.trim()).filter(Boolean);

  const wrapRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<HTMLDivElement>(null);
  const inRefs = useRef<(HTMLDivElement | null)[]>([]);
  const outRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [dots, setDots] = useState<Pt[]>([]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const worker = workerRef.current;
    if (!wrap || !worker) return;

    const compute = () => {
      const wb = wrap.getBoundingClientRect();
      const k = worker.getBoundingClientRect();
      const wLeft: Pt = { x: k.left - wb.left, y: k.top - wb.top + k.height / 2 };
      const wRight: Pt = { x: k.right - wb.left, y: k.top - wb.top + k.height / 2 };

      const nextPaths: string[] = [];
      const nextDots: Pt[] = [wLeft, wRight];

      inRefs.current.forEach((el) => {
        if (!el) return;
        const b = el.getBoundingClientRect();
        const from: Pt = { x: b.right - wb.left, y: b.top - wb.top + b.height / 2 };
        nextPaths.push(curve(from, wLeft));
        nextDots.push(from);
      });
      outRefs.current.forEach((el) => {
        if (!el) return;
        const b = el.getBoundingClientRect();
        const to: Pt = { x: b.left - wb.left, y: b.top - wb.top + b.height / 2 };
        nextPaths.push(curve(wRight, to));
        nextDots.push(to);
      });

      setPaths(nextPaths);
      setDots(nextDots);
    };

    compute();
    // ResizeObserver is undefined in jsdom / older runtimes — guard it.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(compute);
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(inNodes), JSON.stringify(outNodes), tools.join(",")]);

  const workerLabel = `score(${inNodes[0]?.name || "candidate"}, rubric)`;

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: 0, overflowX: "auto" }}
    >
      {/* connectors behind the nodes */}
      <svg
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
      >
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="color-mix(in srgb, var(--ink) 24%, transparent)" strokeWidth={1.5} />
        ))}
        {dots.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.6} fill="color-mix(in srgb, var(--ink) 24%, transparent)" />
        ))}
      </svg>

      {/* inputs */}
      <div style={{ display: "flex", flexDirection: "column", gap: 9, flex: "none", position: "relative", zIndex: 1 }}>
        {inNodes.map((n, i) => (
          <FlowNodeCard key={i} node={n} nodeRef={(el) => (inRefs.current[i] = el)} />
        ))}
      </div>

      {/* connector gap (visual breathing room; lines are absolute) */}
      <div style={{ width: 34, flex: "none" }} />

      {/* worker */}
      <div
        ref={workerRef}
        style={{ borderRadius: 10, background: bg2, minWidth: 176, flex: "none", overflow: "hidden", position: "relative", zIndex: 1 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 13px", borderBottom: div, background: bg3 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {workerName}
          </span>
        </div>
        <div style={{ padding: "11px 13px 9px", fontFamily: mono, fontSize: 12.5, color: ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          <span style={{ fontWeight: 600 }}>score</span>
          <span style={{ color: inkSoft }}>{workerLabel.replace("score", "")}</span>
        </div>
        {tools.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 12px 11px", flexWrap: "wrap" }}>
            {tools.slice(0, 4).map((t) => (
              <span
                key={t}
                style={{ height: 18, borderRadius: 5, background: bgCard, color: inkSoft, display: "inline-flex", alignItems: "center", padding: "0 7px", fontSize: 9.5, fontWeight: 500, fontFamily: mono }}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ width: 34, flex: "none" }} />

      {/* outputs */}
      <div style={{ display: "flex", flexDirection: "column", gap: 9, flex: "none", position: "relative", zIndex: 1 }}>
        {outNodes.map((n, i) => (
          <FlowNodeCard key={i} node={n} nodeRef={(el) => (outRefs.current[i] = el)} />
        ))}
      </div>
    </div>
  );
}

function FlowNodeCard({ node, nodeRef }: { node: FlowNode; nodeRef: (el: HTMLDivElement | null) => void }) {
  const sub = nodeSub(node);
  return (
    <div
      ref={nodeRef}
      style={{ borderRadius: 9, background: bg2, padding: "8px 10px", width: 112, display: "flex", alignItems: "center", gap: 9 }}
    >
      <span style={{ width: 22, height: 22, borderRadius: 6, background: bgCard, color: muted, display: "grid", placeItems: "center", flex: "none" }}>
        {glyphFor(node.type)}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: ink, fontWeight: 500, lineHeight: 1.1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {nodeLabel(node)}
        </div>
        {sub && (
          <div style={{ fontSize: 9, color: muted, marginTop: 2, textTransform: "uppercase", letterSpacing: ".05em", fontFamily: mono }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

function curve(from: Pt, to: Pt): string {
  const midX = (from.x + to.x) / 2;
  return `M${from.x} ${from.y} C ${midX} ${from.y} ${midX} ${to.y} ${to.x} ${to.y}`;
}

function friendlyTrigger(value?: string | null): string {
  const raw = (value || "").trim();
  if (!raw) return "Trigger";
  if (raw === "cron") return "Schedule";
  if (raw === "composio") return "Event";
  return raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
