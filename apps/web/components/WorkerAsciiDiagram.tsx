import * as React from "react";
import { BrandLogo, normalizeBrandSlug } from "@/components/connections/BrandLogo";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// WorkerAsciiDiagram — a polished box-drawing flow diagram of a worker's
// pipeline, rendered on the worker detail About view.
//
// Federico (2026-05-29): "draw ascii for each worker, powered by these logos,
// on the description view — polished ascii where the lines are NOT dashed and
// fit our design system… basically a layer around ascii."
//
// This is NOT raw terminal output. It is an architecture diagram drawn in
// SOLID box-drawing characters (─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ▸), rendered in the app
// mono font, wrapped in the design system (--radius-card frame, --bg-card
// surface, --line hairline), and themed with design-system colors:
//   • input / output node text  → --ink
//   • connector rules / buses    → --ink-faint
//   • the worker node + trigger  → --accent
//   • connection nodes          → carry their real brand mark (BrandLogo) so
//                                  the diagram is "powered by the logos".
//
// The diagram is built DETERMINISTICALLY from the worker config (NO LLM). It is
// laid out on a fixed 2-D character grid (string matrix) so monospace alignment
// holds across widths and never misaligns. Long names truncate cleanly. The
// inputs converge into the worker via a single vertical bus (┬ ┤ ┴ junctions),
// and the worker fans out to the outputs the same way — so every line actually
// connects. 0-input / 0-output / 0-connection workers still render a clean,
// non-broken diagram (trigger → worker → result).
//
// Shape (left → right):
//
//   INPUTS                WORKER                 OUTPUTS
//   ┌──────────┐  ┬   ┌──────────────┐   ┬─▸ ┌──────────┐
//   │ ▸ repo   │──┤   │  github-…    │   │   │ ▸ digest │
//   └──────────┘  ┼─▸ │  ──────────  │ ─▸┤   └──────────┘
//   ┌──────────┐  │   │  scheduled   │   ┴─▸ ┌──────────┐
//   │ ▸ since  │──┴   └──────────────┘       │ ▸ report │
//   └──────────┘                             └──────────┘
//
// The connection brand logos are rendered as a real BrandLogo "engine" strip
// beneath the diagram — the ASCII gives structure, the logos give identity
// (the hybrid Federico asked for).
// ---------------------------------------------------------------------------

const B = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  arrow: "▸",
  teeL: "┤",
  teeR: "├",
  cross: "┼",
  up: "┴",
  down: "┬",
} as const;

type DiagramNode = { name?: string; label?: string; type?: string };

export interface WorkerAsciiDiagramProps {
  workerName: string;
  inputs?: DiagramNode[];
  outputs?: DiagramNode[];
  connections?: string[];
  triggerType?: string;
  className?: string;
}

// --- layout constants (all widths in monospace cells) ----------------------
const NODE_INNER = 16; // inner content width of input/output boxes
const NODE_W = NODE_INNER + 2; // full box width incl. borders
const WORKER_INNER = 18; // inner width of the central worker box
const NODE_ROWS = 3; // top / content / bottom
const GAP_ROWS = 1; // blank row between stacked nodes
const STUB = 2; // node→bus stub length
const ZONE_W = 6; // total connector-zone width per side

// --- helpers ---------------------------------------------------------------

function clip(s: string, w: number): string {
  const t = (s || "").trim();
  if (t.length <= w) return t;
  if (w <= 1) return t.slice(0, w);
  return `${t.slice(0, w - 1)}…`;
}

function nodeLabel(n: DiagramNode): string {
  return (n.label || n.name || n.type || "").trim();
}

function triggerWord(triggerType?: string): string {
  const t = (triggerType || "").toLowerCase();
  if (t === "schedule" || t === "cron" || t === "scheduled") return "scheduled";
  if (t === "webhook") return "webhook";
  if (t === "composio" || t === "event") return "event";
  return "manual";
}

function boxNode(label: string, innerWidth: number): [string, string, string] {
  const text = clip(label, innerWidth - 2); // room for "▸ "
  const padded = `${B.arrow} ${text}`.padEnd(innerWidth, " ");
  const horiz = B.h.repeat(innerWidth);
  return [
    `${B.tl}${horiz}${B.tr}`,
    `${B.v}${padded}${B.v}`,
    `${B.bl}${horiz}${B.br}`,
  ];
}

// A side column of stacked boxes, vertically centered within `total` rows.
function buildSideColumn(labels: string[], width: number, total: number): string[] {
  const rows: string[] = [];
  const blockH = labels.length * NODE_ROWS + (labels.length - 1) * GAP_ROWS;
  const topPad = Math.max(0, Math.floor((total - blockH) / 2));
  for (let i = 0; i < topPad; i++) rows.push(" ".repeat(width));
  labels.forEach((label, idx) => {
    const [a, b, c] = boxNode(label, width - 2);
    rows.push(a, b, c);
    if (idx < labels.length - 1) rows.push(" ".repeat(width));
  });
  while (rows.length < total) rows.push(" ".repeat(width));
  return rows;
}

