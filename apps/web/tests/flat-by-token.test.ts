import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Emily-home redesign (2026-06-19): the old OverviewDashboard was replaced by
// the Emily-fullscreen HOME. The home is now the EXISTING Emily shown FULLSCREEN
// (EmilyChat); its empty-state "stuff" (greeting + pulse + pills) lives in
// EmilyHomeEmpty. The flat-by-token guard now covers EmilyHomeEmpty.
const overviewSrc = readFileSync(
  resolve(__dirname, "../components/home/EmilyHomeEmpty.tsx"),
  "utf8"
);

// APP-UI-V4-SPEC rule #2: "Flat by token, never by component." All collection
// surface borders come from the --bd-* CSS variables; a hardcoded
// `border: 1px solid` on a collection surface is a review-blocker (this exact
// bug shipped twice during design). These assertions are the regression guard.

const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");

// Phase 2: shadcn primitive source files (Button/Card/Input/Select).
// We read each file and assert the v4 flat rules hold.
const button = readFileSync(resolve(__dirname, "../components/ui/button.tsx"), "utf8");
const card   = readFileSync(resolve(__dirname, "../components/ui/card.tsx"), "utf8");
const input  = readFileSync(resolve(__dirname, "../components/ui/input.tsx"), "utf8");
const select = readFileSync(resolve(__dirname, "../components/ui/select.tsx"), "utf8");
const textarea = readFileSync(resolve(__dirname, "../components/ui/textarea.tsx"), "utf8");

