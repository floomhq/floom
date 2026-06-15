import { Plug } from "lucide-react";
import { cn } from "@/lib/utils";

// Brand colors keyed by normalized (hyphenated) slug. SimpleIcons hex values.
const BRAND_COLORS: Record<string, string> = {
  granola: "text-[#1E1E1E]",
  composio: "text-[#111111]",
  github: "text-[#181717]",
  gmail: "text-[#EA4335]",
  "google-calendar": "text-[#1A73E8]",
  "google-drive": "text-[#1E8E3E]",
  "google-docs": "text-[#4285F4]",
  "google-sheets": "text-[#34A853]",
  "google-meet": "text-[#00897B]",
  hubspot: "text-[#FF5C35]",
  linear: "text-[#5E6AD2]",
  linkedin: "text-[#0A66C2]",
  notion: "text-[#111111]",
  salesforce: "text-[#00A1E0]",
  slack: "text-[#611f69]",
  supabase: "text-[#3FCF8E]",
  "google-search-console": "text-[#458CF5]",
  whatsapp: "text-[#25D366]",
  openai: "text-[#412991]",
  apify: "text-[#FF9013]",
  apollo: "text-[#5C2D91]",
  stripe: "text-[#635BFF]",
};

// Composio returns lower-no-hyphen app slugs (googlecalendar, googledrive);
// the IconSprite registers hyphenated IDs. Normalize so the lookup succeeds.
// Single source of truth for brand-slug normalization across the app.
export const SLUG_ALIASES: Record<string, string> = {
  googlecalendar: "google-calendar",
  googledrive: "google-drive",
  googledocs: "google-docs",
  googlesheets: "google-sheets",
  googlemeet: "google-meet",
  gcal: "google-calendar",
  gdrive: "google-drive",
  googlesearchconsole: "google-search-console",
  gsc: "google-search-console",
  searchconsole: "google-search-console",
};

// Slugs whose symbols live under the #icon-* prefix rather than #brand-*.
const ICON_PREFIX_SLUGS = new Set(["anthropic", "cursor", "windsurf", "continue"]);

// Slugs that have a registered #brand-* SVG sprite symbol. Anything outside
// this set falls back to a clean lettered glyph instead of an empty box.
// Exported so workerIcon() can lead a card with a real logo only when one
// exists (otherwise it prefers a meaningful category glyph).
export const KNOWN_BRAND_SLUGS = new Set([
  "granola",
  "composio",
  "github",
  "gmail",
  "google-calendar",
  "google-drive",
  "google-docs",
  "google-sheets",
  "google-meet",
  "hubspot",
  "linear",
  "linkedin",
  "notion",
  "salesforce",
  "slack",
  "supabase",
  "google-search-console",
  "whatsapp",
  "openai",
  "apify",
  "apollo",
  "stripe",
]);

export function normalizeBrandSlug(slug: string): string {
  const lower = (slug || "").toLowerCase();
  // U17b: backend connection app_names arrive separator-rich
  // (e.g. "google_search_console"), but SLUG_ALIASES is keyed on the
  // separator-free Composio form ("googlesearchconsole"). Try the literal
  // value first, then a separator-collapsed form so underscore/hyphen/space
  // variants all resolve to the same #brand-* symbol.
  if (SLUG_ALIASES[lower]) return SLUG_ALIASES[lower];
  const collapsed = lower.replace(/[\s_-]+/g, "");
  if (SLUG_ALIASES[collapsed]) return SLUG_ALIASES[collapsed];
  return lower;
}

// Neutral lettered fallback — never an empty box. Monochrome, restrained,
// uses the first alphanumeric character of the slug.
function LetterFallback({ slug, className }: { slug: string; className?: string }) {
  const letter = (slug.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-ui)] bg-[var(--ink)]/[0.06] font-medium leading-none text-[var(--ink-mute)]",
        className,
      )}
      style={{ fontSize: "0.62em" }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

export function BrandLogo({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  // Empty input — connection page placeholder state.
  if (!icon) {
    return <Plug className={cn("size-5 text-[var(--ink-mute)]", className)} />;
  }

  const normalized = normalizeBrandSlug(icon);

  if (ICON_PREFIX_SLUGS.has(normalized)) {
    return (
      <svg
        className={cn("size-5", className)}
        role="img"
        aria-hidden="true"
        focusable="false"
      >
        <use href={`#icon-${normalized}`} />
      </svg>
    );
  }

  // Unknown brand — lettered glyph, never an empty box.
  if (!KNOWN_BRAND_SLUGS.has(normalized)) {
    return <LetterFallback slug={normalized} className={cn("size-5", className)} />;
  }

  return (
    <svg
      className={cn("size-5", BRAND_COLORS[normalized] ?? "text-[var(--ink)]", className)}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#brand-${normalized}`} />
    </svg>
  );
}
