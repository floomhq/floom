// G5 rescore4 P2 (2026-05-29): OpenAI Responses-API web_search emits inline
// citation markers that leak into worker output text and render as garbage in
// the Output tab. In the browser the Unicode Private-Use-Area delimiters render
// as zero-width, so a stored block like
//   citeturn0search9turn0news12
// collapses visually to `citeturn0search9turn0news12`.
//
// The block is: <PUA open> cite (<PUA> turnN...)* <PUA close>. Older / unwrapped
// variants emit the bare `citeturn0search9turn0news12` with no PUA delimiters.
//
// Stripping at the renderer covers ALL workers' outputs (run-detail Output, the
// workspace chat reply, the .md/.txt download) without re-running historical runs.

// The BMP Private Use Area (U+E000..U+F8FF). OpenAI uses U+E200..U+E202 for the
// citation delimiters; no legitimate worker output uses private-use codepoints.
const PUA = "[\\ue000-\\uf8ff]";

// A full citation block: optional opening PUA, the literal `cite`, then one or
// more `turn<n>...` source tokens (each optionally separated by a PUA delimiter
// or whitespace), and an optional closing PUA. The `(?:...turn...)+` requirement
// means a bare word like "cite" or "excited" is never matched.
const CITATION = new RegExp(`${PUA}?cite(?:(?:${PUA}|\\s)*turn\\d+\\w*)+${PUA}?`, "gi");

// Any stray Private-Use-Area characters left over (orphan delimiters).
const PUA_RANGE = new RegExp(PUA, "g");

/**
 * Remove OpenAI web_search citation markers from worker output text.
 * Idempotent and safe to run on any markdown/plain-text string.
 */
export function stripCitationTokens(input: string): string {
  if (!input || typeof input !== "string") return input ?? "";
  let out = input;
  // 1. Full citation blocks (PUA-wrapped and bare).
  out = out.replace(CITATION, "");
  // 2. Any remaining stray Private-Use-Area characters.
  out = out.replace(PUA_RANGE, "");
  // 3. Tidy the whitespace/punctuation a removed inline token leaves behind.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n");
  return out;
}

// ---------------------------------------------------------------------------
// Internal redaction placeholders (#1703). The backend secret scrubber
// (`scrub_secrets` / `_scrub`) replaces a worker secret's VALUE with a marker
// of the form `<REDACTED:SECRET_ENV_NAME>` (or a bare `<REDACTED>`). That marker
// is correct on the security side (the real value never leaks) but it must not
// render inside a user-facing deliverable: a candidate's title coming back as
// `<REDACTED:EXTERNAL_APIFY_PROFILE_SCRAPER_MODE> Stack Entwickler` looks broken
// and leaks an internal pipeline detail (the secret's env-var name).
//
// We strip these markers at display/export time so the deliverable reads
// cleanly without weakening the backend redaction. The token is replaced with
// nothing; surrounding whitespace/punctuation left behind is then tidied.
// ---------------------------------------------------------------------------
// Secret names allow mixed/lower case (manifest/MCP secrets permit [A-Za-z_]),
// so the marker name char-class must too — an uppercase-only class let
// `<REDACTED:apifyToken>` / `<REDACTED:my_key>` leak through (#1752).
const INTERNAL_PLACEHOLDER = /<REDACTED(?::[A-Za-z0-9_]+)?>/g;

/**
 * Remove internal `<REDACTED:NAME>` / `<REDACTED>` secret-scrubber markers from
 * user-facing output text. Idempotent and safe on any string.
 */
export function stripInternalPlaceholders(input: string): string {
  if (!input || typeof input !== "string") return input ?? "";
  const out = input.replace(INTERNAL_PLACEHOLDER, "");
  // Tidy whitespace/punctuation a removed token leaves behind, mirroring
  // stripCitationTokens so "Foo <REDACTED:X> Bar" -> "Foo Bar", not "Foo  Bar".
  // A leading token (common in shortlist titles like "<REDACTED:X> Stack ...")
  // leaves a leading space, so trim per-line leading whitespace introduced by
  // removal at the start of a line.
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    // Trim only leading whitespace at the very start (a leading token artifact);
    // do NOT touch per-line indentation so markdown lists/code blocks survive.
    .replace(/^[ \t]+/, "");
}

/**
 * Single display-time sanitizer for worker output text. Strips OpenAI citation
 * markers AND internal `<REDACTED:...>` secret-scrubber placeholders. Use this
 * everywhere worker output text (or its .md/.txt/.json export) reaches the user.
 * Idempotent.
 */
export function sanitizeOutputText(input: string): string {
  if (!input || typeof input !== "string") return input ?? "";
  return stripInternalPlaceholders(stripCitationTokens(input));
}

/**
 * Deep-walk a parsed JSON value and sanitize every string it contains. Used for
 * the JSON-output download path, where the value is re-serialised rather than
 * rendered through the text sanitizer. Returns a new structure; does not mutate.
 */
export function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeOutputText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeJsonValue(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeJsonValue(v);
    }
    return out as unknown as T;
  }
  return value;
}
