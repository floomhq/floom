import { describe, it, expect } from "vitest";
import { genAvatarHash, GENERATIVE_AVATAR_PALETTES } from "@/components/GenerativeAvatar";

// Unit tests for the generative avatar algorithm (SSR-safe pure functions).
// The React component is an SVG renderer; we test the deterministic internals here.

describe("genAvatarHash", () => {
  it("returns a non-negative integer", () => {
    expect(genAvatarHash("Nova Search")).toBeGreaterThanOrEqual(0);
    expect(genAvatarHash("")).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(genAvatarHash("test"))).toBe(true);
  });

  it("is deterministic — same seed always yields same hash", () => {
    const seeds = ["Nova Search", "Federico De Ponte", "Emily", "Workspace", "a", ""];
    for (const s of seeds) {
      expect(genAvatarHash(s)).toBe(genAvatarHash(s));
    }
  });

  it("produces different hashes for different seeds", () => {
    const h1 = genAvatarHash("Nova Search");
    const h2 = genAvatarHash("Acme Corp");
    const h3 = genAvatarHash("Emily");
    // Not guaranteed by the algorithm but holds for these specific seeds.
    expect(new Set([h1, h2, h3]).size).toBe(3);
  });

  it("matches the reference gensys.html algorithm for known seeds", () => {
    // Computed externally from the JS algorithm in gensys.html.
    // hash("Emily"): h starts at 0
    //   E: (0<<5)-0+69 = 69
    //   m: (69<<5)-69+109 = 2208-69+109 = 2248
    //   i: (2248<<5)-2248+105 = 71936-2248+105 = 69793
    //   l: (69793<<5)-69793+108 = 2233376-69793+108 = 2163691
    //   y: (2163691<<5)-2163691+121 = 69238112-2163691+121 = 67074542
    // abs(67074542) = 67074542
    expect(genAvatarHash("Emily")).toBe(67074542);
  });
});

describe("GENERATIVE_AVATAR_PALETTES", () => {
  it("has 6 palettes each with 3 colors", () => {
    expect(GENERATIVE_AVATAR_PALETTES).toHaveLength(6);
    for (const pal of GENERATIVE_AVATAR_PALETTES) {
      expect(pal).toHaveLength(3);
      for (const color of pal) {
        expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it("Emily uses palette index 67074542 % 6 = index matching palette 4", () => {
    // palette 4 is ["#3E6FE0","#9333EA","#06B6D4"]
    // When pinned palette is supplied, this palette is NOT used for Emily
    // (the EmilyAvatar passes palette=["#3E6FE0","#22D3EE","#6D5DF6"] explicitly).
    // Here we confirm the seed-derived palette index for sanity.
    const h = genAvatarHash("Emily");
    const idx = h % GENERATIVE_AVATAR_PALETTES.length;
    expect(idx).toBe(67074542 % 6); // 2
  });
});

describe("GenerativeAvatar determinism (structural)", () => {
  it("genAvatarHash(seed+i) is deterministic for ellipse derivation", () => {
    const seed = "Nova Search";
    for (let i = 0; i < 3; i++) {
      const hx1 = genAvatarHash(seed + i);
      const hx2 = genAvatarHash(seed + i);
      expect(hx1).toBe(hx2);
      // Ellipse params are fully derived from hx, so same hx = same ellipse.
      const cx1 = ((hx1 % 100) / 100) * 100;
      const cy1 = (((hx1 >> 7) % 100) / 100) * 100;
      expect(cx1).toBe(((hx2 % 100) / 100) * 100);
      expect(cy1).toBe(((hx2 >> 7) % 100) / 100 * 100);
    }
  });
});
