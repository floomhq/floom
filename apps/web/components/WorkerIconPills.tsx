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
import { BrandLogo } from "@/components/connections/BrandLogo";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// WorkerIconPills — a COMPOSED, Langdock-style icon strip for a worker.
//
// Federico (2026-05-29): "should be composed like for langdock — understand
// the logic?" Langdock's template-card icon row is a SINGLE composed unit:
// connected/overlapping rounded squares butted together so they read as ONE
// glyph for the workflow, with the FIRST node accented (their orange
// start/trigger node), the tool/connection logos following, and a +N overflow
// chip at the end.
//
// So this is NOT three detached squares with gaps. It is one linked strip:
//   1. START node    — the trigger (schedule→Clock, webhook→Webhook,
//                       event→Play, manual→Sparkles). ALWAYS present, ALWAYS
//                       first, ALWAYS accented (--accent tint) so it anchors
//                       the composition like Langdock's orange start node.
//   2. INPUT glyphs   — input-type icons (text→Type, person→User, web→Globe…).
//   3. CONNECTION logos — real full-color brand SVGs via BrandLogo.
//   4. +N overflow    — when the strip exceeds `max` cells.
//
// The cells overlap (-ml-px) and each carries a ring so the seams read as a
// connected unit, not gaps. Real brand SVGs only. No emoji, no text-in-circle,
// no dashed borders. Design-system radius via --radius-squircle. Premium in
// light AND dark.
// ---------------------------------------------------------------------------

// Map a worker input `type` to a crisp lucide glyph. Names are also matched
// (person/name, csv) since the manifest types are coarse.
function inputIcon(input: { type: string; name?: string; label?: string }): LucideIcon {
  const t = (input.type || "").toLowerCase();
  const hint = `${input.name || ""} ${input.label || ""}`.toLowerCase();

  if (/\b(person|name|contact|author|owner|user)\b/.test(hint)) return User;
  if (/\b(email|e-mail)\b/.test(hint)) return Mail;
  if (/\b(url|link|website|domain)\b/.test(hint)) return Globe;
  if (/\b(csv|table|spreadsheet|rows?|columns?)\b/.test(hint)) return Table;

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

// Trigger type → lucide glyph for the START node. Manual still gets a glyph
// (Sparkles) because the start node is the anchor of the composition and is
// always rendered.
function triggerIcon(triggerType?: string): { Icon: LucideIcon; label: string } {
  const t = (triggerType || "").toLowerCase();
  if (t === "schedule" || t === "cron" || t === "scheduled")
    return { Icon: Clock, label: "Scheduled trigger" };
  if (t === "webhook") return { Icon: Webhook, label: "Webhook trigger" };
  if (t === "composio" || t === "event") return { Icon: Play, label: "Event trigger" };
  return { Icon: Sparkles, label: "Manual trigger" };
}

type PillSize = "sm" | "md";

const SIZE: Record<PillSize, { box: string; glyph: string; overflow: string }> = {
  // sm — worker cards. md — detail header.
  sm: { box: "size-7", glyph: "size-3.5", overflow: "h-7 min-w-7" },
  md: { box: "size-8", glyph: "size-4", overflow: "h-8 min-w-8" },
};

// A single cell in the composed strip. `accent` marks the start node; `first`
// drops the negative margin so the strip butts cleanly against its left edge.
function Cell({
  size,
  title,
  accent,
  first,
  children,
}: {
  size: PillSize;
  title: string;
  accent?: boolean;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        // ring-* + a matching --bg-card backing makes the seams read as one
        // connected unit while keeping each cell crisp. relative + z keeps the
        // overlap order stable (left cell sits above the one to its right).
        "relative inline-flex shrink-0 items-center justify-center ring-1",
        first ? "z-20" : "-ml-px z-10",
        accent
          ? "bg-[var(--accent-soft)] text-[var(--accent)] ring-[var(--accent-line)]"
          : "bg-[var(--bg-card)] text-[var(--ink-soft)] ring-[var(--line-soft)]",
        SIZE[size].box,
      )}
      style={{ borderRadius: "var(--radius-squircle)" }}
    >
      {children}
    </span>
  );
}

export interface WorkerIconPillsProps {
  inputs?: { type: string; name?: string; label?: string }[];
  connections?: string[];
  triggerType?: string;
  /** Max cells (incl. the start node) before collapsing into a +N chip. */
  max?: number;
  size?: PillSize;
  className?: string;
}

export function WorkerIconPills({
  inputs = [],
  connections = [],
  triggerType,
  max = 5,
  size = "sm",
  className,
}: WorkerIconPillsProps) {
  const glyph = SIZE[size].glyph;

  // Build the ordered cell list. START node first (accented), then input-type
  // glyphs, then connection brand logos. Each entry carries either a brand
  // slug (rendered via BrandLogo) or a resolved lucide component type.
  type Entry =
    | { kind: "brand"; key: string; title: string; slug: string; accent?: boolean }
    | { kind: "lucide"; key: string; title: string; Icon: LucideIcon; accent?: boolean };
  const entries: Entry[] = [];

  // 1. START node — always present, always first, always accented.
  const trigger = triggerIcon(triggerType);
  entries.push({
    kind: "lucide",
    key: "start",
    title: trigger.label,
    Icon: trigger.Icon,
    accent: true,
  });

  // 2. Input-type glyphs.
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    entries.push({
      kind: "lucide",
      key: `input-${inp.name || i}`,
      title: inp.label || inp.name || inp.type,
      Icon: inputIcon(inp),
    });
  }

  // 3. Connection brand logos (de-duped — a worker can declare the same app twice).
  const seenConn = new Set<string>();
  for (const slug of connections) {
    if (!slug || typeof slug !== "string") continue;
    const key = slug.toLowerCase();
    if (seenConn.has(key)) continue;
    seenConn.add(key);
    entries.push({ kind: "brand", key: `conn-${key}`, title: slug, slug });
  }

  // The start node alone (no inputs, no connections) is not worth a strip — it
  // would just be a lone accent square pretending to be a composition.
  if (entries.length <= 1) return null;

  const visible = entries.length > max ? entries.slice(0, max) : entries;
  const overflow = entries.length - visible.length;

  return (
    <div className={cn("flex items-center", className)}>
      {/* The composed strip: one connected unit, no gaps between cells. */}
      <div className="flex items-center">
        {visible.map((e, i) => (
          <Cell key={e.key} size={size} title={e.title} accent={e.accent} first={i === 0}>
            {e.kind === "brand" ? (
              <BrandLogo icon={e.slug} className={glyph} />
            ) : (
              <e.Icon className={glyph} aria-hidden="true" />
            )}
          </Cell>
        ))}
        {overflow > 0 && (
          <span
            title={`+${overflow} more`}
            className={cn(
              "relative -ml-px z-0 inline-flex shrink-0 items-center justify-center px-1.5 text-[11px] font-medium leading-none ring-1 ring-[var(--line-soft)] bg-[var(--bg-2)] text-[var(--ink-mute)]",
              SIZE[size].overflow,
            )}
            style={{ borderRadius: "var(--radius-squircle)" }}
            aria-label={`${overflow} more`}
          >
            +{overflow}
          </span>
        )}
      </div>
    </div>
  );
}
