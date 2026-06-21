// ---------------------------------------------------------------------------
// timezones — the IANA timezone list for the schedule-trigger dropdown.
//
// the operator (2026-06-20): the Timezone field was free text ("Europe/Berlin"
// typed by hand). This replaces it with a validated dropdown. The runtime list
// comes from Intl.supportedValuesOf('timeZone') when available (modern engines
// expose ~400 zones); a compact curated fallback covers older runtimes so the
// dropdown is never empty.
// ---------------------------------------------------------------------------

const FALLBACK_TIMEZONES = [
  "UTC",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Paris",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "Europe/Zurich",
  "Europe/Lisbon",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "America/Mexico_City",
  "America/Toronto",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// All supported IANA timezones, sorted. UTC is pinned first.
export function listTimezones(): string[] {
  let zones: string[];
  const supported = (Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  }).supportedValuesOf;
  if (typeof supported === "function") {
    try {
      zones = supported("timeZone");
    } catch {
      zones = FALLBACK_TIMEZONES;
    }
  } else {
    zones = FALLBACK_TIMEZONES;
  }
  const set = new Set(zones);
  set.add("UTC");
  const rest = [...set].filter((z) => z !== "UTC").sort((a, b) => a.localeCompare(b));
  return ["UTC", ...rest];
}

// The browser's current IANA timezone, falling back to UTC.
export function browserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

// True if `tz` is a valid IANA timezone the runtime can format with.
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
