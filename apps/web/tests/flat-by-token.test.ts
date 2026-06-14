import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const overviewSrc = readFileSync(
  resolve(__dirname, "../components/overview/OverviewDashboard.tsx"),
  "utf8"
);

// Design-system foundation: boxes/cards/menus/inputs/list rows use background
// surfaces, spacing, and shadows for separation. Visual border utilities and
// circular radii are blocked by the style guard and these source assertions.

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

describe("design-system foundation tokens are declared", () => {
  it("declares one concrete radius token", () => {
    expect(/--radius-ui:\s*3px/.test(css)).toBe(true);
    expect(css).not.toContain("--radius-pill:");
    expect(css).not.toContain("--r-pill:");
  });

  it("keeps divider token separate from surface borders", () => {
    expect(css.includes("--bd-div:")).toBe(true);
    expect(/--bd-card:\s*none/.test(css)).toBe(true);
    expect(/--bd-input:\s*none/.test(css)).toBe(true);
    expect(/--bd-list:\s*none/.test(css)).toBe(true);
  });
});

describe("collection surfaces are flat by token (rule #2)", () => {
  it(".c-gcard has no visual border and no resting shadow, min-height 148", () => {
    const r = rule(".c-gcard");
    expect(r).not.toMatch(/\bborder:/);
    expect(r).toContain("box-shadow:none");
    expect(r).toContain("min-height:148px");
    expect(r).toContain("border-radius:var(--radius-ui)");
  });

  it(".c-gcard hover is a bg lift, not a border", () => {
    const r = rule(".c-gcard:hover");
    expect(r).toContain("background:var(--bg-2)");
    expect(r).not.toContain("border");
  });

  it(".c-ltable has no outer container border or shadow (§3)", () => {
    const r = rule(".c-ltable");
    expect(r).not.toMatch(/\bborder:/);
    expect(r).toContain("box-shadow:none");
  });

  it(".c-lrow / .c-lhead use fill and spacing, not borders", () => {
    expect(rule(".c-lrow")).not.toContain("border");
    expect(rule(".c-lhead")).not.toContain("border");
  });

  it(".c-srch uses bg-2 fill and no border", () => {
    const r = rule(".c-srch");
    expect(r).not.toMatch(/\bborder:/);
    expect(r).toContain("background:var(--bg-2)");
  });

  it(".c-vtog uses bg-2 fill and no border", () => {
    const r = rule(".c-vtog");
    expect(r).not.toMatch(/\bborder:/);
    expect(r).toContain("background:var(--bg-2)");
  });

  it(".c-tag uses bg-2 fill and no border", () => {
    const r = rule(".c-tag");
    expect(r).not.toMatch(/\bborder:/);
    expect(r).toContain("background:var(--bg-2)");
  });

  it(".c-vpill uses bg-2 fill and no border", () => {
    const r = rule(".c-vpill");
    expect(r).not.toMatch(/\bborder:/);
    expect(r).toContain("background:var(--bg-2)");
  });
});

// Phase 2: Primitive component source assertions (regression guards).
// These tests scan the component TSX files rather than compiled CSS because
// the primitives ship className strings (Tailwind), not static rulesets.

describe("Phase 2 — Button primitive (v4 flat, APP-UI-V4-SPEC §1)", () => {
  it("uses no visual border utility and keeps one radius token", () => {
    expect(button).not.toContain("[border:var(--bd-btn)]");
    expect(button).toContain("rounded-[var(--radius-ui)]");
    expect(/\bborder\s+border-(?!transparent|ring|destructive)/.test(button)).toBe(false);
    expect(button).not.toContain("rounded-full");
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
  it("uses no visual border utility and keeps one radius token", () => {
    expect(card).not.toContain("[border:var(--bd-card)]");
    expect(card).toContain("rounded-[var(--radius-ui)]");
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
  it("uses no visual border utility", () => {
    expect(input).not.toContain("[border:var(--bd-input)]");
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

  it("uses --radius-ui, not per-component radius aliases", () => {
    expect(input).toContain("rounded-[var(--radius-ui)]");
    expect(input).not.toContain("rounded-[var(--radius-input)]");
    expect(input).not.toContain("rounded-[var(--radius-button)]");
  });
});

describe("Phase 2 — Select trigger (v4 flat, APP-UI-V4-SPEC §1)", () => {
  it("uses no visual border utility", () => {
    expect(select).not.toContain("[border:var(--bd-input)]");
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

  it("uses --radius-ui for trigger radius", () => {
    expect(select).toContain("rounded-[var(--radius-ui)]");
    expect(select).not.toContain("rounded-[var(--radius-input)]");
  });
});

describe("Phase 2 — Textarea primitive (v4 flat, APP-UI-V4-SPEC §1)", () => {
  it("uses no visual border utility", () => {
    expect(textarea).not.toContain("[border:var(--bd-input)]");
    expect(textarea).not.toContain("border border-input");
  });

  it("fill is --bg-2, not bg-transparent", () => {
    expect(textarea).toContain("bg-[var(--bg-2)]");
    expect(textarea).not.toContain("bg-transparent");
  });
});

describe("P5 — OverviewDashboard metric tiles use bg surfaces", () => {
  it("cardClass has no card border token or hardcoded border-default", () => {
    expect(overviewSrc).not.toContain("[border:var(--bd-card)]");
    expect(overviewSrc).not.toContain("border border-[var(--border-default)]");
    expect(overviewSrc).toContain("bg-[var(--bg-card)]");
  });

  it("metric tile hover uses bg lift, not border-strong", () => {
    // Hover must be a bg change, not a border-color change (spec §4 tiles)
    expect(overviewSrc).not.toContain("hover:border-[var(--border-strong)]");
    expect(overviewSrc).toContain("hover:bg-[var(--bg-2)]");
  });

  it("metric tile grid has 2 cols at mobile (spec §5c: 2×2 tiles)", () => {
    // Must not default to 1-col at small screens (grid-cols-1 md:grid-cols-2)
    expect(overviewSrc).not.toContain("grid-cols-1 gap-3 md:grid-cols-2");
    expect(overviewSrc).toContain("grid-cols-2");
  });
});
