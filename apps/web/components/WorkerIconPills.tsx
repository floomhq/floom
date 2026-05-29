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
import { BrandLogo } from "@/components/connections/BrandLogo";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// WorkerIconPills — Langdock-grade horizontal row of squircle icon pills.
//
// Each pill represents, in order:
//   1. Input-type icons   (string→Type, textarea→AlignLeft, number→Hash, …)
//   2. Connection brand logos (real full-color SVG via BrandLogo / IconSprite)
//   3. Trigger icon       (schedule→Clock, webhook→Webhook) — optional
//   4. +N overflow pill   when the row exceeds `max` pills.
//
// Real brand SVGs only (reused from the Connections page source). No emoji,
// no text-in-circle, no dashed borders. Design-system radius via
// --radius-squircle, subtle --bg-2 fill + hairline border. Premium in
// light AND dark.
// ---------------------------------------------------------------------------

// Map a worker input `type` to a crisp lucide glyph. The "icons for text,
// person, web, etc." Federico asked for. Names are also matched (person/name,
// csv) since the manifest types are coarse.
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

// Trigger type → lucide glyph. Only schedule + webhook get a pill; manual is
// the default and not worth a chip (keeps the row clean).
function triggerIcon(triggerType: string): LucideIcon | null {
  const t = (triggerType || "").toLowerCase();
  if (t === "schedule" || t === "cron" || t === "scheduled") return Clock;
  if (t === "webhook") return Webhook;
  if (t === "composio" || t === "event") return Play;
  return null;
}

type PillSize = "sm" | "md";

const SIZE: Record<PillSize, { box: string; glyph: string; gap: string }> = {
  // sm — worker cards. md — detail header.
  sm: { box: "size-7", glyph: "size-3.5", gap: "gap-1" },
  md: { box: "size-8", glyph: "size-4", gap: "gap-1.5" },
};

function Pill({
  size,
  title,
  children,
}: {
  size: PillSize;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-[var(--line-soft)] bg-[var(--bg-2)] text-[var(--ink-soft)]",
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
  /** Max pills before collapsing the remainder into a +N chip. Default 5. */
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

  // Build the ordered pill list. Connections first (the most recognizable,
  // full-color brand marks lead), then input-type icons, then trigger. Each
  // entry carries either a brand slug (rendered via BrandLogo) or a resolved
  // lucide component type (rendered in JSX below — never instantiated here).
  type Entry =
    | { kind: "brand"; key: string; title: string; slug: string }
    | { kind: "lucide"; key: string; title: string; Icon: LucideIcon };
  const entries: Entry[] = [];

  // De-dupe connection slugs (a worker can declare the same app twice).
  const seenConn = new Set<string>();
  for (const slug of connections) {
    if (!slug || typeof slug !== "string") continue;
    const key = slug.toLowerCase();
    if (seenConn.has(key)) continue;
    seenConn.add(key);
    entries.push({ kind: "brand", key: `conn-${key}`, title: slug, slug });
  }

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    entries.push({
      kind: "lucide",
      key: `input-${inp.name || i}`,
      title: inp.label || inp.name || inp.type,
      Icon: inputIcon(inp),
    });
  }

  if (triggerType) {
    const TIcon = triggerIcon(triggerType);
    if (TIcon) {
      entries.push({
        kind: "lucide",
        key: "trigger",
        title: `${triggerType} trigger`,
        Icon: TIcon,
      });
    }
  }

  // Nothing to show — render nothing (no empty box).
  if (entries.length === 0) return null;

  const visible = entries.length > max ? entries.slice(0, max) : entries;
  const overflow = entries.length - visible.length;

  return (
    <div className={cn("flex flex-wrap items-center", SIZE[size].gap, className)}>
      {visible.map((e) => (
        <Pill key={e.key} size={size} title={e.title}>
          {e.kind === "brand" ? (
            <BrandLogo icon={e.slug} className={glyph} />
          ) : (
            <e.Icon className={glyph} aria-hidden="true" />
          )}
        </Pill>
      ))}
      {overflow > 0 && (
        <span
          title={`+${overflow} more`}
          className={cn(
            "inline-flex shrink-0 items-center justify-center border border-[var(--line-soft)] bg-[var(--bg-2)] px-1.5 text-[11px] font-medium leading-none text-[var(--ink-mute)]",
            SIZE[size].box === "size-7" ? "h-7 min-w-7" : "h-8 min-w-8",
          )}
          style={{ borderRadius: "var(--radius-squircle)" }}
          aria-label={`${overflow} more`}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
