import {
  AlignLeft,
  Clock,
  FileText,
  Globe,
  Hash,
  List,
  Mail,
  Play,
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
//   1. PRIMARY node   — the worker's MEANINGFUL identity glyph, resolved by
//                       workerIcon(): connection brand → purpose category →
//                       stable-hash neutral fallback. ALWAYS present, ALWAYS
//                       first, ALWAYS accented (--accent tint) so it anchors
//                       the composition. This is the fix for the "identical
//                       sparkle wall" (Federico 2026-05-29): manual workers no
//                       longer all show the same ✦ — each gets a distinct,
//                       meaningful glyph here.
//   2. TRIGGER glyph  — schedule→Clock / webhook→Webhook / event→Play, shown
//                       as a SECONDARY (non-accented) cell only when the
//                       trigger carries real info. Manual triggers add NO cell
//                       (manual is the default; a glyph for it was the wall).
//   3. INPUT glyphs   — input-type icons (text→Type, person→User, web→Globe…).
//   4. CONNECTION logos — real full-color brand SVGs via BrandLogo (any not
//                       already shown as the primary).
//   5. +N overflow    — when the strip exceeds `max` cells.
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

// Trigger type → lucide glyph, ONLY for triggers that carry information
// (schedule / webhook / event). Manual returns null: it is the default firing
// mode, and rendering a glyph for it on every manual worker was the source of
// the identical-icon wall. The worker's meaningful identity now lives in the
// accented PRIMARY cell (workerIcon), not the trigger.
function triggerIcon(triggerType?: string): { Icon: LucideIcon; label: string } | null {
  const t = (triggerType || "").toLowerCase();
  if (t === "schedule" || t === "cron" || t === "scheduled")
    return { Icon: Clock, label: "Scheduled trigger" };
  if (t === "webhook") return { Icon: Webhook, label: "Webhook trigger" };
  if (t === "composio" || t === "event") return { Icon: Play, label: "Event trigger" };
  return null;
}

type PillSize = "sm" | "md";

const SIZE: Record<PillSize, { box: string; glyph: string; overflow: string }> = {
  // sm — worker cards. md — detail header.
  sm: { box: "size-7", glyph: "size-3.5", overflow: "h-7 min-w-7" },
  md: { box: "size-8", glyph: "size-4", overflow: "h-8 min-w-8" },
};

// A single cell in the composed strip. `accent` marks the start node; `first`
// drops the negative margin so the strip butts cleanly against its left edge.
// v4 addendum: chips are square ~5px-radius neutral bg-2, monochrome-leaning
// marks. The accent tint was the "colour overload" — status pill is the only
// tinted element per card. All cells now use the same neutral bg-2 / ink-soft.
function Cell({
  size,
  title,
  first,
  children,
}: {
  size: PillSize;
  title: string;
  accent?: boolean;  // kept for API compat; intentionally unused
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center ring-1",
        first ? "z-20" : "-ml-px z-10",
        "bg-[var(--bg-2)] text-[var(--ink-soft)] ring-[var(--line-soft)]",
        SIZE[size].box,
      )}
      style={{ borderRadius: "5px" }}
    >
      {children}
    </span>
  );
}

export interface WorkerIconPillsProps {
  /**
   * Worker identity used to resolve the accented PRIMARY glyph (connection
   * brand → purpose category → stable-hash fallback). The fix for the
   * identical-sparkle wall. When omitted the strip still renders from the
   * trigger/inputs/connections below (back-compat), but pass it so the primary
   * cell is meaningful.
   */
  worker?: WorkerIconInput;
  inputs?: { type: string; name?: string; label?: string }[];
  connections?: string[];
  triggerType?: string;
  /** Max cells (incl. the primary node) before collapsing into a +N chip. */
  max?: number;
  size?: PillSize;
  className?: string;
}

