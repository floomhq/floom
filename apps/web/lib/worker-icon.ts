// ---------------------------------------------------------------------------
// workerIcon — resolves a DISTINCT, MEANINGFUL primary icon for a worker.
//
// the operator (2026-05-29): the /workers grid showed the SAME generic AI sparkle
// (✦) on every worker without a connection — 30+ identical sparkles read as a
// monotonous wall, and the sparkle is the single most overused AI icon. This
// helper kills that wall by resolving a varied, purpose-derived glyph per
// worker, in priority order:
//
//   1. CONNECTION  → lead with the worker's real connection brand logo
//                    (Gmail / GitHub / Slack / …). The most informative signal:
//                    "this worker touches your Gmail" is worth more than a
//                    category guess.
//   2. CATEGORY    → a lucide glyph derived by keyword-matching the worker's
//                    name + description + folder + tags against a purpose map
//                    (update/digest → Newspaper, CV/candidate → FileUser,
//                    compliance → ShieldCheck, csv/enrich → Table, …).
//   3. FALLBACK    → a small set of distinct neutral glyphs keyed by a stable
//                    hash of the worker id, so even un-matched workers VARY
//                    instead of all collapsing to one icon. NEVER the bare
//                    sparkle-for-everyone.
//
// The result is a grid where each card carries a glyph that means something,
// and no two neighbours look identical. Used by the /workers cards, the detail
// About header, and the ASCII flow diagram so the identity is consistent across
// every surface a worker appears on.
// ---------------------------------------------------------------------------

import {
  AlignLeft,
  ArrowLeftRight,
  BarChart3,
  Binary,
  BookOpen,
  Calculator,
  CaseUpper,
  Divide,
  Euro,
  FileSpreadsheet,
  FileUser,
  Filter,
  FlaskConical,
  GitPullRequest,
  Globe,
  Hash,
  IdCard,
  Layers,
  ListChecks,
  Mail,
  Newspaper,
  PenLine,
  Percent,
  Phone,
  Quote,
  Receipt,
  Repeat,
  Scale,
  Search,
  Send,
  ShieldCheck,
  Sigma,
  SpellCheck,
  Table,
  Target,
  Thermometer,
  TrendingUp,
  Type,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  KNOWN_BRAND_SLUGS,
  normalizeBrandSlug,
} from "@/components/connections/BrandLogo";

// A resolved worker icon — either a real brand SVG (rendered via BrandLogo) or
// a lucide category/fallback glyph (rendered as a component).
export type WorkerIcon =
  | { kind: "brand"; slug: string }
  | { kind: "lucide"; Icon: LucideIcon };

// The subset of WorkerSummary / WorkerDetail fields this resolver reads. Kept
// structural so it accepts either shape without importing the full type.
export interface WorkerIconInput {
  id: string;
  name?: string;
  description?: string;
  folder?: string;
  tags?: string[];
  connections?: string[];
}