// Row indices of each node's content (middle) row, for connector alignment.
function nodeCenterRows(labels: string[], total: number): number[] {
  const arr: number[] = [];
  const blockH = labels.length * NODE_ROWS + (labels.length - 1) * GAP_ROWS;
  const topPad = Math.max(0, Math.floor((total - blockH) / 2));
  let r = topPad;
  for (let i = 0; i < labels.length; i++) {
    arr.push(r + 1);
    r += NODE_ROWS + GAP_ROWS;
  }
  return arr;
}

// The central worker box: name / rule / trigger, vertically centered.
function buildWorkerColumn(
  name: string,
  trigger: string,
  total: number,
): { rows: string[]; centerRow: number } {
  const inner = WORKER_INNER;
  const horiz = B.h.repeat(inner);
  const center = (s: string) => {
    const t = clip(s, inner);
    const pad = inner - t.length;
    const l = Math.floor(pad / 2);
    return `${" ".repeat(l)}${t}${" ".repeat(pad - l)}`;
  };
  const lines = [
    `${B.tl}${horiz}${B.tr}`,
    `${B.v}${center(name)}${B.v}`,
    `${B.v}${center(B.h.repeat(Math.min(10, inner)))}${B.v}`,
    `${B.v}${center(trigger)}${B.v}`,
    `${B.bl}${horiz}${B.br}`,
  ];
  const rows: string[] = [];
  const topPad = Math.max(0, Math.floor((total - lines.length) / 2));
  for (let i = 0; i < topPad; i++) rows.push(" ".repeat(inner + 2));
  rows.push(...lines);
  while (rows.length < total) rows.push(" ".repeat(inner + 2));
  // The connector should enter on the visual middle of the box (the rule row).
  const centerRow = topPad + 2;
  return { rows, centerRow };
}

// Left connector zone: stubs from each input center to a vertical bus, then a
// single lead from the bus (at busRow) into the worker, arrow before worker.
function leftZone(centers: number[], busRow: number, total: number): string[] {
  const g: string[][] = Array.from({ length: total }, () => Array(ZONE_W).fill(" "));
  const busCol = STUB;
  // Single node aligned to the worker → clean straight rule, no bus.
  if (centers.length === 1 && centers[0] === busRow) {
    for (let x = 0; x < ZONE_W; x++) g[busRow][x] = x === ZONE_W - 1 ? B.arrow : B.h;
    return g.map((r) => r.join(""));
  }
  const mn = Math.min(...centers, busRow);
  const mx = Math.max(...centers, busRow);
  for (let r = mn; r <= mx; r++) g[r][busCol] = B.v;
  for (const c of centers) {
    for (let x = 0; x < busCol; x++) g[c][x] = B.h;
    g[c][busCol] = c === mn ? B.down : c === mx ? B.up : B.teeR;
  }
  for (let x = busCol; x < ZONE_W; x++) {
    if (x === busCol) g[busRow][busCol] = centers.includes(busRow) ? B.cross : B.teeR;
    else g[busRow][x] = x === ZONE_W - 1 ? B.arrow : B.h;
  }
  return g.map((r) => r.join(""));
}

// Right connector zone: lead from worker to the bus, then stubs out to each
// output center, with an arrow immediately before each output node.
function rightZone(centers: number[], busRow: number, total: number): string[] {
  const g: string[][] = Array.from({ length: total }, () => Array(ZONE_W).fill(" "));
  const busCol = ZONE_W - 1 - STUB;
  if (centers.length === 1 && centers[0] === busRow) {
    for (let x = 0; x < ZONE_W; x++) g[busRow][x] = x === ZONE_W - 1 ? B.arrow : B.h;
    return g.map((r) => r.join(""));
  }
  const mn = Math.min(...centers, busRow);
  const mx = Math.max(...centers, busRow);
  for (let r = mn; r <= mx; r++) g[r][busCol] = B.v;
  for (const c of centers) {
    for (let x = busCol + 1; x < ZONE_W; x++) g[c][x] = x === ZONE_W - 1 ? B.arrow : B.h;
    g[c][busCol] = c === mn ? B.down : c === mx ? B.up : B.teeL;
  }
  for (let x = 0; x <= busCol; x++) {
    if (x === busCol) g[busRow][busCol] = centers.includes(busRow) ? B.cross : B.teeL;
    else g[busRow][x] = B.h;
  }
  return g.map((r) => r.join(""));
}

// --- tone → design-system color --------------------------------------------
type Tone = "ink" | "soft" | "faint" | "accent";
function toneColor(tone: Tone): string {
  switch (tone) {
    case "accent":
      return "var(--accent)";
    case "ink":
      return "var(--ink)";
    case "soft":
      return "var(--ink-soft)";
    default:
      return "var(--ink-faint)";
  }
}

interface Cell {
  text: string;
  tone: Tone;
}

