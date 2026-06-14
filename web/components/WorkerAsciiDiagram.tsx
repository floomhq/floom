import * as React from "react";
import {
  AlignLeft,
  Clock,
  FileText,
  Globe,
  Hash,
  List,
  Mail,
  Play,
  Sparkles,
  Table,
  ToggleLeft,
  Type,
  User,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { BrandLogo, normalizeBrandSlug } from "@/components/connections/BrandLogo";
import { workerIcon, type WorkerIconInput } from "@/lib/worker-icon";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// WorkerAsciiDiagram — a polished box-drawing flow diagram of a worker's
// pipeline, rendered on the worker detail About view.
//
// Federico (2026-05-29): "draw ascii for each worker, powered by these logos,
// on the description view — polished ascii where the lines are NOT dashed and
// fit our design system… basically a layer around ascii." Then (FIX 1):
// "no truncated text" + "show the type icons IN the visual".
//
// This is NOT raw terminal output. It is an architecture diagram drawn in
// SOLID box-drawing characters (─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼), rendered in the app
// mono font, wrapped in the design system (--radius-card frame, --bg-card
// surface, --line hairline), and themed with design-system colors:
//   • input / output node text  → --ink
//   • connector rules / buses    → --ink-faint
//   • the worker node + trigger  → --accent
//   • a type glyph (lucide) is overlaid on the LEADING cell of every input /
//     output / worker node (text→Type, file→FileText, person→User, web→Globe…)
//     so the diagram visually CARRIES the type icons, like the reference.
//   • connection brand logos      → the real BrandLogo "POWERED BY" strip below.
//
// NO TRUNCATION: every column sizes itself to its LONGEST label (capped at
// MAX_INNER cells), so labels read in full ("CV file (PDF, DOCX, TXT)",
// "Candidate Writeup", "Extracted Profile"). If the whole diagram is wider
// than the card it scrolls horizontally inside the framed card (overflow-x).
//
// ICON ALIGNMENT: the text grid is pure box-drawing (alignment never breaks).
// The lucide type glyphs are a SEPARATE absolute overlay positioned in `ch`
// units — `1ch` is exactly the monospace advance width, so each glyph lands on
// its node's leading inner cell with pixel-perfect grid alignment. The text
// grid reserves that leading cell (a blank slot) so the glyph never collides
// with the label. Box-drawing characters and connectors are untouched.
//
// Built DETERMINISTICALLY from the worker config (NO LLM), on a fixed 2-D
// character grid so monospace alignment holds. 0-input / 0-output / 0-connection
// workers still render a clean diagram (trigger → worker → result).
// ---------------------------------------------------------------------------

// M3 (Federico 2026-06-02 mobile audit): de-date the flow diagram by ROUNDING
// every inner node box. Federico's design rule forbids fully-square boxes. The
// rounded box-drawing corners (╭ ╮ ╰ ╯) are single monospace cells with the
// EXACT same advance width as the square corners (┌ ┐ └ ┘), so the character
// grid, connectors, and the `ch`-positioned glyph overlay stay pixel-aligned —
// only the corner silhouette softens. No diagram logic changes.
const B = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  h: "─",
  v: "│",
  teeL: "┤",
  teeR: "├",
  cross: "┼",
  up: "┴",
  down: "┬",
} as const;

type DiagramNode = { name?: string; label?: string; type?: string };

export interface WorkerAsciiDiagramProps {
  workerName: string;
  /**
   * Worker identity used to resolve the central worker-node glyph via the
   * shared workerIcon() resolver — so the diagram's worker node matches the
   * card + detail-header icon (consistent identity, no sparkle-for-everyone).
   * When omitted the node falls back to the trigger glyph.
   */
  worker?: WorkerIconInput;
  inputs?: DiagramNode[];
  outputs?: DiagramNode[];
  connections?: string[];
  triggerType?: string;
  className?: string;
}

// --- layout constants (all widths in monospace cells) ----------------------
const NODE_ROWS = 3; // top / content / bottom
const GAP_ROWS = 1; // blank row between stacked nodes
const STUB = 2; // node→bus stub length
const ZONE_W = 6; // total connector-zone width per side
const ICON_SLOT = 2; // leading cells reserved inside a box for the type glyph
const MIN_INNER = 12; // floor so short labels still look like boxes
const MAX_INNER = 40; // cap so a pathological label still scrolls, not explodes

