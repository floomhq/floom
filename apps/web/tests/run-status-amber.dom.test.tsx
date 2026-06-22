import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { RunStatusBadge, RunStatusGlyph } from "@/components/RunStatus";
import { StackTrace } from "@/components/ai-elements/stack-trace";

// #1785 — the run-detail header Failed badge must render AMBER, never red.
// Floom DS: "red is NOT a Floom color." The Failed badge (StatusPill tone "err")
// and the status glyph (XCircle) both flow through the amber token chain
// (text-error -> --color-error -> --negative -> --warning #C98A1A). This locks
// the header surface the live audit flagged so the amber mapping cannot be
// silently reverted again.
describe("Run-detail Failed status color", () => {
  it("renders the Failed badge with the amber `err` tone, not a red tone", () => {
    const { container } = render(<RunStatusBadge status="failed" />);
    const pill = container.querySelector(".c-pill");
    expect(pill).toBeTruthy();
    // .c-pill.err is amber (color-mix of --warning); .dot inherits currentColor.
    expect(pill!.className).toContain("err");
    expect(pill!.textContent).toContain("Failed");
    expect(pill!.querySelector(".dot")).toBeTruthy();
  });

  it("colors the Failed status glyph with the amber error token, not red", () => {
    const { container } = render(<RunStatusGlyph status="failed" />);
    const glyph = container.querySelector("svg");
    expect(glyph).toBeTruthy();
    expect(glyph!.getAttribute("class")).toContain("text-error");
    expect(glyph!.getAttribute("class")).not.toMatch(/text-red/);
  });

  // #1785 (second flagged surface): the Output-tab error banner for a failed
  // run is <StackTrace>. Its tinted background and text must read the amber
  // error token (bg-error / text-error -> --color-error -> --negative ->
  // --warning), never a red/pink/rose treatment.
  it("renders the failed-run error banner amber, not red/pink", () => {
    const { container } = render(<StackTrace error={"boom\nat line 1"} />);
    const banner = container.firstElementChild as HTMLElement;
    expect(banner).toBeTruthy();
    // amber-tinted surface, not a red one.
    expect(banner.className).toContain("bg-error");
    expect(banner.className).not.toMatch(/bg-(red|rose|destructive)/);
    // "Error" header + the pre body both use the amber text token.
    const amberText = Array.from(container.querySelectorAll('[class*="text-error"]'));
    expect(amberText.length).toBeGreaterThanOrEqual(2);
    expect(banner.querySelector('[class*="text-red"]')).toBeNull();
    expect(banner.querySelector('[class*="#ffb4a8"]')).toBeNull();
  });
});
