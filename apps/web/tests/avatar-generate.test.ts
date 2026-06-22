import { describe, it, expect } from "vitest";
import {
  markHash,
  generateMark,
  MARK_PAIRS,
  MARK_GROUND,
  MARK_MOTIF_COUNT,
} from "@/lib/avatar/generate";

// SSR-safe pure-function tests for the locked identity-mark generator.
// SPEC: workeros-design-baseline/SPEC.md.

describe("markHash", () => {
  it("returns a non-negative integer", () => {
    expect(markHash("Nova Search")).toBeGreaterThanOrEqual(0);
    expect(markHash("")).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(markHash("test"))).toBe(true);
  });

  it("is deterministic — same seed always yields same hash", () => {
    for (const s of ["Nova Search", "Federico", "Emily", "Acme", "a", ""]) {
      expect(markHash(s)).toBe(markHash(s));
    }
  });

  it("differs for different seeds", () => {
    expect(
      new Set([markHash("Nova Search"), markHash("Acme Corp"), markHash("Beacon")]).size,
    ).toBe(3);
  });
});

describe("generateMark", () => {
  it("is deterministic — same seed, same motif + tones", () => {
    for (const s of ["Nova Search", "Federico", "Acme"]) {
      expect(generateMark(s)).toEqual(generateMark(s));
    }
  });

  it("selects a valid motif index and a real tone pair from MARK_PAIRS", () => {
    for (const s of ["a", "b", "workspace", "user@example.com", "Northwind"]) {
      const m = generateMark(s);
      expect(m.motifIndex).toBeGreaterThanOrEqual(0);
      expect(m.motifIndex).toBeLessThan(MARK_MOTIF_COUNT);
      expect(MARK_PAIRS.some(([c1, c2]) => c1 === m.c1 && c2 === m.c2)).toBe(true);
    }
  });
});

describe("palette constraints (restrained cool palette, no rainbow)", () => {
  it("ground is the neutral token value", () => {
    expect(MARK_GROUND).toBe("#F3F4F6");
  });

  it("has 5 two-tone pairs, every tone a 6-digit hex", () => {
    expect(MARK_PAIRS).toHaveLength(5);
    for (const pair of MARK_PAIRS) {
      expect(pair).toHaveLength(2);
      for (const c of pair) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("every tone is a cool blue (blue channel dominates red)", () => {
    for (const pair of MARK_PAIRS) {
      for (const c of pair) {
        const r = parseInt(c.slice(1, 3), 16);
        const b = parseInt(c.slice(5, 7), 16);
        expect(b).toBeGreaterThan(r);
      }
    }
  });
});
