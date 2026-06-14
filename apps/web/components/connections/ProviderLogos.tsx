import { BrandLogo } from "./BrandLogo";

function FloomMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Floom"
    >
      <rect width="100" height="100" rx="22" fill="#1a1a1a" />
      <path
        d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

// PR S21 (verification fix): the IconSprite registers brand symbols with
// hyphen-separated IDs (google-calendar, google-drive, etc.) but Composio
// returns lower-no-hyphen slugs (googlecalendar, googledrive). Normalize
// here so the BrandLogo lookup succeeds. Live test caught a blank square
// next to the Floom mark on /connections/connect/googlecalendar.
const SLUG_ALIASES: Record<string, string> = {
  googlecalendar: "google-calendar",
  googledrive: "google-drive",
  googledocs: "google-docs",
  googlesheets: "google-sheets",
  googlemeet: "google-meet",
  googlesearchconsole: "google-search-console",
  gsc: "google-search-console",
  searchconsole: "google-search-console",
};

function normalizeIcon(slug: string): string {
  const lower = slug.toLowerCase();
  if (SLUG_ALIASES[lower]) return SLUG_ALIASES[lower];
  // U17b: collapse separators so "google_search_console" resolves like the
  // separator-free Composio slug "googlesearchconsole".
  const collapsed = lower.replace(/[\s_-]+/g, "");
  return SLUG_ALIASES[collapsed] ?? lower;
}

export function ProviderLogos({ providerIcon }: { providerIcon: string }) {
  const icon = normalizeIcon(providerIcon);
  return (
    <div className="flex items-center justify-center gap-3">
      <div className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-card)] [border:var(--bd-card)] bg-card shadow-sm">
        <FloomMark className="size-9" />
      </div>
      <span aria-hidden className="text-2xl text-muted-foreground leading-none">
        ·
      </span>
      <div className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-card)] [border:var(--bd-card)] bg-card shadow-sm">
        <BrandLogo icon={icon} className="size-7" />
      </div>
    </div>
  );
}