export function WorkerAsciiDiagram({
  workerName,
  inputs = [],
  outputs = [],
  connections = [],
  triggerType,
  className,
}: WorkerAsciiDiagramProps) {
  const conns = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of connections) {
      if (!c || typeof c !== "string") continue;
      const slug = normalizeBrandSlug(c);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
    }
    return out;
  }, [connections]);

  const { headerRow, gridRows } = React.useMemo(() => {
    const trigger = triggerWord(triggerType);

    // 0-input → a single trigger node so the flow is never a dangling box.
    const leftLabels =
      inputs.length === 0
        ? [`${trigger} trigger`]
        : inputs.map(nodeLabel).filter(Boolean);
    // 0-output → a single "result" node.
    const rightLabels =
      outputs.length === 0 ? ["result"] : outputs.map(nodeLabel).filter(Boolean);

    const leftH = leftLabels.length * NODE_ROWS + (leftLabels.length - 1) * GAP_ROWS;
    const rightH = rightLabels.length * NODE_ROWS + (rightLabels.length - 1) * GAP_ROWS;
    const total = Math.max(leftH, rightH, 5);

    const leftCol = buildSideColumn(leftLabels, NODE_W, total);
    const rightCol = buildSideColumn(rightLabels, NODE_W, total);
    const { rows: workerCol, centerRow } = buildWorkerColumn(
      clip(workerName, WORKER_INNER),
      trigger,
      total,
    );

    const leftCenters = nodeCenterRows(leftLabels, total);
    const rightCenters = nodeCenterRows(rightLabels, total);
    const leftConn = leftZone(leftCenters, centerRow, total);
    const rightConn = rightZone(rightCenters, centerRow, total);

    const rows: Cell[][] = [];
    for (let r = 0; r < total; r++) {
      rows.push([
        { text: leftCol[r], tone: "ink" },
        { text: leftConn[r], tone: "faint" },
        { text: workerCol[r], tone: "accent" },
        { text: rightConn[r], tone: "faint" },
        { text: rightCol[r], tone: "ink" },
      ]);
    }

    const headerCell = (text: string, width: number): string => {
      const t = clip(text, width);
      const pad = width - t.length;
      const l = Math.floor(pad / 2);
      return `${" ".repeat(l)}${t}${" ".repeat(pad - l)}`;
    };
    const header: Cell[] = [
      {
        text: headerCell(inputs.length === 0 ? "TRIGGER" : "INPUTS", NODE_W),
        tone: "soft",
      },
      { text: " ".repeat(ZONE_W), tone: "faint" },
      { text: headerCell("WORKER", WORKER_INNER + 2), tone: "soft" },
      { text: " ".repeat(ZONE_W), tone: "faint" },
      { text: headerCell("OUTPUTS", NODE_W), tone: "soft" },
    ];

    return { headerRow: header, gridRows: rows };
  }, [workerName, inputs, outputs, triggerType]);

  return (
    <section className={cn("space-y-3", className)}>
      <h2 className="text-base font-semibold text-foreground">Flow</h2>
      <div
        className="overflow-x-auto border border-[var(--line)] bg-[var(--bg-card)] px-5 py-4"
        style={{ borderRadius: "var(--radius-card)" }}
      >
        <pre
          aria-hidden="true"
          className="m-0 select-none"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "12px",
            lineHeight: "1.4",
            letterSpacing: "0",
            tabSize: 1,
          }}
        >
          <div style={{ marginBottom: "0.5em" }}>
            {headerRow.map((cell, i) => (
              <span
                key={`h-${i}`}
                style={{
                  color: cell.tone === "soft" ? "var(--ink-soft)" : "var(--ink-faint)",
                  whiteSpace: "pre",
                  fontWeight: 600,
                  letterSpacing: "0.1em",
                }}
              >
                {cell.text}
              </span>
            ))}
          </div>
          {gridRows.map((row, r) => (
            <div key={`r-${r}`}>
              {row.map((cell, c) => (
                <span
                  key={`c-${r}-${c}`}
                  style={{ color: toneColor(cell.tone), whiteSpace: "pre" }}
                >
                  {cell.text}
                </span>
              ))}
            </div>
          ))}
        </pre>

        {/* Logo "engine" strip — the worker's connection brand marks layered
            beneath the ASCII as the hybrid identity layer Federico asked for.
            Real BrandLogo SVGs (same vocabulary as WorkerIconPills). Hidden
            when the worker declares no connections. */}
        {conns.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-3">
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--ink-faint)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              powered by
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {conns.map((slug) => (
                <span
                  key={slug}
                  title={slug}
                  className="inline-flex items-center gap-1.5 border border-[var(--line-soft)] bg-[var(--bg-2)] px-1.5 py-1 text-[11px] text-[var(--ink-soft)]"
                  style={{ borderRadius: "var(--radius-squircle)" }}
                >
                  <BrandLogo icon={slug} className="size-3.5" />
                  <span className="capitalize">{slug.replace(/-/g, " ")}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
