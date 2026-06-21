// ---------------------------------------------------------------------------
// cron-next-run — compute the next fire time of a 5-field cron expression in a
// given IANA timezone, plus a validator.
//
// the operator (2026-06-20) roasted the schedule editor: no "next run" preview,
// no validation. This is the zero-dependency engine behind both. It supports
// the standard 5-field form (minute hour day-of-month month day-of-week) with
// `*`, lists (`1,3,5`), ranges (`1-5`), and steps (`*/15`, `0-30/5`). Day names
// (MON, SUN) and month names (JAN) are normalised to numbers. Day-of-week 7 is
// treated as Sunday (0), matching cron convention.
//
// The next-run search walks forward minute by minute from "now" in the target
// timezone, capped so a never-matching expression returns null instead of
// looping forever.
// ---------------------------------------------------------------------------

const DOW_NAME_TO_NUM: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const MONTH_NAME_TO_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

interface FieldRange {
  min: number;
  max: number;
  // optional name → number map for this field (dow, month)
  names?: Record<string, number>;
}

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 },                          // minute
  { min: 0, max: 23 },                          // hour
  { min: 1, max: 31 },                          // day-of-month
  { min: 1, max: 12, names: MONTH_NAME_TO_NUM }, // month
  { min: 0, max: 7, names: DOW_NAME_TO_NUM },    // day-of-week (0/7 = Sun)
];

// Parse a single cron field into the explicit set of allowed integers.
// Returns null if the field is syntactically invalid for the given range.
function parseField(field: string, range: FieldRange): Set<number> | null {
  const result = new Set<number>();
  const normalizeToken = (tok: string): number | null => {
    const lower = tok.toLowerCase();
    if (range.names && lower in range.names) return range.names[lower];
    if (!/^\d+$/.test(tok)) return null;
    return parseInt(tok, 10);
  };

  for (const part of field.split(",")) {
    if (part.length === 0) return null;

    // step: <range-or-*>/<n>
    let stepStr = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      stepStr = part.slice(0, slash);
      const stepNum = part.slice(slash + 1);
      if (!/^\d+$/.test(stepNum) || parseInt(stepNum, 10) === 0) return null;
      step = parseInt(stepNum, 10);
    }

    let lo: number;
    let hi: number;
    if (stepStr === "*") {
      lo = range.min;
      hi = range.max;
    } else if (stepStr.includes("-")) {
      const [a, b] = stepStr.split("-");
      const an = normalizeToken(a);
      const bn = normalizeToken(b);
      if (an === null || bn === null) return null;
      lo = an;
      hi = bn;
    } else {
      const n = normalizeToken(stepStr);
      if (n === null) return null;
      lo = n;
      // a bare number with a step (e.g. "5/10") runs from n to max
      hi = slash !== -1 ? range.max : n;
    }

    if (lo < range.min || hi > range.max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) result.add(v);
  }

  return result.size > 0 ? result : null;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  // day-of-week, normalised so Sunday is always 0 (7 folded to 0)
  dow: Set<number>;
  // true when day-of-month was restricted (not "*") — affects DOM/DOW combining
  domRestricted: boolean;
  dowRestricted: boolean;
}

// Parse a full 5-field cron expression. Returns null if invalid.
export function parseCron(expr: string | null | undefined): ParsedCron | null {
  const raw = (expr ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return null;

  const sets = parts.map((p, i) => parseField(p, FIELD_RANGES[i]));
  if (sets.some((s) => s === null)) return null;

  const [minute, hour, dom, month, dowRaw] = sets as Set<number>[];

  // Fold day-of-week 7 → 0 (both mean Sunday).
  const dow = new Set<number>();
  for (const d of dowRaw) dow.add(d === 7 ? 0 : d);

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

// Validate a cron expression. Returns null when valid, or a short error string.
export function validateCron(expr: string | null | undefined): string | null {
  const raw = (expr ?? "").trim();
  if (!raw) return "Enter a cron expression";
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) {
    return "Must have 5 fields: minute hour day-of-month month day-of-week";
  }
  if (!parseCron(raw)) return "Invalid cron expression";
  return null;
}

// Read the wall-clock parts of a Date as observed in a given IANA timezone.
function partsInTimeZone(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    hour,
    minute: parseInt(map.minute, 10),
    weekday: weekdayMap[map.weekday] ?? 0,
  };
}

function matches(parsed: ParsedCron, p: { month: number; day: number; hour: number; minute: number; weekday: number }): boolean {
  if (!parsed.minute.has(p.minute)) return false;
  if (!parsed.hour.has(p.hour)) return false;
  if (!parsed.month.has(p.month)) return false;

  // Cron DOM/DOW rule: if BOTH are restricted, a match on EITHER fires. If only
  // one is restricted, only that one must match.
  const domOk = parsed.dom.has(p.day);
  const dowOk = parsed.dow.has(p.weekday);
  if (parsed.domRestricted && parsed.dowRestricted) {
    return domOk || dowOk;
  }
  if (parsed.domRestricted) return domOk;
  if (parsed.dowRestricted) return dowOk;
  return true; // neither restricted
}

// Compute the next fire time at or after `from` (default now) for `expr` in
// `timeZone`. Returns a Date, or null if the expression is invalid or no match
// is found within the search horizon.
export function nextRun(
  expr: string | null | undefined,
  timeZone: string,
  from: Date = new Date(),
): Date | null {
  const parsed = parseCron(expr);
  if (!parsed) return null;

  // Start at the next whole minute (cron fires on minute boundaries).
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Search up to ~4 years of minutes to cover rare Feb-29-style schedules.
  const MAX_MINUTES = 366 * 24 * 60 * 4;
  const cursor = new Date(start.getTime());
  for (let i = 0; i < MAX_MINUTES; i += 1) {
    const p = partsInTimeZone(cursor, timeZone);
    if (matches(parsed, p)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// Format a next-run Date as a short, human, timezone-aware label, e.g.
// "Mon, Jun 23, 9:00 AM" (in the schedule's timezone).
export function formatNextRun(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}