// --- type → lucide glyph (shared vocabulary with WorkerIconPills) -----------
function nodeIcon(n: DiagramNode): LucideIcon {
  const t = (n.type || "").toLowerCase();
  const hint = `${n.name || ""} ${n.label || ""}`.toLowerCase();
  if (/\b(person|name|contact|author|owner|candidate|user)\b/.test(hint)) return User;
  if (/\b(email|e-mail)\b/.test(hint)) return Mail;
  if (/\b(url|link|website|domain|web)\b/.test(hint)) return Globe;
  if (/\b(csv|table|spreadsheet|rows?|columns?)\b/.test(hint)) return Table;
  if (/\b(file|pdf|docx?|attachment|document)\b/.test(hint)) return FileText;
  if (/\b(list|profile|items?|array)\b/.test(hint)) return List;
  switch (t) {
    case "textarea":
      return AlignLeft;
    case "number":
      return Hash;
    case "boolean":
      return ToggleLeft;
    case "select":
      return List;
    case "url":
      return Globe;
    case "email":
      return Mail;
    case "file":
      return FileText;
    case "text":
    case "string":
    default:
      return Type;
  }
}

function triggerGlyph(triggerType?: string): LucideIcon {
  const t = (triggerType || "").toLowerCase();
  if (t === "schedule" || t === "cron" || t === "scheduled") return Clock;
  if (t === "webhook") return Webhook;
  if (t === "composio" || t === "event") return Play;
  return Sparkles;
}

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

// Inner content width for a side column: the longest label + the icon slot,
// clamped to [MIN_INNER, MAX_INNER]. Sizing to content is what kills the
// truncation Federico flagged.
function columnInner(labels: string[]): number {
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
  return Math.min(MAX_INNER, Math.max(MIN_INNER, longest + ICON_SLOT + 1));
}

// A box node. The first ICON_SLOT cells are left blank (the lucide glyph is
// overlaid there); the label follows, clipped only at the (content-sized) cap.
function boxNode(label: string, innerWidth: number): [string, string, string] {
  const textRoom = innerWidth - ICON_SLOT - 1; // 1 trailing space breathing room
  const text = clip(label, textRoom);
  const content = `${" ".repeat(ICON_SLOT)}${text}`.padEnd(innerWidth, " ");
  const horiz = B.h.repeat(innerWidth);
  return [`${B.tl}${horiz}${B.tr}`, `${B.v}${content}${B.v}`, `${B.bl}${horiz}${B.br}`];
}