function rule(selector: string): string {
  // grab the declaration block for a single-line rule `.sel { ... }`
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`
  );
  const m = css.match(re);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1];
}

describe("v4 border tokens are declared (§1)", () => {
  for (const token of [
    "--bd-card:",
    "--bd-pill:",
    "--bd-input:",
    "--bd-list:",
    "--bd-div:",
    "--bd-btn:",
  ]) {
    it(`declares ${token}`, () => {
      expect(css.includes(token)).toBe(true);
    });
  }

  it("--bd-card / --bd-list / --bd-btn are none", () => {
    expect(/--bd-card:\s*none/.test(css)).toBe(true);
    expect(/--bd-list:\s*none/.test(css)).toBe(true);
    expect(/--bd-btn:\s*none/.test(css)).toBe(true);
  });
});

describe("collection surfaces are flat by token (rule #2)", () => {
  it(".c-gcard has no hardcoded border and no resting shadow, min-height 148", () => {
    const r = rule(".c-gcard");
    expect(r).toContain("border:var(--bd-card)");
    expect(/border:\s*1px solid/.test(r)).toBe(false);
    expect(r).toContain("box-shadow:none");
    expect(r).toContain("min-height:148px");
  });

  it(".c-gcard hover is a bg lift, not a border", () => {
    const r = rule(".c-gcard:hover");
    expect(r).toContain("background:var(--bg-2)");
    expect(r.includes("border-color")).toBe(false);
  });

  it(".c-ltable has no outer container border or shadow (§3)", () => {
    const r = rule(".c-ltable");
    expect(r).toContain("border:var(--bd-list)");
    expect(/border:\s*1px solid/.test(r)).toBe(false);
    expect(r).toContain("box-shadow:none");
  });

  it(".c-lrow / .c-lhead dividers come from --bd-div", () => {
    expect(rule(".c-lrow")).toContain("border-bottom:var(--bd-div)");
    expect(rule(".c-lhead")).toContain("border-bottom:var(--bd-div)");
  });

  // Phase 1 additions: close the blind spots flagged in the migration plan.
  // These four classes had hardcoded `border: 1px solid var(--line)` pre-v4.

  it(".c-srch uses --bd-input token and bg-2 fill (no hardcoded border)", () => {
    const r = rule(".c-srch");
    expect(r).toContain("border:var(--bd-input)");
    expect(/border:\s*1px solid/.test(r)).toBe(false);
    expect(r).toContain("background:var(--bg-2)");
  });

  it(".c-vtog uses --bd-input token and bg-2 fill (no hardcoded border)", () => {
    const r = rule(".c-vtog");
    expect(r).toContain("border:var(--bd-input)");
    expect(/border:\s*1px solid/.test(r)).toBe(false);
    expect(r).toContain("background:var(--bg-2)");
  });

  it(".c-tag uses --bd-pill token and bg-2 fill (no hardcoded border)", () => {
    const r = rule(".c-tag");
    expect(r).toContain("border:var(--bd-pill)");
    expect(/border:\s*1px solid/.test(r)).toBe(false);
    expect(r).toContain("background:var(--bg-2)");
  });

  it(".c-vpill uses --bd-pill token and bg-2 fill (no hardcoded border)", () => {
    const r = rule(".c-vpill");
    expect(r).toContain("border:var(--bd-pill)");
    expect(/border:\s*1px solid/.test(r)).toBe(false);
    expect(r).toContain("background:var(--bg-2)");
  });
});

// Phase 2: Primitive component source assertions (regression guards).
// These tests scan the component TSX files rather than compiled CSS because
// the primitives ship className strings (Tailwind), not static rulesets.

describe("Phase 2 — Button primitive (v4 flat, APP-UI-V4-SPEC §1)", () => {
  it("uses [border:var(--bd-btn)] token, not a hardcoded border class", () => {
    expect(button).toContain("[border:var(--bd-btn)]");
    // No `border border-` shorthand that would override the token
    expect(/\bborder\s+border-(?!transparent|ring|destructive)/.test(button)).toBe(false);
  });

  it("has no resting shadow on any variant (shadow-none or absent shadow-btn in base)", () => {
    // Base class must include shadow-none so no variant re-adds one silently
    expect(button).toContain("shadow-none");
  });

  it("default variant has no border color class", () => {
    // Extract line starting with `default:` in the buttonVariants object.
    // We search for the quoted string value on the line after `default:`.
    const lines = button.split("\n");
    const defIdx = lines.findIndex((l) => /^\s+default:\s*$/.test(l) || /^\s+default:\s*["'`]/.test(l));
    const defLine = defIdx >= 0 ? lines.slice(defIdx, defIdx + 4).join(" ") : "";
    // Allow focus-visible ring references but not standalone border-[ color tokens
    expect(/\bborder-\[/.test(defLine)).toBe(false);
  });

  it("secondary and outline variants have no border classes", () => {
    const lines = button.split("\n");
    const secIdx = lines.findIndex((l) => /^\s+secondary:\s*["'`]/.test(l));
    const outIdx = lines.findIndex((l) => /^\s+outline:\s*["'`]/.test(l));
    const secLine = secIdx >= 0 ? lines.slice(secIdx, secIdx + 3).join(" ") : "";
    const outLine = outIdx >= 0 ? lines.slice(outIdx, outIdx + 3).join(" ") : "";
    // No hardcoded border- classes other than ring references
    expect(/\bborder-(?!ring)/.test(secLine)).toBe(false);
    expect(/\bborder-(?!ring)/.test(outLine)).toBe(false);
  });
});

describe("Phase 2 — Card primitive (v4 flat, APP-UI-V4-SPEC §1)", () => {
  it("uses [border:var(--bd-card)] token, not border-[var(--card-border)]", () => {
    expect(card).toContain("[border:var(--bd-card)]");
    expect(card).not.toContain("border border-[var(--card-border)]");
    expect(card).not.toContain("border border-[var(--card-border)");
  });

  it("has shadow-none (no resting shadow)", () => {
    expect(card).toContain("shadow-none");
    expect(card).not.toContain("shadow-[var(--card-shadow)]");
  });

  it("hover is a bg lift, not border or translate", () => {
    expect(card).toContain("hover:bg-[var(--bg-2)]");
    // No hover:-translate-y or hover:border- (that was the pre-v4 pattern)
    expect(card).not.toContain("hover:-translate-y");
    expect(card).not.toContain("hover:border-");
    expect(card).not.toContain("hover:shadow-");
  });

  it("no inline backdropFilter style (matte not glass)", () => {
    // The inline style with backdropFilter was removed in Phase 2
    expect(card).not.toContain("backdropFilter:");
    expect(card).not.toContain("WebkitBackdropFilter:");
  });
});

describe("Phase 2 — Input primitive (v4 flat, APP-UI-V4-SPEC §1)", () => {
  it("uses [border:var(--bd-input)] token, not border border-input", () => {
    expect(input).toContain("[border:var(--bd-input)]");
    expect(input).not.toContain("border border-input");
  });

  it("fill is --bg-2; root bg-transparent is gone (file:bg-transparent is allowed)", () => {
    expect(input).toContain("bg-[var(--bg-2)]");
    // The old pattern was `bg-transparent` as the BASE fill on the input element itself.
    // `file:bg-transparent` (for file-input button) is fine and stays.
    // Strip all `<modifier>:bg-transparent` occurrences, then assert no bare bg-transparent remains.
    const stripped = input.replace(/[a-z-]+:bg-transparent/g, "");
    expect(stripped.includes("bg-transparent")).toBe(false);
  });

  it("uses --radius-input, not --radius-button", () => {
    expect(input).toContain("rounded-[var(--radius-input)]");
    expect(input).not.toContain("rounded-[var(--radius-button)]");
  });
});

describe("Phase 2 — Select trigger (v4 flat, APP-UI-V4-SPEC §1)", () => {
  it("uses [border:var(--bd-input)] token, not border border-line-strong", () => {
    expect(select).toContain("[border:var(--bd-input)]");
    expect(select).not.toContain("border border-line-strong");
  });

  it("fill is --bg-2, not bg-paper", () => {
    // Trigger should use bg-[var(--bg-2)] not bg-paper
    expect(select).toContain("bg-[var(--bg-2)]");
    expect(select).not.toContain("bg-paper");
  });

  it("no resting shadow on trigger", () => {
    expect(select).not.toContain("shadow-sm");
  });

  it("uses --radius-input for trigger radius", () => {
    expect(select).toContain("rounded-[var(--radius-input)]");
  });
});

describe("Phase 2 — Textarea primitive (v4 flat, APP-UI-V4-SPEC §1)", () => {
  it("uses [border:var(--bd-input)] token, not border border-input", () => {
    expect(textarea).toContain("[border:var(--bd-input)]");
    expect(textarea).not.toContain("border border-input");
  });

  it("fill is --bg-2, not bg-transparent", () => {
    expect(textarea).toContain("bg-[var(--bg-2)]");
    expect(textarea).not.toContain("bg-transparent");
  });
});

// P5: the Emily-fullscreen HOME must be flat by token (spec rule #2). The
// composer-anchored home is borderless — surfaces are bg tokens + the accent
// focus ring, never hardcoded border colors.
describe("P5 — EmilyHomeEmpty is flat by token (spec rule #2)", () => {
  it("uses no hardcoded border-default / border-strong utilities", () => {
    expect(overviewSrc).not.toContain("border-[var(--border-default)]");
    expect(overviewSrc).not.toContain("border border-[var(--border-default)]");
  });

  it("uses no border-color hover (flat — hover is opacity/bg, never a border)", () => {
    expect(overviewSrc).not.toContain("hover:border-[var(--border-strong)]");
  });

  it("surfaces are bg tokens, not raw border utilities", () => {
    // The composer + pills sit on --bg-2 / --bg-3, no `border:` chrome.
    expect(overviewSrc).toContain("bg-[var(--bg-2)]");
  });
});