// ---------------------------------------------------------------------------
// Category map — ordered MOST specific → least specific. The first rule whose
// regex hits the worker's combined text (name + description + folder + tags)
// wins, so e.g. "CSV name length adder" matches the CSV rule before the
// generic count rule. Each entry: a matcher + the lucide glyph it resolves to.
// ---------------------------------------------------------------------------
const CATEGORY_RULES: { test: RegExp; Icon: LucideIcon }[] = [
  // Recruiting — CV / candidate / resume.
  { test: /\b(cv|resume|candidate|writeup|applicant)\b/, Icon: FileUser },
  // Recruiting — CRM / lead matching.
  { test: /\b(crm|reverse[- ]?match|lead|prospect)\b/, Icon: Target },
  // Compliance / risk / legal / benchmark. NB: no bare "rate" here — it would
  // steal currency/price converters ("exchange rate"); "benchmark" covers the
  // DACH rate-benchmark worker, and "risk/compliance/aÜg/scheinselbst" anchor it.
  { test: /\b(compliance|aug|aÜg|scheinselbst|risk|legal|benchmark)\b/, Icon: ShieldCheck },
  // Research / brief / analysis / thesis / paper.
  { test: /\b(research|brief|thesis|paper|draft|academic|analysis)\b/, Icon: Search },
  // SEO / blog / content / marketing article.
  { test: /\b(seo|blog|article|content|marketing)\b/, Icon: PenLine },
  // Weekly update / report / digest / newsletter.
  { test: /\b(update|digest|newsletter|report|recap)\b/, Icon: Newspaper },
  // Outbound / outreach / approval / HITL message.
  { test: /\b(outbound|outreach|approval|hitl)\b/, Icon: Send },
  // Inbox / email summary / intake.
  { test: /\b(inbox|intake|gmail|mailbox)\b/, Icon: Mail },
  // Invoice / finance / accounting.
  { test: /\b(invoice|finance|accounting|billing)\b/, Icon: Receipt },
  // Quote / motivation.
  { test: /\b(quote|motivat|inspiration)\b/, Icon: Quote },
  // Currency conversion (usd/eur/price).
  { test: /\b(usd|eur|euro|currency|price|exchange)\b/, Icon: Euro },
  // Temperature conversion.
  { test: /\b(celsius|fahrenheit|temperature|thermo)\b/, Icon: Thermometer },
  // Phone-number extraction.
  { test: /\bphone\b/, Icon: Phone },
  // Email-address extraction / dedup of emails.
  { test: /\bemail(s|[- ]?address|[- ]?dedup)/, Icon: Mail },
  // Title case / uppercase / case transforms.
  { test: /\b(uppercase|title[- ]?case|case)\b/, Icon: CaseUpper },
  // String reverse / list reverse.
  { test: /\breverse|reverser\b/, Icon: Repeat },
  // Dedup / remove duplicates (strings / lines / lists).
  { test: /\b(dedup|duplicate|deduplicat)/, Icon: Filter },
  // Markdown → plain text / format conversion.
  { test: /\b(markdown|plain[- ]?text|convert|transform|to[- ]?plain)\b/, Icon: ArrowLeftRight },
  // Word / character / text counting + frequency.
  { test: /\b(word|character|char|count|counter|frequenc|summary[- ]?analyz)/, Icon: SpellCheck },
  // Statistics — std dev / variance / median / mean / average.
  { test: /\b(statistic|std[- ]?dev|standard[- ]?deviation|variance|median|mean|average|min|max)\b/, Icon: BarChart3 },
  // Sum / total column.
  { test: /\b(sum|total)\b/, Icon: Sigma },
  // Divide / division.
  { test: /\b(divid|division|quotient)\b/, Icon: Divide },
  // Percent / ratio.
  { test: /\b(percent|ratio)\b/, Icon: Percent },
  // Science / facts.
  { test: /\b(science|fact)\b/, Icon: FlaskConical },
  // CSV / spreadsheet / column / row.
  { test: /\b(csv|spreadsheet|column|row|sort)\b/, Icon: FileSpreadsheet },
  // Table / enrich.
  { test: /\b(table|enrich)\b/, Icon: Table },
  // Number / numeric / calculator.
  { test: /\b(number|numeric|calculat|math)\b/, Icon: Calculator },
  // List / array / items.
  { test: /\b(list|array|items?)\b/, Icon: ListChecks },
  // Summarize / text summary.
  { test: /\b(summar|tldr)\b/, Icon: AlignLeft },
  // Granola meeting-notes worker — matched by brand name. The brand icon is
  // rendered via workerIcon's firstKnownBrand() path (connections slug), but
  // when only name-matching is available (e.g. WorkerRowIcon in overview) this
  // rule surfaces the right category glyph.
  { test: /\bgranola\b/, Icon: BookOpen },
  // Pull request / git.
  { test: /\b(pull[- ]?request|\bpr\b|git)\b/, Icon: GitPullRequest },
  // Web / url / scrape.
  { test: /\b(url|website|web|scrape|domain)\b/, Icon: Globe },
];

// Distinct neutral fallbacks — keyed by a stable hash of the worker id so an
// unmatched worker still VARIES across the grid. Deliberately NOT Sparkles
// (the icon we are killing). These read as "generic worker" without all
// collapsing to a single glyph.
const FALLBACK_ICONS: LucideIcon[] = [
  Layers,
  Type,
  Hash,
  IdCard,
  BookOpen,
  TrendingUp,
  Scale,
  Binary,
  Users,
];

// Deterministic 32-bit string hash (djb2). Same id → same fallback glyph,
// stable across renders and SSR/CSR so there is never a hydration flash.
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// First connection slug that resolves to a real registered brand SVG. We lead
// with a brand only when we can render its actual logo — an unknown slug would
// fall back to a lettered glyph, which is less informative than a category icon.
function firstKnownBrand(connections?: string[]): string | null {
  if (!connections) return null;
  for (const raw of connections) {
    if (!raw || typeof raw !== "string") continue;
    const slug = normalizeBrandSlug(raw);
    if (KNOWN_BRAND_SLUGS.has(slug)) return slug;
  }
  return null;
}

function categoryIcon(worker: WorkerIconInput): LucideIcon | null {
  const blob = [
    worker.name || "",
    worker.description || "",
    worker.folder || "",
    ...(worker.tags || []),
  ]
    .join(" ")
    .toLowerCase();
  if (!blob.trim()) return null;
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(blob)) return rule.Icon;
  }
  return null;
}

/**
 * Resolve the primary icon for a worker: connection brand → category glyph →
 * stable-hash neutral fallback. Never returns the bare AI sparkle.
 */
export function workerIcon(worker: WorkerIconInput): WorkerIcon {
  // 1. Lead with a real connection brand logo when present.
  const brand = firstKnownBrand(worker.connections);
  if (brand) return { kind: "brand", slug: brand };

  // 2. Category glyph derived from the worker's purpose.
  const category = categoryIcon(worker);
  if (category) return { kind: "lucide", Icon: category };

  // 3. Distinct neutral fallback keyed by a stable hash of the id.
  const Icon = FALLBACK_ICONS[hashString(worker.id || worker.name || "") % FALLBACK_ICONS.length];
  return { kind: "lucide", Icon };
}