export function WorkerIconPills({
  worker,
  inputs = [],
  connections = [],
  triggerType,
  max = 5,
  size = "sm",
  className,
}: WorkerIconPillsProps) {
  const glyph = SIZE[size].glyph;

  // Build the ordered cell list. PRIMARY node first (accented, meaningful),
  // then the trigger glyph (only when informative), then input-type glyphs,
  // then connection brand logos. Each entry carries either a brand slug
  // (rendered via BrandLogo) or a resolved lucide component type.
  type Entry =
    | { kind: "brand"; key: string; title: string; slug: string; accent?: boolean }
    | { kind: "lucide"; key: string; title: string; Icon: LucideIcon; accent?: boolean };
  const entries: Entry[] = [];

  // The slug already shown as the primary brand cell — so it is not repeated in
  // the connection-logo tail below.
  let primaryBrandSlug: string | null = null;

  // 1. PRIMARY node — always present, always first, always accented. Resolves
  //    to a DISTINCT, meaningful glyph (connection brand / purpose category /
  //    stable-hash fallback). Falls back to the trigger/connection signal when
  //    no `worker` identity is supplied (back-compat).
  const resolved = worker
    ? workerIcon(worker)
    : connections.find((c) => c && typeof c === "string")
      ? ({ kind: "brand", slug: connections.find((c) => c && typeof c === "string")! } as const)
      : null;
  if (resolved?.kind === "brand") {
    primaryBrandSlug = normalizeBrandSlug(resolved.slug);
    entries.push({
      kind: "brand",
      key: "primary",
      title: resolved.slug,
      slug: resolved.slug,
      accent: true,
    });
  } else if (resolved?.kind === "lucide") {
    entries.push({
      kind: "lucide",
      key: "primary",
      title: worker?.name || "Worker",
      Icon: resolved.Icon,
      accent: true,
    });
  }

  // 2. Trigger glyph — secondary, non-accented, only when it carries info
  //    (schedule / webhook / event). Manual adds nothing.
  const trigger = triggerIcon(triggerType);
  if (trigger) {
    entries.push({
      kind: "lucide",
      key: "trigger",
      title: trigger.label,
      Icon: trigger.Icon,
    });
  }

  // 3. Input-type glyphs.
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    entries.push({
      kind: "lucide",
      key: `input-${inp.name || i}`,
      title: inp.label || inp.name || inp.type,
      Icon: inputIcon(inp),
    });
  }

  // 4. Connection brand logos (de-duped; skip the one already shown as primary).
  const seenConn = new Set<string>();
  for (const slug of connections) {
    if (!slug || typeof slug !== "string") continue;
    const key = normalizeBrandSlug(slug);
    if (key === primaryBrandSlug) continue;
    if (seenConn.has(key)) continue;
    seenConn.add(key);
    entries.push({ kind: "brand", key: `conn-${key}`, title: slug, slug });
  }

  // A worker card must NEVER read as visually empty (Federico 2026-05-29). The
  // accented PRIMARY node is the always-present anchor (workerIcon always
  // resolves something), so the strip renders even with no trigger/inputs/
  // connections. The lone primary glyph still carries the worker's identity.
  if (entries.length === 0) return null;

  const visible = entries.length > max ? entries.slice(0, max) : entries;
  const overflow = entries.length - visible.length;

  // The cells are decorative (icons are aria-hidden; sighted users get the
  // per-cell `title` tooltip). For assistive tech the strip is announced once
  // as a single image with a label summarizing what it represents — the
  // worker's identity, inputs, and connected tools — so it is never a silent
  // run of unlabeled glyphs.
  const stripLabel = `${worker?.name ? `${worker.name}: ` : ""}inputs and tools — ${entries
    .map((e) => e.title)
    .join(", ")}`;

  return (
    <div className={cn("flex items-center", className)}>
      {/* The composed strip: one connected unit, no gaps between cells. */}
      <div className="flex items-center" role="img" aria-label={stripLabel} title={stripLabel}>
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
