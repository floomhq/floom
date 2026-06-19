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
