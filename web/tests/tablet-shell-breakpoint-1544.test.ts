import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// #1544 — tablet (768–1023) must NOT get the docked 3-column desktop shell.
//
// At 768px the desktop shell is sidebar (~228px) + content + Emily dock (~330px),
// which crushed the middle pane to ~210px so worker cards rendered behind the
// always-open dock and the page header collided. The fix raises the shell's
// desktop boundary from 768px to 1024px (Tailwind `lg`): the JS hook
// (useIsDesktop) and the CSS shell coupling (sidebar `lg:flex`/`lg:hidden`, body
// `lg:flex-row`, Emily dock widths, the floating alerts bell) all flip at `lg` so
// tablet uses the mobile shell (full-width content + drawer + Ask-Emily FAB) and
// true desktop (≥1024) is unchanged.

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}

describe("#1544 tablet shell breakpoint = 1024 (lg), not 768 (md)", () => {
  it("useIsDesktop matchMedia query is min-width: 1024px", () => {
    const src = read("lib/use-is-desktop.ts");
    expect(src).toContain("(min-width: 1024px)");
    expect(src).not.toContain("(min-width: 768px)");
  });

  it("body flex-row coupling uses lg, not md", () => {
    const src = read("app/layout.tsx");
    expect(src).toContain("lg:flex-row");
    expect(src).not.toContain("md:flex-row");
  });

  it("sidebar desktop aside + mobile chrome use lg, not md", () => {
    const src = read("components/layout/sidebar.tsx");
    // Desktop aside shows at lg, mobile header + drawer hide at lg.
    expect(src).toContain("lg:flex");
    expect(src).toContain("lg:hidden");
    // No shell-level md coupling should remain.
    expect(src).not.toContain("md:flex");
    expect(src).not.toContain("md:hidden");
  });

  it("Emily dock fixed widths key off lg, not md", () => {
    const src = read("components/emily/EmilyChat.tsx");
    expect(src).toContain("lg:w-[330px]");
    expect(src).toContain("lg:w-[560px]");
    expect(src).not.toContain("md:w-[330px]");
    expect(src).not.toContain("md:w-[560px]");
  });

  it("floating desktop alerts bell shows at lg, not md", () => {
    const src = read("components/layout/AppShell.tsx");
    expect(src).toContain("lg:block");
    expect(src).not.toContain("md:block");
  });
});
