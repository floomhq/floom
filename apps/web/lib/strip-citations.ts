// G5 rescore4 P2 (2026-05-29): OpenAI Responses-API web_search emits inline
// citation markers that leak into worker output text and render as garbage in
// the Output tab (e.g. `citeturn0search9turn0news12`).
//
// The markers are wrapped in Unicode Private-Use-Area delimiters: an opening
// U+E200, a closing U+E201, and U+E202 separating segments. The payload looks
// like `citeturn0search9turn0news12`, where each `turn...` is one cited source.
// Older / unwrapped variants emit the bare `cite...turn...` token with no PUA
// delimiters at all.
//
// Stripping at the renderer covers ALL workers' outputs (run-detail Output, the
// workspace chat reply, the .md download) without re-running historical runs.

// PUA delimiters OpenAI uses for these markers. We strip the whole
// U+E000..U+F8FF BMP Private Use Area to be safe -- no legitimate worker output
// uses private-use codepoints.
const PUA_RANGE = /[-]/g;

// PUA-wrapped citation block: <PUA>cite...<PUA closer>. Match from the opening
// delimiter (optional, in case it was already stripped) through the `cite`
// token and its payload up to the next PUA delimiter.
const PUA_WRAPPED_CITATION = /[-]?cite[^-]*[-]/g;

// Bare citation token with no PUA wrapper:
//   citeturn0search9
//   citeturn0search9turn0news12
//   cite turn0search9
const BARE_CITATION = /\bcite(?:\s*turn\d+\w*)+/gi;

/**
 * Remove OpenAI web_search citation markers from worker output text.
 * Idempotent and safe to run on any markdown/plain-text string.
 */
export function stripCitationTokens(input: string): string {
  if (!input || typeof input !== "string") return input ?? "";
  let out = input;
  // 1. PUA-wrapped citation blocks (the common case).
  out = out.replace(PUA_WRAPPED_CITATION, "");
  // 2. Bare `cite...turn...` tokens that slipped through without PUA wrapping.
  out = out.replace(BARE_CITATION, "");
  // 3. Any remaining stray Private-Use-Area characters (orphan delimiters).
  out = out.replace(PUA_RANGE, "");
  // 4. Tidy the whitespace/punctuation a removed inline token leaves behind
  //    (e.g. "the report  ." -> "the report.").
  out = out.replace(/[ \t]{2,}/g, " ").replace(/ ([.,;:!?])/g, "$1");
  return out;
}
