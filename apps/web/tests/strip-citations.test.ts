/**
 * G5 rescore4 P2 — citation-token stripper contract test.
 *
 * No test runner is configured in apps/web; this file is a self-checking module
 * (same convention as worker-form-shared-components.test.ts). It typechecks via
 * `npm run build` and can be executed directly with:
 *   npx tsx tests/strip-citations.test.ts
 *
 * Protects the regex against regressions on the real OpenAI web_search token
 * format (PUA-wrapped `cite … turn0search9 …`) and against false positives on
 * legitimate words ("cite", "excited").
 */
import { stripCitationTokens } from "@/lib/strip-citations";

// PUA delimiters OpenAI uses: U+E200 (open), U+E201 (close), U+E202 (separator).
const O = "";
const C = "";
const S = "";

const cases: Array<[string, string]> = [
  // Real stored format: <open>cite<sep>turn0search3<close>
  [`uted systems. ${O}cite${S}turn0search3${C}\n\nAdoption`, "uted systems.\n\nAdoption"],
  // Multi-source wrapped block
  [`A ${O}cite${S}turn0search9${S}turn0news12${C} grew.`, "A grew."],
  // Bare (no PUA) variant
  ["The market grew citeturn0search9turn0news12 last quarter.", "The market grew last quarter."],
  // Single source, wrapped
  [`Revenue rose ${O}cite${S}turn0search9${C} sharply.`, "Revenue rose sharply."],
  // List item
  [`- Item one ${O}cite${S}turn0news5${C}\n- Item two`, "- Item one\n- Item two"],
  // Plain text unchanged
  ["Plain markdown **bold** text.", "Plain markdown **bold** text."],
  // False-positive guards: real words containing "cite" must survive
  ["We will cite the source clearly.", "We will cite the source clearly."],
  ["This is excited and noisy.", "This is excited and noisy."],
  [`This is excited and ${O}cite${S}turn0search0${C} noisy.`, "This is excited and noisy."],
  // Empty
  ["", ""],
];

export function runStripCitationTests(): void {
  for (const [input, expected] of cases) {
    const got = stripCitationTokens(input);
    if (got !== expected) {
      throw new Error(
        `stripCitationTokens mismatch\n  in : ${JSON.stringify(input)}\n  exp: ${JSON.stringify(expected)}\n  got: ${JSON.stringify(got)}`,
      );
    }
  }
}

// Execute when run directly (tsx/node), no-op when merely imported/typechecked.
if (typeof require !== "undefined" && require.main === module) {
  runStripCitationTests();
  console.log(`stripCitationTokens: ${cases.length}/${cases.length} passed`);
}
