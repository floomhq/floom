import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// a11y #1712/#1713: the muted / status / link text tokens must clear WCAG AA
// (>=4.5:1) against the light app surfaces. This test reads the LIGHT :root hex
// tokens straight out of globals.css and recomputes the ratio, so a future edit
// that lightens any of them back below AA fails here.

const CSS = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

/** Read the first hex value assigned to a CSS custom property in :root. */
function tokenHex(name: string): string {
  const re = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`);
  const m = CSS.match(re);
  if (!m) throw new Error(`token --${name} hex not found in globals.css`);
  return m[1];
}

function srgbToLin(c: number): number {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function hex(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}
function lum([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function ratio(fg: string, bg: string): number {
  const a = lum(hex(fg)),
    b = lum(hex(bg));
  const hi = Math.max(a, b),
    lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

// Light surfaces text sits on: --bg-app and --bg-2.
const BG_APP = "#FBFBFC";
const BG_2 = "#F2F3F5";
const AA = 4.5;

describe("a11y contrast — light muted/status/link tokens clear WCAG AA (#1712/#1713)", () => {
  it.each([
    ["ink-mute"],
    ["ink-faint"],
    ["muted-text"],
    ["success"],
    ["info"],
    ["accent"],
  ])("--%s is >= 4.5:1 on both light surfaces", (token) => {
    const value = tokenHex(token);
    const onApp = ratio(value, BG_APP);
    const onBg2 = ratio(value, BG_2);
    expect(onApp, `--${token} (${value}) on ${BG_APP}`).toBeGreaterThanOrEqual(AA);
    expect(onBg2, `--${token} (${value}) on ${BG_2}`).toBeGreaterThanOrEqual(AA);
  });

  it("white text on --accent stays >= 4.5:1 (accent is also a fill)", () => {
    expect(ratio("#FFFFFF", tokenHex("accent"))).toBeGreaterThanOrEqual(AA);
  });
});
