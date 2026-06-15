/**
 * Resolve a provider/tool brand slug from a free-form tool or worker name.
 *
 * Returns the normalized brand slug (matches KNOWN_BRAND_SLUGS in BrandLogo)
 * or null when no known brand is detected.
 *
 * Usage: pass the toolName, title, or worker name from a card and render
 * <BrandLogo icon={resolveProviderSlug(name)} /> when the result is non-null.
 */

// Map of keyword patterns → canonical brand slug.
// Patterns are tested case-insensitively against the full input string.
const PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/\bgmail\b|\bemail\b.*google|\bgoogle\b.*email/i, "gmail"],
  [/\bgoogle[\s_-]?calendar\b|\bcalendar\b.*google/i, "google-calendar"],
  [/\bgoogle[\s_-]?drive\b|\bgdrive\b/i, "google-drive"],
  [/\bgoogle[\s_-]?docs\b|\bgdocs\b/i, "google-docs"],
  [/\bgoogle[\s_-]?sheets\b|\bgsheets\b|\bspreadsheet\b/i, "google-sheets"],
  [/\bgoogle[\s_-]?meet\b/i, "google-meet"],
  [/\bgoogle[\s_-]?search[\s_-]?console\b|\bgsc\b/i, "google-search-console"],
  [/\bhubspot\b/i, "hubspot"],
  [/\bslack\b/i, "slack"],
  [/\blinear\b/i, "linear"],
  [/\bnotion\b/i, "notion"],
  [/\bgithub\b/i, "github"],
  [/\blinkedin\b/i, "linkedin"],
  [/\bsalesforce\b/i, "salesforce"],
  [/\bsupabase\b/i, "supabase"],
  [/\bwhatsapp\b/i, "whatsapp"],
  [/\bopenai\b|\bgpt\b/i, "openai"],
  [/\bapify\b/i, "apify"],
  [/\bapollo\b/i, "apollo"],
  [/\bstripe\b/i, "stripe"],
  [/\bcomposio\b/i, "composio"],
  [/\bgranola\b/i, "granola"],
];

export function resolveProviderSlug(name: string | undefined | null): string | null {
  if (!name) return null;
  for (const [pattern, slug] of PROVIDER_PATTERNS) {
    if (pattern.test(name)) return slug;
  }
  return null;
}
