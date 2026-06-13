// ---------------------------------------------------------------------------
// humanizeCron — turn a 5-field cron expression into plain English.
//
// the operator (2026-06-02): trigger chips showed raw `0 9 * * * UTC` — "who can
// read this cryptic stuff?". This converts the common patterns (every-minute,
// every-N-minutes, hourly, daily, weekday, weekly, monthly) into readable text,
// falling back to the raw expression for anything exotic so we never lie about
// the schedule.
//
// No external dependency (cronstrue is not installed) — a compact handler that
// covers the patterns CronBuilder can produce plus the obvious hand-written
// ones. The raw expression stays available (e.g. as a tooltip) for power users.
// ---------------------------------------------------------------------------

const DOW_NAMES: Record<string, string> = {
  "0": "Sunday",
  "1": "Monday",
  "2": "Tuesday",
  "3": "Wednesday",
  "4": "Thursday",
  "5": "Friday",
  "6": "Saturday",
  "7": "Sunday",
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

// 24h "H:M" → "9:00 AM". Keeps it short and human.
function clockTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${pad2(minute)} ${period}`;
}

function dowName(field: string): string | null {
  return DOW_NAMES[field.toLowerCase()] ?? null;
}

// List of day names for a comma/range day-of-week field (e.g. "1-5", "1,3,5").
function dowList(field: string): string | null {
  // Range like 1-5
  const range = field.match(/^(\w+)-(\w+)$/);
  if (range) {
    const a = dowName(range[1]);
    const b = dowName(range[2]);
    if (a && b) return `${a} to ${b}`;
    return null;
  }
  // Comma list like 1,3,5
  if (field.includes(",")) {
    const names = field.split(",").map((p) => dowName(p.trim()));
    if (names.every((n): n is string => n !== null)) {
      if (names.length === 1) return names[0];
      return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    }
    return null;
  }
  return dowName(field);
}

/**
 * Convert a standard 5-field cron expression into plain English.
 * Returns the raw expression (optionally suffixed with the timezone) for any
 * pattern not recognised, so the caller can always show *something* truthful.
 *
 * @param expr 5-field cron: "minute hour day-of-month month day-of-week"
 * @param tz   timezone label appended to time-of-day descriptions (default UTC)
 */
export function humanizeCron(expr: string | null | undefined, tz: string = "UTC"): string {
  const raw = (expr ?? "").trim();
  if (!raw) return "";

  const parts = raw.split(/\s+/);
  // Only handle the standard 5-field form. 6-field (with seconds) or anything
  // else falls back to raw.
  if (parts.length !== 5) return raw;

  const [min, hr, dom, mon, dow] = parts;
  const tzSuffix = tz ? ` ${tz}` : "";

  // Every minute.
  if (min === "*" && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return "Every minute";
  }

  // Every N minutes (*/N * * * *).
  const everyNMin = min.match(/^\*\/(\d+)$/);
  if (everyNMin && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = parseInt(everyNMin[1], 10);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }

  // Every N hours at minute M (M */N * * *).
  const everyNHour = hr.match(/^\*\/(\d+)$/);
  if (/^\d+$/.test(min) && everyNHour && dom === "*" && mon === "*" && dow === "*") {
    const n = parseInt(everyNHour[1], 10);
    const m = parseInt(min, 10);
    const at = m === 0 ? "" : ` at :${pad2(m)}`;
    return n === 1 ? `Every hour${at}` : `Every ${n} hours${at}`;
  }

  // Hourly at minute M (M * * * *).
  if (/^\d+$/.test(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    const m = parseInt(min, 10);
    return m === 0 ? "Every hour" : `Every hour at :${pad2(m)}`;
  }

  // Beyond here we need a concrete minute + hour to describe a time of day.
  const hasTime = /^\d+$/.test(min) && /^\d+$/.test(hr);
  if (hasTime) {
    const m = parseInt(min, 10);
    const h = parseInt(hr, 10);
    const time = clockTime(h, m);

    // Weekday range/list (day-of-month + month are wildcards).
    if (dom === "*" && mon === "*" && dow !== "*") {
      // Common weekday range 1-5 → "Every weekday".
      if (dow === "1-5") return `Every weekday at ${time}${tzSuffix}`;
      const days = dowList(dow);
      if (days) return `Every ${days} at ${time}${tzSuffix}`;
    }

    // Monthly on a specific day (day-of-month set, dow wildcard).
    if (/^\d+$/.test(dom) && mon === "*" && dow === "*") {
      const d = parseInt(dom, 10);
      const ord = ordinal(d);
      return `Monthly on the ${ord} at ${time}${tzSuffix}`;
    }

    // Specific month + day (e.g. yearly).
    if (/^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === "*") {
      const d = parseInt(dom, 10);
      const monthIdx = parseInt(mon, 10) - 1;
      const monthName = MONTH_NAMES[monthIdx];
      if (monthName) return `Every year on ${monthName} ${d} at ${time}${tzSuffix}`;
    }

    // Daily (everything else wildcarded).
    if (dom === "*" && mon === "*" && dow === "*") {
      return `Every day at ${time}${tzSuffix}`;
    }
  }

  // Unrecognised / exotic — never lie, show the raw expression.
  return tz ? `${raw} ${tz}` : raw;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