// A side column of stacked boxes, vertically centered within `total` rows.
function buildSideColumn(labels: string[], inner: number, total: number): string[] {
  const width = inner + 2;
  const rows: string[] = [];
  const blockH = labels.length * NODE_ROWS + (labels.length - 1) * GAP_ROWS;
  const topPad = Math.max(0, Math.floor((total - blockH) / 2));
  for (let i = 0; i < topPad; i++) rows.push(" ".repeat(width));
  labels.forEach((label, idx) => {
    const [a, b, c] = boxNode(label, inner);
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

// The central worker box: name / rule / trigger, vertically centered. Reserves
// the same leading icon slot on the name row for the worker glyph.
function buildWorkerColumn(
  name: string,
  trigger: string,
  inner: number,
  total: number,
): { rows: string[]; centerRow: number } {
  const horiz = B.h.repeat(inner);
  const center = (s: string) => {
    const t = clip(s, inner);
    const pad = inner - t.length;
    const l = Math.floor(pad / 2);
    return `${" ".repeat(l)}${t}${" ".repeat(pad - l)}`;
  };
  // Name row leaves the leading slot for the worker glyph, label left-aligned
  // after it so the glyph never overlaps text.
  const nameText = clip(name, inner - ICON_SLOT - 1);
  const nameRow = `${" ".repeat(ICON_SLOT)}${nameText}`.padEnd(inner, " ");
  const lines = [
    `${B.tl}${horiz}${B.tr}`,
    `${B.v}${nameRow}${B.v}`,
    `${B.v}${center(B.h.repeat(Math.min(10, inner)))}${B.v}`,
    `${B.v}${center(trigger)}${B.v}`,
    `${B.bl}${horiz}${B.br}`,
  ];
  const rows: string[] = [];
  const topPad = Math.max(0, Math.floor((total - lines.length) / 2));
  for (let i = 0; i < topPad; i++) rows.push(" ".repeat(inner + 2));
  rows.push(...lines);
  while (rows.length < total) rows.push(" ".repeat(inner + 2));
  // The connector enters on the visual middle of the box (the rule row).
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
    for (let x = 0; x < ZONE_W; x++) g[busRow][x] = B.h;
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
    else g[busRow][x] = B.h;
  }
  return g.map((r) => r.join(""));
}

// Right connector zone: lead from worker to the bus, then stubs out to each
// output center.
function rightZone(centers: number[], busRow: number, total: number): string[] {
  const g: string[][] = Array.from({ length: total }, () => Array(ZONE_W).fill(" "));
  const busCol = ZONE_W - 1 - STUB;
  if (centers.length === 1 && centers[0] === busRow) {
    for (let x = 0; x < ZONE_W; x++) g[busRow][x] = B.h;
    return g.map((r) => r.join(""));
  }
  const mn = Math.min(...centers, busRow);
  const mx = Math.max(...centers, busRow);
  for (let r = mn; r <= mx; r++) g[r][busCol] = B.v;
  for (const c of centers) {
    for (let x = busCol + 1; x < ZONE_W; x++) g[c][x] = B.h;
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

// An overlaid type glyph, positioned on the character grid in `ch`/`em` units.
interface IconMark {
  key: string;
  col: number; // absolute column (cells) of the glyph's leading edge
  row: number; // absolute row (lines) — 0 = first grid row
  Icon: LucideIcon;
  tone: Tone;
}

export function WorkerAsciiDiagram({
  workerName,
  worker,
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

  const { headerRow, gridRows, iconMarks } = React.useMemo(() => {
    const trigger = triggerWord(triggerType);

    // 0-input → a single trigger node so the flow is never a dangling box.
    const leftNodes: DiagramNode[] =
      inputs.length === 0
        ? [{ label: `${trigger} trigger`, type: triggerType }]
        : inputs.filter((n) => nodeLabel(n));
    // 0-output → a single "result" node.
    const rightNodes: DiagramNode[] =
      outputs.length === 0 ? [{ label: "result" }] : outputs.filter((n) => nodeLabel(n));

    const leftLabels = leftNodes.map(nodeLabel);
    const rightLabels = rightNodes.map(nodeLabel);

    const leftInner = columnInner(leftLabels);
    const rightInner = columnInner(rightLabels);
    const workerInner = Math.min(MAX_INNER, Math.max(18, workerName.length + ICON_SLOT + 1));

    const leftW = leftInner + 2;
    const workerW = workerInner + 2;

    const leftH = leftLabels.length * NODE_ROWS + (leftLabels.length - 1) * GAP_ROWS;
    const rightH = rightLabels.length * NODE_ROWS + (rightLabels.length - 1) * GAP_ROWS;
    const total = Math.max(leftH, rightH, 5);

    const leftCol = buildSideColumn(leftLabels, leftInner, total);
    const rightCol = buildSideColumn(rightLabels, rightInner, total);
    const { rows: workerCol, centerRow } = buildWorkerColumn(
      workerName,
      trigger,
      workerInner,
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

    // Absolute column offsets of each segment's leading edge (cells).
    const leftColStart = 0;
    const workerColStart = leftW + ZONE_W;
    const rightColStart = workerColStart + workerW + ZONE_W;
    // Header rows occupy line 0 (label) + line 1 (spacer) before the grid; the
    // overlay layer is anchored to the grid only, so grid row r → overlay row r.
    const ICON_COL_OFFSET = 1; // inside the box: 1 border cell, then the glyph

    const marks: IconMark[] = [];
    leftCenters.forEach((row, i) => {
      marks.push({
        key: `li-${i}`,
        col: leftColStart + ICON_COL_OFFSET,
        row,
        Icon: nodeIcon(leftNodes[i]),
        tone: "ink",
      });
    });
    rightCenters.forEach((row, i) => {
      marks.push({
        key: `ro-${i}`,
        col: rightColStart + ICON_COL_OFFSET,
        row,
        Icon: nodeIcon(rightNodes[i]),
        tone: "ink",
      });
    });
    // Worker glyph on the name row (centerRow - 1). Uses the shared workerIcon
    // resolver so the diagram's worker node matches the card + detail-header
    // icon. workerIcon may resolve a brand (already drawn in the "powered by"
    // strip below) — in that case the worker node shows the trigger glyph,
    // which carries complementary "how it fires" info.
    const resolvedWorker = worker ? workerIcon(worker) : null;
    const workerGlyph =
      resolvedWorker?.kind === "lucide" ? resolvedWorker.Icon : triggerGlyph(triggerType);
    marks.push({
      key: "worker",
      col: workerColStart + ICON_COL_OFFSET,
      row: centerRow - 1,
      Icon: workerGlyph,
      tone: "accent",
    });

    const headerCell = (text: string, width: number): string => {
      const t = clip(text, width);
      const pad = width - t.length;
      const l = Math.floor(pad / 2);
      return `${" ".repeat(l)}${t}${" ".repeat(pad - l)}`;
    };
    const header: Cell[] = [
      {
        text: headerCell(inputs.length === 0 ? "TRIGGER" : "INPUTS", leftW),
        tone: "soft",
      },
      { text: " ".repeat(ZONE_W), tone: "faint" },
      { text: headerCell("WORKER", workerW), tone: "soft" },
      { text: " ".repeat(ZONE_W), tone: "faint" },
      { text: headerCell("OUTPUTS", rightInner + 2), tone: "soft" },
    ];

    return { headerRow: header, gridRows: rows, iconMarks: marks };
  }, [workerName, worker, inputs, outputs, triggerType]);

  // Grid metrics — keep these in lockstep with the <pre> font below so the
  // `ch`/`em` overlay lands exactly on the character cells.
  const FONT_PX = 12;
  const LINE_H = 1.4; // em
  const HEADER_OFFSET_EM = LINE_H + 0.5; // header line + its 0.5em margin-bottom

  return (
    <section className={cn("space-y-3", className)}>
      {/* MOBILE-375: the diagram grid (`inline-block`) is intrinsically wider
          than a 375 viewport. `max-w-full` pins the framed card to its parent
          width so the wide grid scrolls horizontally INSIDE the card
          (overflow-x-auto) instead of dragging the page wider than the
          viewport. */}
      <div
        className="max-w-full overflow-x-auto bg-[var(--bg-2)] px-5 py-4"
        style={{ borderRadius: "var(--radius-card)" }}
      >
        {/* The diagram is a positioned stack: the text grid (box-drawing) plus
            an absolute glyph overlay measured in `ch` (monospace cell width)
            and `em` (line height). The two layers share the exact same font
            metrics, so glyphs land on their reserved leading cells. */}
        <div className="relative inline-block" style={{ fontSize: `${FONT_PX}px` }}>
          <pre
            aria-hidden="true"
            className="m-0 select-none"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "1em",
              lineHeight: `${LINE_H}`,
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

          {/* Type-glyph overlay. Positioned in `ch` (exact cell advance) and
              `em` (line box). Centered within the cell's box vertically. */}
          <div
            className="pointer-events-none absolute left-0 top-0"
            style={{ fontFamily: "var(--font-mono)", lineHeight: `${LINE_H}` }}
            aria-hidden="true"
          >
            {iconMarks.map((m) => (
              <m.Icon
                key={m.key}
                className="absolute"
                style={{
                  left: `${m.col}ch`,
                  top: `calc(${HEADER_OFFSET_EM}em + ${m.row * LINE_H}em + ${LINE_H / 2}em)`,
                  width: "1.05em",
                  height: "1.05em",
                  transform: "translateY(-50%)",
                  color: toneColor(m.tone),
                }}
              />
            ))}
          </div>
        </div>

        {/* Logo "engine" strip — the worker's connection brand marks layered
            beneath the ASCII as the hybrid identity layer Federico asked for.
            Real BrandLogo SVGs (same vocabulary as WorkerIconPills). Hidden
            when the worker declares no connections. */}
        {conns.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 [border-top:var(--bd-div)] pt-3">
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
                  className="inline-flex items-center gap-1.5 bg-[var(--bg-card)] px-1.5 py-1 text-[11px] text-[var(--ink-soft)]"
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
