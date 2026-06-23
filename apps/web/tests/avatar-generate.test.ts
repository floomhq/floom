import { describe, it, expect } from "vitest";
import {
  markHash,
  generateMark,
  generateMarkForRole,
  namespacedSeed,
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

// ---------------------------------------------------------------------------
// Role-based index offsets — generateMarkForRole must NEVER produce the same
// motifIndex for the same seed across different roles (mathematically guaranteed
// because every non-user offset is coprime to MARK_MOTIF_COUNT=6).
//
// Live bug: "Federico De Ponte" user and "Nova Search" workspace both rendered
// the same blue cross because the seed was raw name only. After this fix, the
// role-based offset shifts the motif index so same-seed pairs never collide.
// ---------------------------------------------------------------------------

describe("generateMarkForRole — no collision across roles for same seed", () => {
  it("user and workspace with the SAME name always produce DIFFERENT motifIndex", () => {
    // Mathematical guarantee: workspace offset=3 is coprime to 6, so
    // (h%6 + 3) % 6 can never equal h%6 for any h.
    const seeds = ["Federico De Ponte", "Acme Corp", "Nova Search", "a", "test", "x"];
    for (const seed of seeds) {
      const user = generateMarkForRole("user", seed);
      const workspace = generateMarkForRole("workspace", seed);
      expect(user.motifIndex).not.toBe(workspace.motifIndex);
    }
  });

  it("user and workspace with the SAME name always produce DIFFERENT motif+tone combined", () => {
    const user = generateMarkForRole("user", "Federico De Ponte");
    const workspace = generateMarkForRole("workspace", "Federico De Ponte");
    const identical = user.motifIndex === workspace.motifIndex && user.c1 === workspace.c1 && user.c2 === workspace.c2;
    expect(identical).toBe(false);
  });

  it("user and workspace with the SAME name differ — reported live-bug pair", () => {
    // Original collision: "Federico De Ponte" user and "Nova Search" workspace.
    const user = generateMarkForRole("user", "Federico De Ponte");
    const workspace = generateMarkForRole("workspace", "Nova Search");
    const identical = user.motifIndex === workspace.motifIndex && user.c1 === workspace.c1 && user.c2 === workspace.c2;
    expect(identical).toBe(false);
  });

  it("same (role, id) is stable across calls — marks survive renames when id is stable", () => {
    const a = generateMarkForRole("user", "user-uuid-abc123");
    const b = generateMarkForRole("user", "user-uuid-abc123");
    expect(a).toEqual(b);

    const c = generateMarkForRole("workspace", "ws-uuid-xyz789");
    const d = generateMarkForRole("workspace", "ws-uuid-xyz789");
    expect(c).toEqual(d);
  });

  it("worker role does not collide with workspace of same name", () => {
    const seeds = ["Acme Corp", "Nova Search", "test"];
    for (const seed of seeds) {
      const workspace = generateMarkForRole("workspace", seed);
      const worker = generateMarkForRole("worker", seed);
      // worker offset=1 (coprime to 6), workspace offset=3 — they differ from each other too.
      expect(worker.motifIndex).not.toBe(workspace.motifIndex);
    }
  });

  it("namespacedSeed helper (legacy) prefixes the role", () => {
    expect(namespacedSeed("user", "Nova Search")).toBe("user:Nova Search");
    expect(namespacedSeed("workspace", "Nova Search")).toBe("workspace:Nova Search");
  });
});
