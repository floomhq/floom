import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// APP-UI-V4-SPEC rule #2: "Flat by token, never by component." All collection
// surface borders come from the --bd-* CSS variables; a hardcoded
// `border: 1px solid` on a collection surface is a review-blocker (this exact
// bug shipped twice during design). These assertions are the regression guard.

const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");

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
});
